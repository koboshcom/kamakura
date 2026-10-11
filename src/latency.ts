import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { config } from './config.js';
import { logger } from './logger.js';

export type ModelTiming = { mode:'generate'|'stream'; totalMs:number; firstProviderEventMs:number|null; firstContentMs:number|null; inputTokens?:number; outputTokens?:number; cacheReadTokens?:number; failed:boolean };
export type TurnTiming = { turn:string; batchingWaitMs:number; promptBuildMs:number; model:ModelTiming[]; toolMs:number[]; sendMs:number[]; totalMs:number; failed:boolean };
const turns = new AsyncLocalStorage<TurnTiming>();
export const monotonicNow = () => performance.now();
export async function measureTurn<T>(batchingWaitMs:number, fn:()=>Promise<T>, emit:(timing:TurnTiming)=>void = timing=>logger.info({latency:timing},'turn latency')):Promise<T> {
  if (!config.latencyMetrics) return fn();
  const start=monotonicNow();
  const timing:TurnTiming={turn:randomUUID(),batchingWaitMs,promptBuildMs:0,model:[],toolMs:[],sendMs:[],totalMs:0,failed:false};
  return turns.run(timing,async()=>{try{return await fn();}catch(error){timing.failed=true;throw error;}finally{timing.totalMs=monotonicNow()-start+batchingWaitMs;try{emit(timing);}catch{/* metrics must not break delivery */}}});
}
export function promptBuilt(start:number):void { const timing=turns.getStore();if(timing)timing.promptBuildMs+=monotonicNow()-start; }
export function toolMeasured(ms:number):void { turns.getStore()?.toolMs.push(ms); }
export async function measureSend<T>(fn:()=>Promise<T>):Promise<T> {const start=monotonicNow();try{return await fn();}finally{turns.getStore()?.sendMs.push(monotonicNow()-start);}}
/** Provider-normalized stream events, not HTTP bytes. Metadata is not content TTFT.
 * No prompt, output, tool arguments, owner/chat IDs, model IDs or provider metadata are recorded.
 */
export function timedModel(model:Exclude<LanguageModel,string>):LanguageModel {
  if (!config.latencyMetrics) return model;
  return wrapLanguageModel({model,middleware:{
    wrapGenerate:async({doGenerate})=>{
      const start=monotonicNow(), timing:ModelTiming={mode:'generate',totalMs:0,firstProviderEventMs:null,firstContentMs:null,failed:false};
      turns.getStore()?.model.push(timing);
      try{const result=await doGenerate();timing.inputTokens=result.usage.inputTokens.total;timing.outputTokens=result.usage.outputTokens.total;timing.cacheReadTokens=result.usage.inputTokens.cacheRead;return result;}
      catch(error){timing.failed=true;throw error;}finally{timing.totalMs=monotonicNow()-start;}
    },
    wrapStream:async({doStream})=>{
      const start=monotonicNow(), timing:ModelTiming={mode:'stream',totalMs:0,firstProviderEventMs:null,firstContentMs:null,failed:false};
      turns.getStore()?.model.push(timing);
      try{const result=await doStream();return {...result,stream:result.stream.pipeThrough(new TransformStream({
        transform(part,controller){
          timing.firstProviderEventMs??=monotonicNow()-start;
          if ((part.type==='text-delta'||part.type==='reasoning-delta'||part.type==='tool-input-delta')&&part.delta.length || part.type==='tool-call') timing.firstContentMs??=monotonicNow()-start;
          if(part.type==='error')timing.failed=true;
          if(part.type==='finish'){timing.inputTokens=part.usage.inputTokens.total;timing.outputTokens=part.usage.outputTokens.total;timing.cacheReadTokens=part.usage.inputTokens.cacheRead;}
          timing.totalMs=monotonicNow()-start;controller.enqueue(part);
        },flush(){timing.totalMs=monotonicNow()-start;}
      }))};}catch(error){timing.failed=true;timing.totalMs=monotonicNow()-start;throw error;}
    }
  }});
}
