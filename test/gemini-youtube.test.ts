import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeVideoURI,normalizeVideoURL} from '../src/video-url.js';
import {GeminiVideoClient,GeminiYouTubeCache,geminiVideoSettings} from '../src/gemini-video.js';
const settings=()=>geminiVideoSettings({GEMINI_VIDEO_BASE_URL:'https://native.example',GEMINI_VIDEO_KEY:'private-fixture',GEMINI_VIDEO_MODEL:'fixture'})!;
const uri='https://www.youtube.com/watch?v=oNNZJKX2KOU';
const stream=()=>new Response(['step.start','step.delta','interaction.completed'].map((event_type,i)=>'data: '+JSON.stringify(i===0?{event_type,index:0,step:{type:'model_output'}}:i===1?{event_type,index:0,delta:{type:'text',text:'observed evidence'}}:{event_type,interaction:{status:'completed'}})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
test('strict canonical YouTube identity and meaningful query preservation',()=>{
 for(const link of ['https://youtube.com/shorts/oNNZJKX2KOU?si=tracking','https://youtu.be/oNNZJKX2KOU?si=x',uri])assert.equal(normalizeVideoURL(link),uri);
 assert.equal(youtubeVideoURI('https://www.youtube.com/watch?v=oNNZJKX2KOU&t=3&list=x'),uri+'&t=3&list=x');
 for(const link of ['https://youtube.com/shorts/oNNZJKX2KOU/extra','https://youtube.com/watch?v=bad','https://name@youtube.com/watch?v=oNNZJKX2KOU','https://youtube.com:444/watch?v=oNNZJKX2KOU'])assert.throws(()=>youtubeVideoURI(link));
 assert.equal(youtubeVideoURI('https://youtube.com.evil/watch?v=oNNZJKX2KOU'),undefined);
 assert.equal(normalizeVideoURL('https://example.com/a.mp4?sig=a&si=b'),'https://example.com/a.mp4?sig=a&si=b');
});
test('native static URI wire, no upload/download, metadata once, actual fresh questions and owner isolation',async()=>{
 let calls=0,reads=0;const questions:string[]=[];
 const client=new GeminiVideoClient(settings(),async(url,init)=>{
  assert.equal(String(url),'https://native.example/v1beta/interactions');const b=JSON.parse(String(init?.body));assert.equal(b.store,false);assert.equal(b.stream,true);
  assert.equal(b.input[0].uri,uri);assert.equal(b.input[0].processing.type,'static');assert.equal(b.input[0].processing.fps,1);assert.equal(b.input[0].processing.end_offset,'15s');assert.equal(b.input[0].resolution,'low');assert.equal(b.input[0].data,undefined);assert.equal(b.generation_config.max_output_tokens,1024);calls++;questions.push(b.input[1].text);return stream();
 });
 const cache=new GeminiYouTubeCache(),meta=async()=>{reads++;return 15;},fallback=async()=>{throw new Error('No download on successful URI');};
 const a=await cache.watch('a','dm',uri,undefined,'first question',client,meta,fallback);
 const b=await cache.watch('a','dm',uri,undefined,'new follow-up question',client,meta,fallback);
 assert.equal(reads,1);assert.equal(calls,2);assert.equal(a.videoDownloadBytes,0);assert.equal(b.cachedClip,true);assert.match(questions[1]!,/new follow-up/);
 await cache.watch('b','dm',uri,undefined,'other owner',client,meta,fallback);await cache.watch('a','other-channel',uri,undefined,'other channel',client,meta,fallback);assert.equal(reads,3);
});
test('agentic URI exact wire and duration/long coverage guards',async()=>{
 const client=new GeminiVideoClient(settings(),async(_u,i)=>{const b=JSON.parse(String(i?.body));assert.equal(b.input[0].processing,'agentic');assert.equal(b.input[0].uri,uri);return stream();});
 await client.answerURI(uri,300,undefined,'question',AbortSignal.timeout(1000));
 await assert.rejects(client.answerURI(uri,1801,undefined,'question',AbortSignal.timeout(1000)),/coverage/);
 await assert.rejects(client.answerURI(uri,NaN,undefined,'question',AbortSignal.timeout(1000)),/UNKNOWN/);
});
test('one native rejection switches only to bounded cached fallback; auth/rate limits do not',async()=>{
 let native=0,fallbacks=0;const client=new GeminiVideoClient(settings(),async()=>{native++;return new Response('{}',{status:400});}),cache=new GeminiYouTubeCache();
 const fallback=async()=>{fallbacks++;return {text:'bounded fallback',cachedClip:fallbacks>1};};
 await cache.watch('a','dm',uri,undefined,'question',client,async()=>15,fallback);
 await cache.watch('a','dm',uri,undefined,'fresh question',client,async()=>{throw new Error('metadata cache');},fallback);
 assert.equal(native,1);assert.equal(fallbacks,2); // callbacks delegate to existing byte-metered clip cache, not re-extract.
 for(const status of [401,403,429]){
  const c=new GeminiVideoClient(settings(),async()=>new Response('{}',{status})),e=new GeminiYouTubeCache();
  await assert.rejects(e.watch('a','dm',uri,undefined,'question',c,async()=>15,async()=>{throw new Error('must not fallback');}),/without fallback/);
 }
});
test('unknown duration and coverage budget never initiate native or fallback requests',async()=>{
 let count=0;const c=new GeminiVideoClient(settings(),async()=>{count++;return stream();});
 await assert.rejects(new GeminiYouTubeCache().watch('a','dm',uri,undefined,'question',c,async()=>NaN,async()=>{count++;}),/UNKNOWN/);
 await assert.rejects(new GeminiYouTubeCache().watch('a','dm',uri,undefined,'question',c,async()=>1801,async()=>{count++;}),/coverage limit/);
 assert.equal(count,0);
});
