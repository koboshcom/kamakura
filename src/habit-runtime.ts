import {successfulProcedureReceipt,procedureExecution,procedureThrown,procedureTools,procedureContext} from './procedure-runtime.js';
import {classifyReceipt,receiptSource,type ReceiptClassifier} from './receipt-model.js';
import {join} from 'node:path';
import {tool,type ToolSet} from 'ai';
import {z} from 'zod';
import {config} from './config.js';
import {HabitsStore,captureHabit,requestedAction,type HabitAction,type HabitCapture,parseHabitAction,supportedHabitPair} from './habits.js';
import type {IncomingMessage} from './types.js';
import type {LocalDevices} from './local-devices.js';
import {logger,errorType} from './logger.js';
export const habits=new HabitsStore(join(config.dataDir,'learned-execution-habits-v3'));
function current(m:IncomingMessage,c:HabitCapture):boolean {
 const fresh=captureHabit(m);return fresh?.owner===c.owner&&fresh.text===c.text&&fresh.source.at===c.source.at&&fresh.source.message===c.source.message&&fresh.source.channel===c.source.channel&&fresh.source.chat===c.source.chat;
}
export async function habitContext(m:IncomingMessage):Promise<string>{
 const c=captureHabit(m);if(!c)return '';
 try {
  await habits.suppress(c);if(!current(m,c))return '';const offers=await habits.offers(c);const relevant=await procedureContext(m);return relevant+(offers.length?'Recurring successful owner requests (three independent episodes, confirmed owner timezone). You may briefly OFFER a reminder in THIS chat; never create or call a scheduler by inference. Explicit normal user approval is still required. Advisory evidence '+JSON.stringify(offers):'');
 }catch(e){logger.warn({err:errorType(e)},'habit context unavailable');return '';}
}
export function habitTools(m:IncomingMessage):ToolSet{
 const c=captureHabit(m);if(!c)return {};
 const check=()=>{if(!current(m,c))throw new Error('Direct current owner required');};
 return {
  ...procedureTools(m),
  list_habits:tool({description:'List this owner’s bounded habits, evidence counts, pending/active/disabled/removed states. Habits never grant permissions.',inputSchema:z.object({}),execute:async()=>{check();return habits.list(c.owner);}}),
  control_habit:tool({description:'Disable or remove an existing habit only on the current owner’s explicit request. No enable tool; removed/disabled habits cannot silently return. Select the exact owner-requested habit.',inputSchema:z.object({id:z.string().regex(/^[a-f0-9]{24}$/),mode:z.enum(['disabled','removed'])}),execute:async({id,mode})=>{
   check();const h=(await habits.list(c.owner)).find(h=>h.id===id);if(!h)throw new Error('Unknown habit');
   const verb=mode==='removed'?/\b(?:remove|forget|delete)\b/i:/\b(?:disable|stop|don't|do not|never)\b/i;
   if(!verb.test(c.text)||!/\b(?:habits?|routines?|automatically|automatic)\b/i.test(c.text)||!c.text.includes(id)&&!requestedAction(c.text.replace(/\b(?:not|never|don't|do not|stop|avoid|cancel|instead)\b/gi,''),h.y??h.x))throw new Error('Explicit matching habit request required');
   return habits.control(c.owner,id,mode);
  }})
 };
}
export function successfulExecution(result:unknown):boolean {
 if(result===undefined||result===null||result===false)return false;
 if(typeof result!=='object')return true; // resolved executor primitive, never parsed stdout claims
 const r=result as Record<string,unknown>;
 if(r.error||r.ok===false||r.success===false||r.sent===false||r.timedOut===true||r.cancelled===true)return false;
 if('exitCode' in r&&r.exitCode!==0)return false;
 if(typeof r.text==='string'){
  try{const parsed=JSON.parse(r.text);if(parsed&&typeof parsed==='object'&&(parsed.error||parsed.ok===false||parsed.timedOut))return false;}catch{}
 }
 return true;
}
/** Generic successful execution receipts. No saved tool args/code are replayed.
 * Learned Y is advisory to the existing model and existing tools, not an executor DSL.
 * The model must resolve a fresh current artifact/destination and all normal guards.
 */
export function habitLocalTools(m:IncomingMessage,tools:ToolSet,_devices?:LocalDevices,classifier:ReceiptClassifier=classifyReceipt):ToolSet {
 const c=captureHabit(m);if(!c)return tools;
 const wrapped={...tools};
 const advisories=new WeakMap<object,string>();
 let receiptCount=0;
 let followup:{tool:string;handles:Set<string>;attempted:boolean}|undefined;
 for(const [name,original]of Object.entries(tools)){
  if(!original.execute)continue;
  wrapped[name]={...original,toModelOutput:async (args:{toolCallId:string;input:unknown;output:unknown})=>{
   const originalOutput=original.toModelOutput?await original.toModelOutput(args):{type:'text' as const,value:JSON.stringify(args.output)};
   const hint=args.output&&typeof args.output==='object'?advisories.get(args.output):undefined;
   if(!hint)return originalOutput;
   if(originalOutput.type==='content')return {...originalOutput,value:[...originalOutput.value,{type:'text' as const,text:hint}]};
   return {type:'content' as const,value:[{type:'text' as const,text:originalOutput.type==='text'?originalOutput.value:JSON.stringify(originalOutput)},{type:'text' as const,text:hint}]};
  },execute:async(input,options)=>{
   const args=input&&typeof input==='object'?input as Record<string,unknown>:{};
   if(followup?.tool===name&&followup.handles.size){
    if(followup.attempted)throw new Error('Learned artifact followup already attempted');
    if(typeof args.artifact_handle!=='string'||!followup.handles.has(args.artifact_handle))throw new Error('Learned followup requires this successful X artifact');
    followup.attempted=true;
   }
   let result:unknown;try{result=await original.execute!(input,options);}catch(e){procedureThrown(m,name);throw e;}
   if(current(m,c))await procedureExecution(m,name,result,options.abortSignal);
   if(!current(m,c)||!successfulExecution(result)||receiptCount>=8)return result;
   receiptCount++;
   try{
    const action=await classifier(c,name,input,result,options.abortSignal);
    if(!action||!current(m,c))return result;
    const receipt=receiptSource(c,action,input,result);
    await habits.suppress(c);await habits.success(receipt,action);if(current(m,c))await successfulProcedureReceipt(m,{action,capture:receipt});if(!current(m,c))return result;
    const h=await habits.claim(c,action);if(!h?.y||!current(m,c)||!await habits.allowed(c.owner,h.id))return result;
    options.abortSignal?.throwIfAborted();
    // Do not wrap/replace the original SDK output shape. Text media and custom
    // toModelOutput receive an added advisory, all other outputs retain original data.
    const advisory='Learned advisory followup from three independent successful direct-owner requests. '+JSON.stringify({habitId:h.id,nextRequestedAction:h.y})+
     '. Continue only through currently registered tools and their normal safety checks. Use ONLY a fresh_artifacts handle from this successful X for file delivery, never a historical path. Re-resolve current owner workspace/artifact and exact already-used personal destination. For shell, if no actual tool supplies verified owner-used destination metadata, ask for current-DM confirmation; do not infer destination safety. This is not permission for new external destinations, dangerous actions, emails, money or public posts. Never replay stored shell/code or historical files. If unavailable or uncertain, report the limit. Briefly notify after actual success. Do not repeat this followup.';
    if(result&&typeof result==='object'){
     const values=(result as Record<string,unknown>).fresh_artifacts;
     const handles=new Set<string>(Array.isArray(values)?values.slice(0,4).map(v=>v?.artifact_handle).filter(v=>typeof v==='string'):[]);
     followup={tool:h.y.tool,handles:h.evidence.some(e=>(e.receipt?.inputArtifacts??0)>0)?handles:new Set(),attempted:false};advisories.set(result,advisory);
    }
    return result;
   }catch(e){logger.warn({err:errorType(e)},'habit receipt unavailable');return result;}
  }};
 }
 return wrapped;
}
