import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeVideoURI,normalizeVideoURL} from '../src/video-url.js';
import {sanitizedVideoError,GeminiVideoClient,GeminiYouTubeCache,geminiVideoSettings} from '../src/gemini-video.js';
const settings=()=>geminiVideoSettings({GEMINI_VIDEO_BASE_URL:'https://native.example',GEMINI_VIDEO_KEY:'private-fixture',GEMINI_VIDEO_MODEL:'fixture'})!;
const uri='https://www.youtube.com/watch?v=oNNZJKX2KOU';
const stream=()=>new Response(['step.start','step.delta','interaction.completed'].map((event_type,i)=>'data: '+JSON.stringify(i===0?{event_type,index:0,step:{type:'model_output'}}:i===1?{event_type,index:0,delta:{type:'text',text:'observed evidence'}}:{event_type,interaction:{status:'completed'}})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
test('strict canonical YouTube identity drops playlist and tracking',()=>{
 for(const link of ['https://youtube.com/shorts/oNNZJKX2KOU?si=tracking','https://youtu.be/oNNZJKX2KOU?si=x',uri])assert.equal(normalizeVideoURL(link),uri);
 assert.equal(youtubeVideoURI('https://www.youtube.com/watch?v=oNNZJKX2KOU&t=3&list=x'),uri);
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
test('TTL, count/attempt caps and in-flight metadata do not multiply requests',async()=>{
 let now=0,reads=0,finish!:(n:number)=>void;
 const cache=new GeminiYouTubeCache(()=>now),s={...settings(),handles:1,attempts:2,ttl:1000};
 const c=new GeminiVideoClient(s,async()=>stream());
 const a=cache.watch('a','dm',uri,undefined,'first',c,()=>new Promise<number>(r=>{finish=r;reads++;}),async()=>{});
 await assert.rejects(cache.watch('a','dm',uri,undefined,'duplicate',c,async()=>{reads++;return 15;},async()=>{}),/budget/);
 await assert.rejects(cache.watch('b','dm',uri,undefined,'different',c,async()=>15,async()=>{}),/count/);
 finish(15);await a;
 await cache.watch('a','dm',uri,undefined,'second',c,async()=>{throw new Error('cache');},async()=>{});
 await assert.rejects(cache.watch('a','dm',uri,undefined,'third',c,async()=>15,async()=>{}),/budget/);
 now=1001;await cache.watch('a','dm',uri,undefined,'after expiry',c,async()=>{reads++;return 15;},async()=>{});assert.equal(reads,2);
});
test('real watch_video YouTube tool selects metadata-only native URI and owner-scoped handle followup',async()=>{
 const {config}=await import('../src/config.js'),{sandboxes}=await import('../src/sandbox.js'),{videoLinkTools}=await import('../src/video-link.js');
 const env={...process.env},originalFetch=globalThis.fetch,originalMeta=sandboxes.nativeVideoMetadata,originalClip=sandboxes.nativeVideoClip;
 const id='858585';config.sandbox.allowed.add(id);config.telegramAllowed.add(id);
 Object.assign(process.env,{VIDEO_LINK_ENABLED:'true',GEMINI_VIDEO_BASE_URL:'https://native.example',GEMINI_VIDEO_KEY:'tool-fixture',GEMINI_VIDEO_MODEL:'fixture'});
 let metadata=0;globalThis.fetch=async()=>stream();sandboxes.nativeVideoMetadata=async()=>{metadata++;return 15;};sandboxes.nativeVideoClip=async()=>{throw new Error('native success must not extract');};
 const incoming={transport:'telegram' as const,chatId:id,senderId:id,sender:'owner',id:'1',text:'what happens?',isGroup:false,timestamp:0};
 try{
  const t:any=videoLinkTools(incoming);const first=await t.watch_video.execute({url:'https://youtube.com/shorts/oNNZJKX2KOU?si=x',question:incoming.text});
  assert.equal(first.videoDownloadBytes,0);assert.equal(first.fullSource,true);
  const follow:any=videoLinkTools({...incoming,id:'2',text:'what is visible?'});const second=await follow.watch_video.execute({handle:first.handle,question:'what is visible?'});assert.equal(second.cachedClip,true);assert.equal(metadata,1);
  await assert.rejects(follow.watch_video.execute({handle:first.handle,question:'invented generic question'}),/actual latest/);
 }finally{globalThis.fetch=originalFetch;sandboxes.nativeVideoMetadata=originalMeta;sandboxes.nativeVideoClip=originalClip;config.sandbox.allowed.delete(id);config.telegramAllowed.delete(id);for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});

test('all native video forms canonicalize to exactly one strict video identity',()=>{
 const id='8jppMQSi_rE',canonical='https://www.youtube.com/watch?v='+id;
 for(const host of ['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'])for(const path of ['/watch?v='+id+'&list=RDH_Ab3nKZUfM&index=8&t=3&si=x&pp=x','/shorts/'+id+'?si=x','/embed/'+id+'?list=x','/live/'+id+'?t=4'])assert.equal(youtubeVideoURI('https://'+host+path),canonical);
 for(const host of ['youtu.be','www.youtu.be'])assert.equal(youtubeVideoURI('https://'+host+'/'+id+'?si=x&list=x'),canonical);
 assert.equal(youtubeVideoURI('HTTPS://WWW.YOUTUBE.COM:443/watch?v='+id),canonical);
 assert.equal(youtubeVideoURI('http://youtube.com:80/watch?v='+id),canonical);
 for(const path of ['/watch?v='+id+'&v='+id,'/watch?v='+id+'&%76='+id,'/watch?v=%38jppMQSi_rE','/playlist?list=x','/redirect?q=https://youtube.com/watch?v='+id,'/watch/../watch?v='+id,'/shorts/%38jppMQSi_rE','/shorts/'+id+'/extra','/watch?v='+id+'/'])assert.throws(()=>youtubeVideoURI('https://youtube.com'+path));
 for(const u of ['javascript://youtube.com/watch?v='+id,'https://name:pass@youtube.com/watch?v='+id,'https://youtube.com:444/watch?v='+id,'https://youtube.com\\evil/watch?v='+id])assert.throws(()=>youtubeVideoURI(u));
 for(const host of ['youtube.com.evil','evilyoutube.com','youtube.com.'])assert.equal(youtubeVideoURI('https://'+host+'/watch?v='+id),undefined);
});
test('bounded provider errors retain useful late reason but no credentials or URLs',async()=>{
 const secret='private-fixture',envSecret='another-provider-secret';process.env.OPENAI_API_KEY=envSecret;
 try{
 const message='Failure '+'.'.repeat(650)+' actual late root reason. '+secret+' '+envSecret+' Bearer abcdefg https://name:pass@example.test/upload?key=value&signed=secret';
 let logs:any[]=[];
 const client=new GeminiVideoClient(settings(),async()=>new Response(JSON.stringify({error:{code:400,status:'INVALID_ARGUMENT',message}}),{status:400}));
 const fallback=async()=>({text:'bounded fallback'});
 await new GeminiYouTubeCache().watch('a','dm',uri,undefined,'question',client,async()=>15,fallback,undefined,f=>logs.push(f));
 const serialized=JSON.stringify(logs);assert.match(serialized,/actual late root reason/);assert.match(serialized,/INVALID_ARGUMENT/);assert.match(serialized,/400/);
 for(const bad of [secret,envSecret,'name:pass','example.test','abcdefg','signed=secret'])assert.ok(!serialized.includes(bad),bad);
 assert.equal(logs.filter(x=>x.stage==='metadata').length,1);assert.equal(logs.filter(x=>x.stage==='fallback_download_extract').length,1);assert.equal(logs.at(-1).stage,'total');
 assert.ok(sanitizedVideoError('x'.repeat(9000)).length<8300);
 }finally{delete process.env.OPENAI_API_KEY;}
});
test('stage timings correlate metadata, first text, completion, zero downloads, fresh questions',async()=>{
 const logs:any[]=[];const diagnostic=(f:any)=>logs.push(f);
 const c=new GeminiVideoClient(settings(),async()=>stream(),diagnostic),cache=new GeminiYouTubeCache();
 const r=await cache.watch('a','dm',uri,undefined,'question',c,async()=>15,async()=>{throw new Error('no download');},undefined,diagnostic);
 assert.equal(r.videoDownloadBytes,0);
 for(const stage of ['parse','metadata','cache','native_headers','native_first_text','native_completed','total'])assert.ok(logs.some(x=>x.stage===stage),stage);
 for(const row of logs)if(row.elapsedMs!==undefined)assert.ok(row.elapsedMs>=0);
});
