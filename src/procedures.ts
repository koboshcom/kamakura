import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {scopeRepository} from './scope-storage.js';
import {namespace,hash} from './mongo.js';
import {config} from './config.js';
import {unsafeLesson,supportedExcerpt} from './learning.js';
import type {HabitCapture,HabitAction} from './habits.js';
import {embedText,embeddingConfig,validatedVector,cosine,type StoredEmbedding,type EmbeddingConfig} from './embeddings.js';

export const memoryTypes={semantic:'facts and explicitly taught preferences',episodic:'verified interactions and execution receipts',procedural:'short reusable how-to steps from successful executions'} as const;
const DAY=86400000;
export const procedureLimits={notes:8,steps:4,topK:3,promptChars:1600,staleDays:60,dropDays:120,deprecateFailures:2,dropFailures:4,vectorBytes:1048576} as const;
const safeText=z.string().trim().min(1).max(180).refine(t=>!unsafeLesson(t)&&!/[\x00-\x1f`$;{}<>/\\]|https?:|(?:^|\s)--?\w|\b(?:sudo|curl|wget|chmod|chown|eval|exec|bash|powershell)\b/i.test(t),'Only short non-executable prose is allowed');
const stepSchema=z.object({tool:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/),note:safeText}).strict();
const embeddingSchema=z.object({profile:z.string().max(200),model:z.string().max(200),dimensions:z.number().int().min(1).max(8192),textHash:z.string().max(200),vector:z.array(z.number().finite()).max(8192)}).strict();
const provenanceSchema=z.object({owner:z.string().max(80),channel:z.enum(['telegram','whatsapp','discord']),chat:z.string().max(200),message:z.string().max(200),at:z.number(),episode:z.string().max(80)}).strict();
const noteSchema=z.object({id:z.string().regex(/^[a-f0-9]{24}$/),type:z.enum(['semantic','procedural']),title:safeText,steps:z.array(stepSchema).min(1).max(4),state:z.enum(['pending','active','deprecated','disabled','deleted']),reason:z.enum(['evidence','success','failure','inactive','owner']),evidence:z.array(provenanceSchema).max(3),created:z.number(),updated:z.number(),lastUsed:z.number(),failures:z.number().int().min(0).max(4),outcomes:z.array(z.string().max(80)).max(16),embedding:embeddingSchema.optional(),correction:provenanceSchema.optional()}).strict();
export type Procedure=z.infer<typeof noteSchema>;
const stateSchema=z.object({notes:z.array(noteSchema).max(8)}).strict();
interface Row {_id:string;ns:string;scope:string;envelope:{current:{revision:string;data:z.infer<typeof stateSchema>}}}
export type VectorPort={config:()=>EmbeddingConfig;embed:(text:string,c:EmbeddingConfig)=>Promise<StoredEmbedding>;validate:(e:StoredEmbedding|undefined,text:string,c:EmbeddingConfig)=>number[];score:(a:number[],b:number[])=>number};
const vectors:VectorPort={config:embeddingConfig,embed:embedText,validate:validatedVector,score:cosine};
const textOf=(p:Pick<Procedure,'title'|'steps'>)=>[p.title,...p.steps.map((s,i)=>String(i+1)+'. '+s.note)].join('\n');
const source=(c:HabitCapture)=>({owner:c.owner,channel:c.source.channel,chat:c.source.chat,message:c.source.message,at:c.source.at,episode:c.source.episode});
export type ProcedureOutcome='success'|'task-failure'|'transient'|'cancelled'|'approval'|'unknown';
/** Isolated existing lessons namespace. No legacy backfill or inferred provenance. */
export class ProceduresStore{
 private repo=scopeRepository<Row>('lessons');private ns:string;
 constructor(dir:string,private port:VectorPort=vectors,private clock:()=>number=Date.now){this.ns=namespace(dir);}
 private id(owner:string){return this.ns+':'+hash(owner);}
 private validate(owner:string,data:unknown){
  const s=stateSchema.parse(data);
  if(s.notes.some(n=>n.evidence.some(e=>e.owner!==owner)||n.correction&&n.correction.owner!==owner))throw new Error('Procedure owner mismatch');
  const notes=s.notes.map(({embedding,...n})=>n);
  if(Buffer.byteLength(JSON.stringify(notes))>config.learning.maxBytes||Buffer.byteLength(JSON.stringify(s))>procedureLimits.vectorBytes)throw new Error('Procedure storage cap exceeded');
  return s;
 }
 private async read(owner:string){const r=await this.repo.get(this.id(owner));return this.validate(owner,r?.envelope.current.data??{notes:[]});}
 private async mutate<T>(owner:string,fn:(s:z.infer<typeof stateSchema>)=>T){
  const id=this.id(owner);await this.repo.initialize({_id:id,ns:this.ns,scope:hash(owner),envelope:{current:{revision:randomUUID(),data:{notes:[]}}}});
  for(let i=0;i<20;i++){const r=await this.repo.get(id);if(!r)throw new Error('Procedure storage unavailable');const s=this.validate(owner,r.envelope.current.data);const result=fn(s);this.validate(owner,s);
   if(await this.repo.replace(id,r.envelope.current.revision,{...r,envelope:{current:{revision:randomUUID(),data:s}}}))return result;
  }throw new Error('Procedure contention');
 }
 private lifecycle(s:z.infer<typeof stateSchema>){
  for(const n of s.notes){
   if(n.state==='disabled'||n.state==='deleted')continue;
   const age=this.clock()-Math.max(n.lastUsed,n.updated);
   if(age>=procedureLimits.dropDays*DAY){n.state='deleted';n.reason='inactive';delete n.embedding;}
   else if(age>=procedureLimits.staleDays*DAY){n.state='deprecated';n.reason='inactive';}
  }
 }
 private enabled(owner:string){return config.learning.enabled&&config.learning.owners.has(owner);}
 async list(owner:string){
  if(!this.enabled(owner))return [];
  return this.mutate(owner,s=>{this.lifecycle(s);return s.notes.map(({embedding,outcomes,...n})=>structuredClone(n));});
 }
 /** Caller has a current direct-owner capability; every action must have an actual successful receipt. */
 async extract(c:HabitCapture,actions:{action:HabitAction;capture:HabitCapture}[]){
  if(!this.enabled(c.owner)||!actions.length)return;
  const rows=actions.slice(0,4);
  if(rows.some(r=>r.capture.owner!==c.owner||r.capture.source.message!==c.source.message||r.capture.source.chat!==c.source.chat||r.capture.source.channel!==c.source.channel||r.capture.source.receipt?.status!=='success'||r.capture.source.receipt.tool!==r.action.tool||r.capture.source.receipt.requested!==true))return;
  const steps=rows.map(r=>stepSchema.parse({tool:r.action.tool,note:r.action.intent}));
  const title=safeText.parse(steps[0]!.note),id=hash(JSON.stringify([title,steps])).slice(0,24);
  // Do not call an embedding provider for a tombstone or duplicate receipt.
  const existing=(await this.read(c.owner)).notes.find(n=>n.id===id);
  if(existing?.state==='disabled'||existing?.state==='deleted'||existing?.correction||existing?.evidence.some(e=>e.channel===c.source.channel&&e.chat===c.source.chat&&e.message===c.source.message))return id;
  const cfg=this.port.config(),embedding=await this.port.embed(textOf({title,steps}),cfg);
  this.port.validate(embedding,textOf({title,steps}),cfg);
  if(!this.enabled(c.owner))return;
  return this.mutate(c.owner,s=>{
   this.lifecycle(s);let n=s.notes.find(n=>n.id===id);
   if(n?.state==='disabled'||n?.state==='deleted'||n?.correction)return id;
   if(!n){if(s.notes.length>=8)return;n={id,type:'procedural',title,steps,state:'pending',reason:'evidence',evidence:[],created:this.clock(),updated:this.clock(),lastUsed:0,failures:0,outcomes:[]};s.notes.push(n);}
   if(!n.evidence.some(e=>e.episode===c.source.episode))n.evidence=[...n.evidence.filter(e=>this.clock()-e.at<30*DAY),source(c)].slice(-3);
   n.updated=this.clock();n.embedding=embedding;
   if(n.evidence.length===3&&n.failures===0){n.state='active';n.reason='success';}
   return id;
  });
 }

 /** Current explicit teaching only; no migration of old unprovenanced lessons. */
 async teach(c:HabitCapture,text:string){
  if(!this.enabled(c.owner)||!supportedExcerpt(c.text,text)||!(/\b(?:remember|learn|prefer|correction|correct|teach|means)\b/i.test(c.text)))return;
  text=safeText.parse(text);
  const id=hash(JSON.stringify(['semantic',text])).slice(0,24);
  const old=(await this.read(c.owner)).notes.find(n=>n.id===id);
  if(old)return id;
  const steps=[{tool:'owner_teaching',note:text}],cfg=this.port.config(),embedding=await this.port.embed(textOf({title:text,steps}),cfg);
  this.port.validate(embedding,textOf({title:text,steps}),cfg);if(!this.enabled(c.owner))return;
  return this.mutate(c.owner,s=>{if(s.notes.some(n=>n.id===id)||s.notes.length>=8)return id;
   s.notes.push({id,type:'semantic',title:text,steps,state:'active',reason:'owner',evidence:[source(c)],created:this.clock(),updated:this.clock(),lastUsed:0,failures:0,outcomes:[],embedding});
   return id;
  });
 }
 async retrieve(owner:string,query:string){
  if(!this.enabled(owner)||!query||query.length>4000)return [];
  await this.mutate(owner,s=>this.lifecycle(s));
  // Owner-filtered storage is selected BEFORE vector validation or cosine. No keyword/all-notes fallback.
  const candidates=(await this.read(owner)).notes.filter(n=>n.state==='active').slice(0,8);
  if(!candidates.length)return [];
  const cfg=this.port.config(),q=await this.port.embed(query,cfg);const queryVector=this.port.validate(q,query,cfg);
  const ranked=candidates.flatMap(n=>{
   try{const v=this.port.validate(n.embedding,textOf(n),cfg);const score=this.port.score(queryVector,v);return score>=cfg.minScore?[{n,score}]:[];}catch{return [];}
  }).sort((a,b)=>b.score-a.score||a.n.id.localeCompare(b.n.id)).slice(0,3);
  if(!this.enabled(owner))return [];
  let chars=0;return ranked.flatMap(({n})=>{const note={id:n.id,type:n.type,title:n.title,steps:n.steps};const len=JSON.stringify(note).length;
   if(chars+len>1600)return [];chars+=len;return [note];
  });
 }
 async control(c:HabitCapture,id:string,mode:'disabled'|'deleted'){
  if(!this.enabled(c.owner)||!c.text.includes(id)||!(/\b(?:procedure|workflow|how to)\b/i.test(c.text))||!(mode==='deleted'?/\b(?:delete|remove|forget)\b/i:/\b(?:disable|stop|never)\b/i).test(c.text))throw new Error('Exact direct-owner procedure control required');
  return this.mutate(c.owner,s=>{const n=s.notes.find(n=>n.id===id);if(!n)throw new Error('Unknown procedure');n.state=mode;n.reason='owner';n.updated=this.clock();delete n.embedding;return {id,state:mode};});
 }
 async correct(c:HabitCapture,id:string,title:string,steps:z.infer<typeof stepSchema>[]){
  if(!this.enabled(c.owner)||!c.text.includes(id)||!(/\b(?:correct|correction|update|instead)\b/i.test(c.text)))throw new Error('Exact targeted owner correction required');
  title=safeText.parse(title);steps=z.array(stepSchema).min(1).max(4).parse(steps);
  if(!supportedExcerpt(c.text,title)||steps.some(s=>!supportedExcerpt(c.text,s.note)))throw new Error('Correction must preserve whole owner sentences or lines');
  const old=(await this.read(c.owner)).notes.find(n=>n.id===id);
  if(!old||old.type!=='procedural'||old.state==='disabled'||old.state==='deleted')throw new Error('Unknown or tombstoned procedure');
  const cfg=this.port.config(),embedding=await this.port.embed(textOf({title,steps}),cfg);this.port.validate(embedding,textOf({title,steps}),cfg);
  if(!this.enabled(c.owner))throw new Error('Learning disabled');
  return this.mutate(c.owner,s=>{const n=s.notes.find(n=>n.id===id);if(!n||n.state==='disabled'||n.state==='deleted'||n.updated!==old.updated)throw new Error('Procedure changed');
   n.title=title;n.steps=steps;n.state='pending';n.reason='owner';n.evidence=[];n.failures=0;n.updated=this.clock();n.embedding=embedding;n.correction=source(c);return {id,state:n.state};
  });
 }
 async outcome(owner:string,id:string,invocation:string,revision:number,outcome:ProcedureOutcome){
  if(!this.enabled(owner)||!['success','task-failure'].includes(outcome))return;
  return this.mutate(owner,s=>{const n=s.notes.find(n=>n.id===id);if(!n||n.type!=='procedural'||n.state==='disabled'||n.state==='deleted'||n.updated!==revision||n.outcomes.includes(invocation))return;
   n.outcomes=[...n.outcomes,invocation].slice(-16);n.lastUsed=this.clock();
   if(outcome==='success'){n.failures=0;return;}
   n.failures=Math.min(4,n.failures+1);
   if(n.failures>=4){n.state='deleted';n.reason='failure';delete n.embedding;}
   else if(n.failures>=2){n.state='deprecated';n.reason='failure';}
  });
 }
 /** A verified success of EACH current corrected step revalidates the targeted note, not permission. */
 async revalidate(c:HabitCapture,id:string,actions:{action:HabitAction;capture:HabitCapture}[]){
  if(!this.enabled(c.owner))return;
  return this.mutate(c.owner,s=>{const n=s.notes.find(n=>n.id===id);if(!n||n.state==='disabled'||n.state==='deleted'||!n.correction||actions.length!==n.steps.length)return;
   if(actions.some((r,i)=>r.capture.owner!==c.owner||r.capture.source.message!==c.source.message||r.capture.source.channel!==c.source.channel||r.capture.source.chat!==c.source.chat||r.capture.source.receipt?.status!=='success'||r.capture.source.receipt.requested!==true||r.capture.source.receipt.tool!==n.steps[i]!.tool||r.action.tool!==n.steps[i]!.tool||r.action.intent!==n.steps[i]!.note))return;
   if(!n.evidence.some(e=>e.episode===c.source.episode))n.evidence=[...n.evidence.filter(e=>this.clock()-e.at<30*DAY),source(c)].slice(-3);
   n.updated=this.clock();if(n.evidence.length===3){n.state='active';n.reason='success';n.failures=0;}
  });
 }
}
