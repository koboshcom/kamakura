import test from 'node:test';
import assert from 'node:assert/strict';
import {GeminiVideoClient,geminiVideoSettings,nativeVideoMode,type NativeClip} from '../src/gemini-video.js';
const settings=geminiVideoSettings({GEMINI_VIDEO_KEY:'fixture-secret',GEMINI_VIDEO_MODEL:'gemini-3.5-flash-lite',GEMINI_VIDEO_BASE_URL:'https://video.example'})!;
const clip:NativeClip={data:Buffer.from('bounded'),mime:'video/mp4',start:50,end:55,sourceDuration:900,processedSeconds:20,transferBytes:7,fingerprint:'fixture'};
const event=(event_type:string,rest:object={})=>'data: '+JSON.stringify({event_type,...rest})+'\n\n';
test('verified full-source duration selects strict 300 boundary, not segment length',()=>{
 assert.equal(nativeVideoMode(299.999),'static');assert.equal(nativeVideoMode(300),'agentic');assert.equal(nativeVideoMode(900),'agentic');
 for(const value of [undefined,NaN,0])assert.throws(()=>nativeVideoMode(value),/UNKNOWN/);
});
test('documented Interactions agentic streaming exact wire, thought ignored, bounded deltas',async()=>{
 let body:any,url='',auth='';
 const wire=event('step.start',{index:0,step:{type:'thought'}})+event('step.delta',{index:0,delta:{type:'text',text:'private thought'}})+event('step.start',{index:1,step:{type:'model_output'}})+event('step.delta',{index:1,delta:{type:'text',text:'bounded '}})+event('step.delta',{index:1,delta:{type:'text',text:'answer'}})+event('interaction.completed',{interaction:{status:'completed'}});
 const client=new GeminiVideoClient(settings,(async(u,i)=>{url=String(u);auth=new Headers(i?.headers).get('x-goog-api-key')??'';body=JSON.parse(String(i?.body));return new Response(wire,{headers:{'content-type':'text/event-stream'}});}) as typeof fetch);
 assert.equal(await client.answer(clip,'Actual question',undefined,AbortSignal.timeout(1000)),'bounded answer');
 assert.equal(auth,'fixture-secret');assert.equal(body.model,'gemini-3.5-flash-lite');
 assert.equal(url,'https://video.example/v1beta/interactions');assert.equal(body.stream,true);assert.equal(body.store,false);
 assert.equal(body.input[0].processing,'agentic');assert.equal(body.input[0].mime_type,'video/mp4');assert.equal(body.input[0].resolution,'low');
 assert.equal(body.input[1].type,'text');assert.match(body.input[1].text,/50-55s/);assert.match(body.input[1].text,/Actual question/);assert.equal(body.tools,undefined);
});
test('stream rejects error, incomplete, oversized, secret output and releases reader',async()=>{
 for(const wire of [event('error',{error:{message:'SECRET raw payload'}}),event('step.start',{index:1,step:{type:'model_output'}}), 'x'.repeat(131073), event('step.start',{index:1,step:{type:'model_output'}})+event('step.delta',{index:1,delta:{type:'text',text:'fixture-secret'}})]){
  const client=new GeminiVideoClient(settings,(async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})) as typeof fetch);
  await assert.rejects(client.answer(clip,'question',undefined,AbortSignal.timeout(1000)),e=>!String(e).includes('SECRET')&&!String(e).includes('fixture-secret'));
 }
});
test('stream cancellation and split SSE chunks',async()=>{
 const aborted=new AbortController();aborted.abort();
 const client=new GeminiVideoClient(settings,(async()=>{throw new Error('must not fetch');}) as typeof fetch);
 await assert.rejects(client.answer(clip,'question',undefined,aborted.signal),/cancelled/);
});

test('long coverage config is independent, validated and does not increase runtime or bytes',()=>{
 assert.equal(settings.maxLong,1800);assert.equal(settings.maxShort,300);assert.equal(settings.runtime,60000);
 for(const value of ['299','3601','NaN'])assert.throws(()=>geminiVideoSettings({GEMINI_VIDEO_KEY:'fixture',GEMINI_VIDEO_MODEL:'gemini-3.5-flash-lite',GEMINI_VIDEO_BASE_URL:'https://video.example',GEMINI_VIDEO_MAX_LONG_SECONDS:value}));
});
test('asynchronous split SSE and stalled-reader cancellation are bounded',async()=>{
 const wire=event('step.start',{index:0,step:{type:'model_output'}})+event('step.delta',{index:0,delta:{type:'text',text:'split answer'}})+event('interaction.completed',{interaction:{status:'completed'}});
 const bytes=new TextEncoder().encode(wire);let offset=0;
 const stream=new ReadableStream<Uint8Array>({async pull(c){await Promise.resolve();if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.slice(offset,offset+3));offset+=3;}});
 const client=new GeminiVideoClient(settings,(async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})) as typeof fetch);
 assert.equal(await client.answer(clip,'fresh',undefined,AbortSignal.timeout(1000)),'split answer');
 let cancelled=false;const stalled=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
 const slow=new GeminiVideoClient(settings,(async()=>new Response(stalled,{headers:{'content-type':'text/event-stream'}})) as typeof fetch);
 const controller=new AbortController();const pending=slow.answer(clip,'fresh',undefined,controller.signal);
 setTimeout(()=>controller.abort(),10);
 await assert.rejects(pending,/cancelled/);assert.equal(cancelled,true);
});
