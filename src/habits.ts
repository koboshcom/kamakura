import {createHash, randomUUID} from 'node:crypto';
import {scopeRepository} from './scope-storage.js';
import {namespace, hash} from './mongo.js';
import {config} from './config.js';
import {contextOwner} from './owner-context.js';
import {unsafeLesson} from './learning.js';
import type {IncomingMessage} from './types.js';
import {z} from 'zod';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const actionSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('list_local_devices')}).strict(),
 z.object({tool:z.literal('local_snapshot'),deviceId:z.string().uuid()}).strict()
]);
export type HabitAction=z.infer<typeof actionSchema>;
const sourceSchema=z.object({owner:z.string().max(80),channel:z.enum(['telegram','whatsapp','discord']),chat:z.string().max(200),message:z.string().max(200),at:z.number().int().positive(),episode:z.string().max(80)}).strict();
type Source=z.infer<typeof sourceSchema>;
const habitSchema=z.object({id:z.string().max(32),kind:z.enum(['pair','time']),x:actionSchema,y:actionSchema.optional(),zone:z.string().max(80).optional(),bucket:z.string().max(80).optional(),state:z.enum(['pending','active','disabled','removed']),evidence:z.array(sourceSchema).max(3),at:z.number(),used:z.array(z.object({key:z.string().max(80),at:z.number()}).strict()).max(32),offered:z.array(z.string().max(80)).max(32)}).strict();
export type Habit=z.infer<typeof habitSchema>;
const stateSchema=z.object({habits:z.array(habitSchema).max(16),recent:z.array(z.object({action:actionSchema,source:sourceSchema}).strict()).max(8),seen:z.array(z.string().max(80)).max(64)}).strict();
type State=z.infer<typeof stateSchema>;
interface Row {_id:string;ns:string;scope:string;envelope:{current:{revision:string;data:State}}}
export interface HabitCapture {owner:string;source:Source;text:string;zone?:string}
/** Capture directly from the authenticated adapter envelope, never from old history or a model summary. */
export function captureHabit(m:IncomingMessage,now=Date.now()):HabitCapture|undefined {
 const owner=contextOwner(m);
 if(!config.learning.enabled||!owner||!config.learning.owners.has(owner)||m.learningEligible!==true||m.isGroup||m.replyContext||m.media?.length)return;
 if(!m.id||m.id.length>200||!m.text||m.text.length>4000||unsafeLesson(m.text)||/^[ \t]*>|```|[“”«»]|https?:\/\/|\b(?:quoted|forwarded|tool output)\b/imu.test(m.text))return;
 if(!Number.isSafeInteger(m.timestamp)||m.timestamp<=0||now-m.timestamp>120000||m.timestamp>now+30000)return;
 const source:Source={owner,channel:m.transport,chat:m.chatId,message:m.id,at:m.timestamp,episode:digest([owner,Math.floor(m.timestamp/3600000)])};
 return {owner,source,text:m.text,zone:config.time.ownerTimeZones[owner]};
}
export function requestedAction(text:string,action:HabitAction):boolean {
 if(/\b(?:not|never|don't|do not|stop|avoid|cancel|instead)\b/i.test(text))return false;
 return action.tool==='local_snapshot'?/\b(?:screenshot|snapshot)\b/i.test(text):/\b(?:list|show)\b.{0,40}\b(?:devices|computers)\b/i.test(text);
}
function timeBucket(at:number,zone:string):string {
 const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(at);
 return p.filter(p=>p.type==='weekday'||p.type==='hour').map(p=>p.value).join('-');
}
export class HabitsStore {
 private repo=scopeRepository<Row>('lessons');private ns:string;
 constructor(dir:string,private limits={maxBytes:config.learning.maxBytes,maxHabits:Math.min(16,config.learning.maxLessons)}){this.ns=namespace(dir);}
 private id(owner:string){return this.ns+':'+hash(owner);}
 private async read(owner:string):Promise<State>{
  const r=await this.repo.get(this.id(owner));const data=r?stateSchema.parse(r.envelope.current.data):{habits:[],recent:[],seen:[]};
  if(Buffer.byteLength(JSON.stringify(data))>this.limits.maxBytes)throw new Error('Habit cap exceeded');
  if(data.recent.some(r=>r.source.owner!==owner)||data.habits.some(h=>h.evidence.some(e=>e.owner!==owner)))throw new Error('Habit owner mismatch');
  return data;
 }
 private async mutate<T>(owner:string,fn:(s:State)=>T):Promise<T>{
  const id=this.id(owner);await this.repo.initialize({_id:id,ns:this.ns,scope:hash(owner),envelope:{current:{revision:randomUUID(),data:{habits:[],recent:[],seen:[]}}}});
  for(let i=0;i<20;i++){
   const row=await this.repo.get(id);if(!row)throw new Error('Habit state unavailable');const data=stateSchema.parse(row.envelope.current.data);if(data.recent.some(r=>r.source.owner!==owner)||data.habits.some(h=>h.evidence.some(e=>e.owner!==owner)))throw new Error("Habit owner mismatch");const result=fn(data);
   stateSchema.parse(data);if(Buffer.byteLength(JSON.stringify(data))>this.limits.maxBytes)throw new Error('Habit cap exceeded');
   if(await this.repo.replace(id,row.envelope.current.revision,{...row,envelope:{current:{revision:randomUUID(),data}}}))return result;
  }throw new Error('Habit contention');
 }
 async list(owner:string){return structuredClone((await this.read(owner)).habits);}
 async control(owner:string,id:string,mode:'disabled'|'removed'){
  return this.mutate(owner,s=>{const h=s.habits.find(h=>h.id===id);if(!h)throw new Error('Habit not found');h.state=mode;h.at=Date.now();return {id,state:mode};});
 }
 /** Receipts reach this method only after an actual successful local executor call. No output/body is retained. */
 async success(c:HabitCapture,action:HabitAction){
  action=actionSchema.parse(action);if(!requestedAction(c.text,action))return;
  return this.mutate(c.owner,s=>{
   const key=digest([c.source.channel,c.source.chat,c.source.message,action]);if(s.seen.includes(key))return;
   s.seen=[...s.seen,key].slice(-64);
   const add=(kind:'pair'|'time',x:HabitAction,y?:HabitAction,zone?:string,bucket?:string)=>{
    const id=digest([kind,x,y??null,zone??null,bucket??null]);let h=s.habits.find(h=>h.id===id);
    if(h?.state==='disabled'||h?.state==='removed')return;
    if(!h){if(s.habits.length>=this.limits.maxHabits)return;h={id,kind,x,...(y?{y}:{}),...(zone?{zone,bucket}:{}),state:'pending',evidence:[],at:c.source.at,used:[],offered:[]};s.habits.push(h);}
    if(h.evidence.some(e=>e.episode===c.source.episode))return;
    h.evidence=[...h.evidence.filter(e=>c.source.at-e.at<30*86400000),c.source].slice(-3);h.at=c.source.at;
    if(h.evidence.length===3)h.state='active';
   };
   const previous=s.recent.at(-1);
   if(previous&&previous.source.owner===c.owner&&previous.source.at<c.source.at&&c.source.at-previous.source.at<=1200000&&previous.source.message!==c.source.message&&digest(previous.action)!==digest(action))add('pair',previous.action,action);
   if(c.zone)add('time',action,undefined,c.zone,timeBucket(c.source.at,c.zone));
   s.recent=[...s.recent.filter(r=>c.source.at-r.source.at<=1200000),{action,source:c.source}].slice(-8);
  });
 }
 async suppress(c:HabitCapture){
  if(!/\b(?:don't|do not|never|stop|disable|instead|correction|remove|forget|delete)\b/i.test(c.text)||!/\b(?:habits?|routines?|automatically|automatic|anymore|instead|correction)\b/i.test(c.text))return;
  const all=/\b(?:all|every)\b.{0,20}\b(?:habits|routines)\b/i.test(c.text);
  const text=c.text.replace(/\b(?:not|never|don't|do not|stop|avoid|cancel|instead)\b/gi,'');
  return this.mutate(c.owner,s=>{for(const h of s.habits){if(h.state==='removed')continue;
   if(all||c.text.includes(h.id)||requestedAction(text,h.y??h.x)){h.state=/\b(?:remove|forget|delete)\b/i.test(c.text)?'removed':'disabled';h.at=c.source.at;}
  }});
 }
 async allowed(owner:string,id:string){const h=(await this.read(owner)).habits.find(h=>h.id===id);return h?.state==='active'&&h.evidence.length===3;}
 async claim(c:HabitCapture,x:HabitAction):Promise<Habit|undefined>{
  return this.mutate(c.owner,s=>{
   const h=s.habits.find(h=>h.kind==='pair'&&h.state==='active'&&h.evidence.length===3&&c.source.at-h.at<30*86400000&&digest(h.x)===digest(x)&&h.y);
   if(!h)return;const key=digest([c.source.channel,c.source.chat,c.source.message,h.id]);
   h.used=h.used.filter(u=>c.source.at-u.at<=180000);if(h.used.some(u=>u.key===key)||h.used.length>=32)return;h.used.push({key,at:c.source.at});return structuredClone(h);
  });
 }
 async offers(c:HabitCapture){
  return this.mutate(c.owner,s=>{
   const found=s.habits.filter(h=>h.kind==='time'&&h.state==='active'&&h.zone===c.zone&&h.bucket===timeBucket(c.source.at,h.zone!)&&requestedAction(c.text,h.x)&&c.source.at-h.at<30*86400000);
   return found.filter(h=>{const key=digest([c.source.episode,h.id]);if(h.offered.includes(key))return false;h.offered=[...h.offered,key].slice(-32);return true;}).map(h=>({id:h.id,action:h.x,zone:h.zone,bucket:h.bucket,evidenceCount:h.evidence.length}));
  });
 }
}
