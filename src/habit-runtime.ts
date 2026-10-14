import {join} from 'node:path';
import {tool,type ToolSet} from 'ai';
import {z} from 'zod';
import {config} from './config.js';
import {HabitsStore,captureHabit,requestedAction,type HabitAction,type HabitCapture,supportedHabitTools,parseHabitAction,supportedHabitPair} from './habits.js';
import type {IncomingMessage} from './types.js';
import type {LocalDevices} from './local-devices.js';
import {logger,errorType} from './logger.js';
export const habits=new HabitsStore(join(config.dataDir,'learned-habits'));
function current(m:IncomingMessage,c:HabitCapture):boolean {
 const fresh=captureHabit(m);return fresh?.owner===c.owner&&fresh.text===c.text&&fresh.source.at===c.source.at&&fresh.source.message===c.source.message&&fresh.source.channel===c.source.channel&&fresh.source.chat===c.source.chat;
}
export async function habitContext(m:IncomingMessage):Promise<string>{
 const c=captureHabit(m);if(!c)return '';
 try {
  await habits.suppress(c);if(!current(m,c))return '';const offers=await habits.offers(c);return offers.length?'Recurring successful owner requests (three independent episodes, confirmed owner timezone). You may briefly OFFER a reminder in THIS chat; never create or call a scheduler by inference. Explicit normal user approval is still required. Advisory evidence '+JSON.stringify(offers):'';
 }catch(e){logger.warn({err:errorType(e)},'habit context unavailable');return '';}
}
export function habitTools(m:IncomingMessage):ToolSet{
 const c=captureHabit(m);if(!c)return {};
 const check=()=>{if(!current(m,c))throw new Error('Direct current owner required');};
 return {
  list_habits:tool({description:'List this owner’s bounded habits, evidence counts, pending/active/disabled/removed states. Habits never grant permissions.',inputSchema:z.object({}),execute:async()=>{check();return habits.list(c.owner);}}),
  control_habit:tool({description:'Disable or remove an existing habit only on the current owner’s explicit request. No enable tool; removed/disabled habits cannot silently return. Select the exact owner-requested habit.',inputSchema:z.object({id:z.string().regex(/^[a-f0-9]{24}$/),mode:z.enum(['disabled','removed'])}),execute:async({id,mode})=>{
   check();const h=(await habits.list(c.owner)).find(h=>h.id===id);if(!h)throw new Error('Unknown habit');
   const verb=mode==='removed'?/\b(?:remove|forget|delete)\b/i:/\b(?:disable|stop|don't|do not|never)\b/i;
   if(!verb.test(c.text)||!/\b(?:habits?|routines?|automatically|automatic)\b/i.test(c.text)||!c.text.includes(id)&&!requestedAction(c.text.replace(/\b(?:not|never|don't|do not|stop|avoid|cancel|instead)\b/gi,''),h.y??h.x))throw new Error('Explicit matching habit request required');
   return habits.control(c.owner,id,mode);
  }})
 };
}
function successful(action:HabitAction,result:unknown):boolean{
 if(action.tool==='read_file'){const r=result as {text?:unknown;nextOffset?:unknown}|null;return !!r&&typeof r.text==='string'&&('nextOffset' in r)&&!('error' in r);}
 if(action.tool==='list_files'||action.tool==='grep'){const r=result as {matches?:unknown;truncated?:unknown}|null;return !!r&&Array.isArray(r.matches)&&typeof r.truncated==='boolean'&&!('error' in r);}
 if(action.tool==='list_local_devices')return Array.isArray(result);
 const r=result as {text?:string;images?:string[]}|null;
 if(!r||!Array.isArray(r.images)||!r.images.length)return false;
 try {const text=JSON.parse(r.text??'{}');return !text.error&&text.ok!==false&&!text.timedOut;}catch{return false;}
}
/** Wrap actual registered executors, not model-reported results. Auto-Y reuses current original owner-scoped guards. */
export function habitLocalTools(m:IncomingMessage,tools:ToolSet,devices?:LocalDevices):ToolSet {
 const c=captureHabit(m);if(!c)return tools;
 const wrapped={...tools};
 for(const name of supportedHabitTools){
  const original=tools[name];if(!original?.execute)continue;
  wrapped[name]={...original,...(name==='list_local_devices'?{toModelOutput:({output}: {output:unknown})=>{const o=output as {text?:string;images?:string[]};return {type:'content' as const,value:[{type:'text' as const,text:o.text??JSON.stringify(output)},...(o.images??[]).map(data=>({type:'file' as const,mediaType:'image/png',data:{type:'data' as const,data}}))]};}}:{}),execute:async(input,options)=>{
   const action=parseHabitAction(name,input);
   const result=await original.execute!(input,options);
   if(!action||!current(m,c)||!requestedAction(c.text,action)||!successful(action,result))return result;
   try {
    await habits.suppress(c);await habits.success(c,action);if(!current(m,c))return result;
    const h=await habits.claim(c,action);const y=h?.y;
    if(!y||!supportedHabitPair(action,y)||!current(m,c))return result;
    options.abortSignal?.throwIfAborted();
    if(y.tool==='local_snapshot'){
     const device=(await devices?.list(c.owner)??[]).find(d=>d.deviceId===y.deviceId);
     if(!device?.connected||device.paused)return result;
    }
    if(!current(m,c))return result;
    if(!await habits.allowed(c.owner,h!.id)||!current(m,c))return result;
    const target=tools[y.tool];if(!target?.execute)return result;
    const {tool:ignored,...args}=y;const output=await target.execute(args,options);
    const rendered=output as {text?:string;images?:string[]};
    const followup={id:h!.id,tool:y.tool,success:successful(y,output),output:y.tool==='local_snapshot'?{text:rendered.text}:output};
    const base=result as {text?:string;images?:string[]};
    return {...(name==='local_snapshot'?base:{result}),habitFollowup:followup,text:(base.text??JSON.stringify(result))+'\nHabit followup '+JSON.stringify(followup),images:[...(base.images??[]),...(rendered.images??[])]};
   }catch(e){logger.warn({err:errorType(e)},'habit followup unavailable');return result;}
  }};
 }
 return wrapped;
}
