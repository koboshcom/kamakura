import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { config } from '../src/config.js';
import { reportedCacheRead, measureTurn, timedModel, measureSend, toolMeasured, promptBuilt, monotonicNow, type TurnTiming } from '../src/latency.js';
const usage={inputTokens:{total:10,noCache:4,cacheRead:6,cacheWrite:undefined},outputTokens:{total:2,text:2,reasoning:0}};
test('timing captures stages/cache metadata without content; nonstream has no invented TTFT',async()=>{
 const old=config.latencyMetrics;config.latencyMetrics=true;let timing:TurnTiming|undefined;
 try{
 const model=new MockLanguageModelV4({doGenerate:{content:[{type:'text',text:'secret output'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]}});
 await measureTurn(25,async()=>{promptBuilt(monotonicNow());await generateText({model:timedModel(model),prompt:'secret input'});toolMeasured(8);await measureSend(async()=>{});},t=>{timing=t;});
 assert.equal(timing!.batchingWaitMs,25);assert.equal(timing!.model[0]!.cacheReadTokens,6);assert.equal(timing!.model[0]!.firstContentMs,null);assert.equal(timing!.sendMs.length,1);assert.deepEqual(timing!.toolMs,[8]);assert.ok(!JSON.stringify(timing).includes('secret'));assert.ok(timing!.totalMs>=25);
 }finally{config.latencyMetrics=old;}
});
test('stream provider event and first content are distinct; disabled metrics preserve exact model',async()=>{
 const old=config.latencyMetrics;config.latencyMetrics=true;let timing:TurnTiming|undefined;
 try{
 const model=new MockLanguageModelV4({doStream:{stream:new ReadableStream({async start(c){c.enqueue({type:'stream-start',warnings:[]});await new Promise(r=>setTimeout(r,15));c.enqueue({type:'text-start',id:'x'});c.enqueue({type:'text-delta',id:'x',delta:'private'});c.enqueue({type:'text-end',id:'x'});c.enqueue({type:'finish',finishReason:{unified:'stop',raw:'stop'},usage});c.close();}})}});
 await measureTurn(0,async()=>{const result=streamText({model:timedModel(model),prompt:'private'});assert.equal(await result.text,'private');},t=>{timing=t;});
 assert.ok(timing!.model[0]!.firstContentMs!>timing!.model[0]!.firstProviderEventMs!);assert.equal(timing!.model[0]!.cacheReadTokens,6);
 config.latencyMetrics=false;assert.equal(timedModel(model),model);
 }finally{config.latencyMetrics=old;}
});
test('telemetry emitter failure never changes delivery and failed turn is recorded',async()=>{
 const old=config.latencyMetrics;config.latencyMetrics=true;let timing:TurnTiming|undefined;
 try{
 assert.equal(await measureTurn(0,async()=>42,()=>{throw new Error('metrics');}),42);
 await assert.rejects(measureTurn(0,async()=>{throw new Error('failure');},t=>{timing=t;}),/failure/);assert.equal(timing!.failed,true);
 }finally{config.latencyMetrics=old;}
});

test('cache counts distinguish explicit zero from SDK-normalized missing provider usage',()=>{
 assert.equal(reportedCacheRead({inputTokens:{cacheRead:0},raw:{input_tokens:10}}),null);
 assert.equal(reportedCacheRead({inputTokens:{cacheRead:0},raw:{input_tokens:10,input_tokens_details:{cached_tokens:0}}}),0);
 assert.equal(reportedCacheRead({inputTokens:{},raw:undefined}),null);
});
