import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {geminiVideoSettings,GeminiVideoClient,GeminiVideoCache,type NativeClip} from '../src/gemini-video.js';
import {videoRequestGate} from '../src/video-url.js';
const env={GEMINI_VIDEO_BASE_URL:'https://video.example',GEMINI_VIDEO_KEY:'private-video-key',GEMINI_VIDEO_MODEL:'explicit-model'};
const settings=geminiVideoSettings(env)!;
const response=(v:any)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const makeClip=(bytes=16):NativeClip=>{const data=Buffer.alloc(bytes);data.write('ftyp',4);return {data,mime:'video/mp4',start:0,end:5,transferBytes:100,processedSeconds:10,fingerprint:createHash('sha256').update(data).digest('hex')};};
const active={name:'files/fixture',uri:'https://video.example/v1beta/files/fixture',state:'ACTIVE'};
test('empty own key is OFF, ignores partial and shared providers, no network/client init',()=>{
 for(const e of [{},{...env,GEMINI_VIDEO_KEY:''},{GEMINI_VIDEO_BASE_URL:'bad',GEMINI_VIDEO_MODEL:'?',OPENAI_API_KEY:'secret',GOOGLE_API_KEY:'other'}])assert.equal(geminiVideoSettings(e),undefined);
});
test('key present requires own URL/model without fallback and protects native origin',()=>{
 for(const e of [{GEMINI_VIDEO_KEY:'x'},{...env,GEMINI_VIDEO_MODEL:''},{...env,GEMINI_VIDEO_BASE_URL:''},...['http://x','https://u:p@x','https://x?key=secret','https://x/v1','https://x/#secret'].map(url=>({...env,GEMINI_VIDEO_BASE_URL:url})),{...env,GEMINI_VIDEO_MODEL:'../../model'}])assert.throws(()=>geminiVideoSettings(e));
 assert.equal(settings.model,'explicit-model');
});
test('native inline video wire includes exact new question, no tools or main model/key',async()=>{
 const bodies:any[]=[];const client=new GeminiVideoClient(settings,(async(url:any,init:any)=>{
  assert.equal(String(url),'https://video.example/v1beta/models/explicit-model:generateContent');
  assert.equal(init.headers['x-goog-api-key'],env.GEMINI_VIDEO_KEY);assert.equal(init.redirect,'error');
  bodies.push(JSON.parse(init.body));return response({candidates:[{content:{parts:[{text:'clip-specific answer'}]}}]});
 }) as typeof fetch);
 let extracted=0;const cache=new GeminiVideoCache();
 for(const q of ['What did she say?','What happened at the end?'])await cache.watch('owner','channel','canonical-url',[0,5],q,client,async()=>{extracted++;return makeClip();});
 assert.equal(extracted,1);assert.equal(bodies.length,2);assert.match(bodies[1].contents[0].parts[1].text,/What happened at the end/);
 assert.equal(bodies[0].contents[0].parts[0].inlineData.mimeType,'video/mp4');assert.equal(bodies[0].tools,undefined);
 assert.ok(!JSON.stringify(bodies).includes(env.GEMINI_VIDEO_KEY));
});
test('cache keys isolate canonical owner/channel, source snapshot, range and provider credentials',async()=>{
 let extracted=0,generated=0;
 const c=new GeminiVideoClient(settings,(async()=>{generated++;return response({candidates:[{content:{parts:[{text:'evidence'}]}}]});}) as typeof fetch);
 const cache=new GeminiVideoCache();
 for(const [o,s,u] of [['a','dm','url'],['b','dm','url'],['a','other','url'],['a','dm','fingerprint-new']])await cache.watch(o!,s!,u!,[0,5],'q',c,async()=>{extracted++;return makeClip();});
 assert.equal(extracted,4);assert.equal(generated,4);
});
test('Files upload poll ACTIVE reusable file and fresh-question generate, TTL best-effort DELETE',async()=>{
 const calls:{url:string,init:any}[]=[];let polls=0,now=0;
 const c=new GeminiVideoClient({...settings,inlineBytes:1},(async(url:any,init:any)=>{
  const u=String(url);calls.push({url:u,init});
  if(u.endsWith('/upload/v1beta/files'))return new Response('',{headers:{'x-goog-upload-url':'https://video.example/upload/session?opaque=fixture'}});
  if(u.includes('/upload/session'))return response({file:{...active,state:'PROCESSING'}});
  if(init.method==='DELETE')return new Response(null,{status:204});
  if(init.method==='GET'){polls++;return response(active);}
  return response({candidates:[{content:{parts:[{text:'fresh answer'}]}}]});
 }) as typeof fetch);
 const cache=new GeminiVideoCache(()=>now);let extracts=0;
 for(const q of ['q1','q2'])await cache.watch('a','dm','url',[0,5],q,c,async()=>{extracts++;return makeClip();});
 assert.equal(extracts,1);assert.equal(polls,1);
 const generates=calls.filter(c=>c.url.includes(':generateContent'));assert.equal(generates.length,2);
 assert.equal(JSON.parse(generates[1]!.init.body).contents[0].parts[0].fileData.fileUri,active.uri);
 now=settings.ttl;await cache.sweep();assert.equal(calls.filter(c=>c.init.method==='DELETE').length,1);
});
test('remote upload redirect/cross-origin URI refuses key leaks',async()=>{
 for(const mode of ['upload','uri']){
  const calls:string[]=[];
  const c=new GeminiVideoClient({...settings,inlineBytes:1},(async(url:any)=>{calls.push(String(url));if(String(url).endsWith('/files'))return new Response('',{headers:{'x-goog-upload-url':mode==='upload'?'https://evil.example/upload':'https://video.example/upload/session'}});
   return response({file:{...active,uri:'https://evil.example/v1beta/files/fixture'}});
  }) as typeof fetch);
  await assert.rejects(new GeminiVideoCache().watch('a','dm',mode,[0,5],'q',c,async()=>makeClip()),/unavailable/);
  assert.ok(calls.every(u=>u.startsWith(settings.base)));
 }
});
test('failed Files processing yields no generation and bounded remote deletion',async()=>{
 const methods:string[]=[];
 const c=new GeminiVideoClient({...settings,inlineBytes:1},(async(url:any,init:any)=>{
  methods.push(String(url));
  if(init.method==='DELETE')return new Response(null,{status:204});
  if(String(url).endsWith('/upload/v1beta/files'))return new Response('',{headers:{'x-goog-upload-url':settings.base+'/upload/session'}});
  return response({file:{...active,state:'FAILED'}});
 }) as typeof fetch);
 await assert.rejects(new GeminiVideoCache().watch('a','dm','url',[0,5],'q',c,async()=>makeClip()));
 assert.ok(!methods.some(x=>x.includes(':generateContent')));assert.ok(methods.some(x=>x.endsWith('/v1beta/files/fixture')));
});
test('HTTP body/status, timeout and cancellation are sanitized and stop retries',async()=>{
 for(const kind of ['http','cancel','tool','big']){
  let n=0;const ctrl=new AbortController();if(kind==='cancel')ctrl.abort();
  const c=new GeminiVideoClient(settings,(async()=>{n++;if(kind==='http')return new Response('private-video-key raw media URL',{status:401});if(kind==='big')return new Response('x'.repeat(131073));return response({candidates:[{content:{parts:[{functionCall:{name:'send'}}]}}]});}) as typeof fetch);
  const cache=new GeminiVideoCache();
  await assert.rejects(cache.watch('a','dm',kind,[0,5],'q',c,async()=>makeClip(),ctrl.signal));
  if(kind==='cancel')assert.equal(n,0);
  else {await assert.rejects(cache.watch('a','dm',kind,[0,5],'new q',c,async()=>makeClip()));assert.equal(n,1);}
 }
 const c=new GeminiVideoClient({...settings,timeout:5},(async(_u:any,i:any)=>new Promise((_ok,no)=>i.signal.addEventListener('abort',()=>no(new Error('SECRET raw URL'))))) as typeof fetch);
 await assert.rejects(new GeminiVideoCache().watch('a','dm','timeout',[0,5],'q',c,async()=>makeClip()),/timed out/);
});
test('invalid MIME, fingerprint, byte cache and coverage fail before provider',async()=>{
 let calls=0;const c=new GeminiVideoClient({...settings,cacheBytes:20},(async()=>{calls++;return response({});}) as typeof fetch);
 for(const patch of [{mime:'video/webm'},{fingerprint:'wrong'},{start:1},{end:61},{data:Buffer.alloc(21)}]){
  await assert.rejects(new GeminiVideoCache().watch('a','dm',JSON.stringify(patch),[0,5],'q',c,async()=>({...makeClip(),...patch}) as NativeClip));
 }assert.equal(calls,0);
});
test('native gate prefers watch only when explicitly selected; disabled stays existing tool',()=>{
 assert.equal(videoRequestGate(['https://youtu.be/H_Ab3nKZUfM']).step().toolChoice?.toolName,'inspect_video_url');
 assert.equal(videoRequestGate(['https://youtu.be/H_Ab3nKZUfM'],'watch_video').step().toolChoice?.toolName,'watch_video');
});

test('whole short config validates FPS, dimensions, maximum and forbids global HIGH',()=>{
 assert.equal(settings.runtime,60000);assert.throws(()=>geminiVideoSettings({...env,GEMINI_VIDEO_RUNTIME_SECONDS:'61'}));assert.equal(settings.maxShort,300);assert.equal(settings.fps,1);assert.equal(settings.dimension,360);assert.equal(settings.mediaResolution,'MEDIA_RESOLUTION_LOW');
 for(const patch of [{GEMINI_VIDEO_FPS:'0'},{GEMINI_VIDEO_FPS:'NaN'},{GEMINI_VIDEO_FPS:'2'},{GEMINI_VIDEO_DIMENSION:'640'},{GEMINI_VIDEO_MAX_SHORT_SECONDS:'301'},{GEMINI_VIDEO_MEDIA_RESOLUTION:'MEDIA_RESOLUTION_HIGH'}])assert.throws(()=>geminiVideoSettings({...env,...patch}));
 assert.equal(geminiVideoSettings({...env,GEMINI_VIDEO_FPS:'0.5',GEMINI_VIDEO_DIMENSION:'480'})!.fps,0.5);
});
test('automatic whole cache cannot reuse old five second or low variant for fine; fresh request same clip',async()=>{
 let extracts=0;const bodies:any[]=[];
 const c=new GeminiVideoClient(settings,(async(_u:any,i:any)=>{bodies.push(JSON.parse(i.body));return response({candidates:[{content:{parts:[{text:'verified evidence'}]}}]});}) as typeof fetch);
 const cache=new GeminiVideoCache();
 const whole=(dim=360)=>({...makeClip(),end:11,sourceDuration:11,fullSource:true,sourceFingerprint:'a'.repeat(64),fps:1,width:200,height:dim,frameCount:11,pipelineVersion:'whole-short-v2',encodedDuration:11,codec:'h264'});
 await cache.watch('a','dm','url',[0,5],'old clip',c,async()=>{extracts++;return makeClip();});
 const first=await cache.watch('a','dm','url',undefined,'whole?',c,async()=>{extracts++;return whole();});
 const follow=await cache.watch('a','dm','url',undefined,'new question',c,async()=>{throw new Error('must not download');});
 assert.equal(first.fullSource,true);assert.equal(follow.cachedClip,true);assert.deepEqual(first.coverage,[0,11]);assert.equal(extracts,2);
 const high=new GeminiVideoClient({...settings,dimension:480,mediaResolution:'MEDIA_RESOLUTION_HIGH'},(c as any).fetcher);
 await cache.watch('a','dm','url',undefined,'read fine text',high,async()=>{extracts++;return whole(480);});
 assert.equal(extracts,3);
 assert.deepEqual(bodies[1].contents[0].parts[0].videoMetadata,{fps:1});
 assert.equal(bodies[1].generationConfig.mediaResolution,'MEDIA_RESOLUTION_LOW');
 assert.equal(bodies[3].generationConfig.mediaResolution,'MEDIA_RESOLUTION_HIGH');
 assert.equal(bodies[1].contents[0].parts[0].videoMetadata.startOffset,undefined);
 assert.match(bodies[1].contents[0].parts[1].text,/Verified whole source/);
 assert.match(bodies[2].contents[0].parts[1].text,/new question/);
});
test('unknown or unverified full coverage rejected before any provider request',async()=>{
 let calls=0;const c=new GeminiVideoClient(settings,(async()=>{calls++;return response({});}) as typeof fetch);
 for(const patch of [{fullSource:false},{sourceDuration:12},{pipelineVersion:'old-5s'},{fps:0.5},{sourceFingerprint:''}]){
  await assert.rejects(new GeminiVideoCache().watch('a','dm','url',undefined,'whole?',c,async()=>({...makeClip(),end:11,fullSource:true,sourceDuration:11,fps:1,width:200,height:360,frameCount:11,sourceFingerprint:'a'.repeat(64),pipelineVersion:'whole-short-v2',...patch})));
 }assert.equal(calls,0);
});
