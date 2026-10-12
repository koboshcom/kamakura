import test from 'node:test';
import assert from 'node:assert/strict';
import {videoLimits,publicVideoURL,videoArtifacts,videoLinkTools} from '../src/video-link.js';
import {SandboxManager} from '../src/sandbox.js';
const limits=videoLimits({});
const frame=Buffer.from([255,216,1,255,217]).toString('base64');
const good={ok:true,frames:[frame],audio:null,seconds:5,transferBytes:5,start:0,processedSeconds:5,duration:60};
test('video defaults bounded and env caps fail closed',()=>{assert.equal(limits.frames,2);for(const [k,v] of [['VIDEO_LINK_INITIAL_FRAMES','99'],['VIDEO_LINK_INITIAL_SECONDS','0'],['VIDEO_LINK_MAX_BYTES','999999999'],['VIDEO_LINK_TIMEOUT_SECONDS','NaN']])assert.throws(()=>videoLimits({[k!]:v}));});
test('primary URL rejects credentials protocols control shell options ports',()=>{for(const url of ['file:///etc/passwd','ftp://example.com/x','https://a:b@example.com/x','https://example.com:22/x','https://example.com/\nx','--exec rm'])assert.throws(()=>publicVideoURL(url));assert.equal(publicVideoURL('https://example.com/watch?v=abc'),'https://example.com/watch?v=abc');});
test('copy boundary accepts only capped generated artifacts',()=>{assert.equal(videoArtifacts(JSON.stringify(good),{...limits,start:0,processedCap:60}).frames.length,1);for(const change of [{frames:Array(9).fill(frame)},{frames:['Li4vZXRjL3Bhc3N3ZA==']},{audio:'Li4vZXRjL3Bhc3N3ZA=='},{seconds:100},{transferBytes:limits.bytes+1},{ok:false},{frames:['!']}])assert.throws(()=>videoArtifacts(JSON.stringify({...good,...change}),{...limits,start:0,processedCap:60}));});
test('feature off and unbound Discord cannot obtain owner tool',()=>{const previous=process.env.VIDEO_LINK_ENABLED;process.env.VIDEO_LINK_ENABLED='true';try{assert.deepEqual(videoLinkTools({transport:'discord',senderId:'discord-1112392784117235752',chatId:'bogus',sender:'x',id:'1',text:'inspect',isGroup:false,timestamp:0}),{});}finally{if(previous===undefined)delete process.env.VIDEO_LINK_ENABLED;else process.env.VIDEO_LINK_ENABLED=previous;}});
test('unauthorized owner denied before box access',async()=>{const m=new SandboxManager({...({} as any),allowed:new Set(['42'])},{} as any);await assert.rejects(m.inspectVideo('43','https://example.com/x',limits),/not authorized/);});
test('owner serial API uses direct argv and clean environment, no caller shell',async()=>{
 const s={allowed:new Set(['42']),commandMs:30000,maxOutput:10} as any;
 const m=new SandboxManager(s,{} as any);const captured:any[]=[];
 (m as any).container=async(id:string)=>{assert.equal(id,'42');return {};};
 (m as any).execute=async(...args:any[])=>{captured.push(args);return {output:JSON.stringify(good),exitCode:0,timedOut:false,truncated:false};};
 const url="https://example.com/v?q=$(touch%20/tmp/no)";
 const data=await m.inspectVideo('42',url,{...limits,start:0,processedCap:60});
 assert.equal(data.frames.length,1);const argv=captured[0][3] as string[];
 assert.equal(captured[0][1],'');assert.equal(argv[0],'env');assert.equal(argv[1],'-i');
 assert.ok(!argv.includes('bash'));assert.ok(argv.includes('YTDLP_NO_PLUGINS=1'));
 const payload=JSON.parse(Buffer.from(argv.at(-1)!,'base64').toString());assert.equal(payload.url,url);
 assert.equal(payload.timeout,25);
 (m as any).execute=async()=>({output:JSON.stringify(good),exitCode:0,timedOut:false,truncated:true});
 await assert.rejects(m.inspectVideo('42',url,{...limits,start:0,processedCap:60}),/exceeded limits/);
});
test('authenticated owner tool returns frames only under explicit vision, no implicit STT',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');
 const env={enabled:process.env.VIDEO_LINK_ENABLED,vision:process.env.VISION_ENABLED};
 const old=(sandboxes as any).inspectVideo;const allowed=config.sandbox.allowed.has('42'),tg=config.telegramAllowed.has('42');
 process.env.VIDEO_LINK_ENABLED='true';process.env.VISION_ENABLED='true';config.sandbox.allowed.add('42');config.telegramAllowed.add('42');
 (sandboxes as any).inspectVideo=async(owner:string)=>{assert.equal(owner,'42');return {frames:[Buffer.from([255,216,1,255,217])],seconds:5,transferBytes:5,start:0,processedSeconds:5,duration:60};};
 try{
  const incoming={transport:'telegram' as const,chatId:'42',senderId:'42',id:'1',sender:'x',text:'inspect https://example.com/v',isGroup:false,timestamp:0};
  const t:any=videoLinkTools(incoming);assert.ok(t.inspect_video_url);
  const result=await t.inspect_video_url.execute({url:'https://example.com/v'},{});assert.equal(result.images.length,1);assert.match(result.text,/No audio stream/);
  process.env.VISION_ENABLED='false';
  const hidden=await t.inspect_video_url.execute({url:'https://example.com/v'},{});assert.equal(hidden.images.length,0);assert.match(hidden.text,/Vision disabled/);
  assert.deepEqual(videoLinkTools({...incoming,chatId:'43'}),{});
 }finally{(sandboxes as any).inspectVideo=old;if(!allowed)config.sandbox.allowed.delete('42');if(!tg)config.telegramAllowed.delete('42');for(const [key,value] of [['VIDEO_LINK_ENABLED',env.enabled],['VISION_ENABLED',env.vision]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
});
test('adaptive early-enough fixture consumes five seconds once; cached overlap, next, seek and unique merged',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');
 const {inspectionCache}=await import('../src/video-link.js');inspectionCache.entries.clear();
 const old=sandboxes.inspectVideo;config.sandbox.allowed.add('4242');config.telegramAllowed.add('4242');
 const previous=process.env.VIDEO_LINK_ENABLED;process.env.VIDEO_LINK_ENABLED='true';
 const calls:any[]=[];
 (sandboxes as any).inspectVideo=async(_owner:string,_url:string,limits:any)=>{calls.push(limits);return {frames:[Buffer.from([255,216,1,255,217])],seconds:limits.seconds,transferBytes:10,processedSeconds:limits.seconds,start:limits.start,duration:120};};
 const incoming={transport:'telegram' as const,chatId:'4242',senderId:'4242',id:'adaptive',sender:'x',text:'query',isGroup:false,timestamp:0};
 try{
  const tool:any=videoLinkTools(incoming).inspect_video_url;
  const first=await tool.execute({url:'https://example.com/adaptive'},{});const meta=JSON.parse(first.text.split('\n').at(-1));
  assert.deepEqual(calls.map(c=>[c.start,c.seconds,c.frames]),[[0,5,2]]);
  // Model answers from first result: no automatic continuation, download/STT/vision loop.
  assert.equal(calls.length,1);assert.equal(meta.usage.uniqueSeconds,5);
  await tool.execute({handle:meta.handle,start:0,end:5},{});assert.equal(calls.length,1);
  await tool.execute({url:'https://example.com/adaptive',start:3,end:8},{});assert.equal(calls.length,2);assert.equal(calls[1].start,5);assert.equal(calls[1].seconds,3);
  await tool.execute({handle:meta.handle,next:true},{});assert.equal(calls[2].start,8);
  await tool.execute({handle:meta.handle,timestamps:[60]},{});assert.equal(calls[3].start,60);
  await assert.rejects(tool.execute({handle:meta.handle,start:3599,end:3601},{}),/bound/);
  const other:any=videoLinkTools({...incoming,id:'other'}).inspect_video_url;
  await assert.rejects(other.execute({handle:meta.handle},{}),/owner\/session/);
 }finally{sandboxes.inspectVideo=old;config.sandbox.allowed.delete('4242');config.telegramAllowed.delete('4242');if(previous===undefined)delete process.env.VIDEO_LINK_ENABLED;else process.env.VIDEO_LINK_ENABLED=previous;}
});
test('opaque cache owner/session expiration cleans artifacts and prevents fresh URL handle reset',async()=>{
 const {InspectionCache}=await import('../src/video-link.js');let now=0;const c=new InspectionCache(()=>now);const session={};
 const entry=c.get('42',session,'https://example.com/v');entry.bytes=100;entry.cache.push({range:[0,5],text:'private',images:['private']});
 assert.equal(c.get('42',session,'https://example.com/v'),entry);
 assert.throws(()=>c.get('43',{},undefined,entry.handle),/owner\/session/);
 now=301000;c.sweep();assert.equal(c.entries.size,0);assert.equal(entry.cache.length,0);
 assert.throws(()=>c.get('42',session,'https://example.com/v'),/expired/);
 assert.throws(()=>c.get('42',session,undefined,entry.handle),/expired/);
});
test('merge overlapping coverage and missing intervals',async()=>{
 const {mergedRanges,missingRanges}=await import('../src/video-link.js');
 assert.deepEqual(mergedRanges([[0,5],[3,8],[60,61]]),[[0,8],[60,61]]);
 assert.deepEqual(missingRanges(2,10,[[0,5],[7,8]]),[[5,7],[8,10]]);
});
test('cumulative caps survive retries/new handle, STT uses only explicit part once and cached requests do not repeat',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');
 const keys=['VIDEO_LINK_ENABLED','VIDEO_LINK_MAX_UNIQUE_SECONDS','VIDEO_LINK_MAX_PROCESSED_SECONDS','VIDEO_LINK_MAX_FRAMES','VIDEO_LINK_MAX_BYTES','VIDEO_LINK_MAX_ATTEMPTS','VIDEO_LINK_TIMEOUT_SECONDS','OPENAI_TRANSCRIBE_BASE_URL','OPENAI_TRANSCRIBE_API_KEY','OPENAI_TRANSCRIBE_MODEL','OPENAI_API_KEY'];
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const old=sandboxes.inspectVideo,fetch=globalThis.fetch;
 config.sandbox.allowed.add('4343');config.telegramAllowed.add('4343');process.env.VIDEO_LINK_ENABLED='true';
 const input=(id:string)=>({transport:'telegram' as const,chatId:'4343',senderId:'4343',id,sender:'x',text:'query',isGroup:false,timestamp:0});
 let downloads=0,stt=0;const audio=Buffer.alloc(50);audio.write('RIFF');audio.write('WAVE',8);
 (sandboxes as any).inspectVideo=async(_:string,__:string,b:any)=>{downloads++;return {frames:[Buffer.from([255,216,1,255,217])],audio,seconds:b.seconds,transferBytes:10,processedSeconds:10,start:b.start,duration:100};};
 globalThis.fetch=async(input:any,init:any)=>{if(String(input).startsWith('data:'))return new Response();stt++;assert.match(String(input),/^https:\/\/stt\.example\/v1\/audio\/transcriptions/);assert.equal(new Headers(init.headers).get('authorization'),'Bearer stt-only');return new Response(JSON.stringify({text:'enough'}),{headers:{'content-type':'application/json'}});};
 try{
  process.env.OPENAI_TRANSCRIBE_BASE_URL='https://stt.example/v1';process.env.OPENAI_TRANSCRIBE_API_KEY='stt-only';process.env.OPENAI_TRANSCRIBE_MODEL='explicit-model';process.env.OPENAI_API_KEY='must-not-use';
  const tool:any=videoLinkTools(input('stt')).inspect_video_url;
  await tool.execute({url:'https://example.com/stt'},{});assert.equal(stt,1);assert.equal(downloads,1);
  await tool.execute({url:'https://example.com/stt'},{});assert.equal(stt,1);assert.equal(downloads,1);
  delete process.env.OPENAI_TRANSCRIBE_API_KEY;
  const missing:any=videoLinkTools(input('missing')).inspect_video_url;const response=await missing.execute({url:'https://example.com/missing'},{});assert.match(response.text,/No fallback/);assert.equal(stt,1);
  for(const [key,value] of [['VIDEO_LINK_MAX_UNIQUE_SECONDS','5'],['VIDEO_LINK_MAX_PROCESSED_SECONDS','10'],['VIDEO_LINK_MAX_FRAMES','1'],['VIDEO_LINK_MAX_BYTES','10'],['VIDEO_LINK_MAX_ATTEMPTS','1']]){
   process.env[key!]=value;const caps:any=videoLinkTools(input(key!)).inspect_video_url;
   await caps.execute({url:'https://example.com/cap'+key},{});
   await assert.rejects(caps.execute({url:'https://example.com/cap'+key,next:true},{}),/limit|budget/);
   if(env[key!]===undefined)delete process.env[key!];else process.env[key!]=env[key!];
  }
  const failed:any=videoLinkTools(input('fail')).inspect_video_url;(sandboxes as any).inspectVideo=async()=>{throw new Error('fake timeout');};
  await assert.rejects(failed.execute({url:'https://example.com/fail'},{}),/fake timeout/);
  await assert.rejects(failed.execute({url:'https://example.com/fail'},{}),/not reset/);
 }finally{sandboxes.inspectVideo=old;globalThis.fetch=fetch;config.sandbox.allowed.delete('4343');config.telegramAllowed.delete('4343');for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
});
test('cumulative wall timeout and cache limits remain fail closed on new handle attempt',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');
 const old=sandboxes.inspectVideo,now=Date.now;const env={enabled:process.env.VIDEO_LINK_ENABLED,timeout:process.env.VIDEO_LINK_TIMEOUT_SECONDS,cache:process.env.VIDEO_LINK_CACHE_BYTES};
 config.sandbox.allowed.add('4545');config.telegramAllowed.add('4545');process.env.VIDEO_LINK_ENABLED='true';process.env.VIDEO_LINK_TIMEOUT_SECONDS='3';
 let clock=now();Date.now=()=>clock;
 const incoming={transport:'telegram' as const,chatId:'4545',senderId:'4545',id:'wall',sender:'x',text:'query',isGroup:false,timestamp:0};
 (sandboxes as any).inspectVideo=async(_:string,__:string,b:any)=>{clock+=4000;return {frames:[Buffer.from([255,216,1,255,217])],seconds:b.seconds,start:b.start,processedSeconds:10,transferBytes:10,duration:100};};
 try{
  const tool:any=videoLinkTools(incoming).inspect_video_url;
  await assert.rejects(tool.execute({url:'https://example.com/wall'},{}),/wall time/);
  await assert.rejects(tool.execute({url:'https://example.com/wall'},{}),/not reset/);
  Date.now=now;process.env.VIDEO_LINK_CACHE_BYTES='1';(sandboxes as any).inspectVideo=async(_:string,__:string,b:any)=>({frames:[Buffer.from([255,216,1,255,217])],seconds:b.seconds,start:b.start,processedSeconds:10,transferBytes:10,duration:100});
  const cache:any=videoLinkTools({...incoming,id:'cache'}).inspect_video_url;
  await assert.rejects(cache.execute({url:'https://example.com/cache'},{}),/cache bytes/);
  await assert.rejects(cache.execute({url:'https://example.com/cache'},{}),/not reset/);
 }finally{Date.now=now;sandboxes.inspectVideo=old;config.sandbox.allowed.delete('4545');config.telegramAllowed.delete('4545');for(const [k,v] of [['VIDEO_LINK_ENABLED',env.enabled],['VIDEO_LINK_TIMEOUT_SECONDS',env.timeout],['VIDEO_LINK_CACHE_BYTES',env.cache]])if(v===undefined)delete process.env[k!];else process.env[k!]=v;}
});
test('whole-file fallback mode is explicit, format validated, only requested range reaches STT',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');const env=process.env.VIDEO_LINK_ENABLED,old=sandboxes.inspectVideo;
 config.sandbox.allowed.add('4646');config.telegramAllowed.add('4646');process.env.VIDEO_LINK_ENABLED='true';
 (sandboxes as any).inspectVideo=async(_:string,__:string,b:any)=>({frames:[Buffer.from([255,216,1,255,217])],seconds:b.seconds,start:b.start,processedSeconds:20,transferBytes:1200,duration:100,downloadMode:'whole-file-bandwidth-capped-fallback',sourceFormat:{protocol:'https',ext:'mp4',formatId:'small'}});
 try{
  const tool:any=videoLinkTools({transport:'telegram',chatId:'4646',senderId:'4646',id:'fallback',sender:'x',text:'query',isGroup:false,timestamp:0}).inspect_video_url;
  const result=await tool.execute({url:'https://example.com/fallback'},{});assert.match(result.text,/Whole source transfer fallback/);assert.match(result.text,/0-5 seconds/);assert.match(result.text,/1200/);
  const limits={seconds:5,frames:2,bytes:4000,timeout:25,start:0,processedCap:60};
  const response={ok:true,frames:[Buffer.from([255,216,1,255,217]).toString('base64')],seconds:5,start:0,processedSeconds:20,transferBytes:1200,duration:100,downloadMode:'whole-file-bandwidth-capped-fallback',sourceFormat:{protocol:'https',ext:'mp4'}};
  assert.equal(videoArtifacts(JSON.stringify(response),limits).downloadMode,'whole-file-bandwidth-capped-fallback');
  assert.throws(()=>videoArtifacts(JSON.stringify({...response,downloadMode:'pretend-partial'}),limits),/mode/);
 }finally{sandboxes.inspectVideo=old;config.sandbox.allowed.delete('4646');config.telegramAllowed.delete('4646');if(env===undefined)delete process.env.VIDEO_LINK_ENABLED;else process.env.VIDEO_LINK_ENABLED=env;}
});
