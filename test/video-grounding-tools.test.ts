import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
process.env.GEMINI_VIDEO_GOOGLE_SEARCH='true';process.env.DESKTOP_PUBLIC_BASE_URL='https://fixture-result.example';process.env.NOVNC_PUBLIC_URL='https://fixture-result.example';
const {config}=await import('../src/config.js');
const {sandboxes}=await import('../src/sandbox.js');
const {HistoryStore}=await import('../src/history.js');
const {chatTools}=await import('../src/chat-tools.js');
const {videoLinkTools}=await import('../src/video-link.js');
const {groundingPages,desktopAccess}=await import('../src/desktop-service.js');
test('actual watch_video used-only result link, owner tool checks and explicit fake send, no plaintext leakage',async()=>{
 const original=globalThis.fetch,extract=sandboxes.nativeVideoClip,env={...process.env};const owner='969696';
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);process.env.VIDEO_LINK_ENABLED='true';process.env.GEMINI_VIDEO_KEY='fixture-secret';process.env.GEMINI_VIDEO_BASE_URL='https://fixture-google.example';process.env.GEMINI_VIDEO_MODEL='explicit-fixture';
 const b=Buffer.alloc(16);b.write('ftyp',4);
 sandboxes.nativeVideoClip=async()=>({data:Buffer.from(b),mime:'video/mp4',start:0,end:11,transferBytes:10,processedSeconds:22,fingerprint:createHash('sha256').update(b).digest('hex'),sourceFingerprint:'b'.repeat(64),sourceDuration:11,fullSource:true,fps:1,width:200,height:360,frameCount:11,encodedDuration:11,codec:'h264',pipelineVersion:'whole-short-v2'});
 let n=0;
 globalThis.fetch=async()=>{n++;return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'NEVER DISCLOSE GROUNDED ANSWER'}]},...(n===1?{groundingMetadata:{webSearchQueries:['example'],searchEntryPoint:{renderedContent:'<a href="https://www.google.com/search?q=example">Search</a>'}}}:n===3?{groundingMetadata:{webSearchQueries:['example']}}:{})}]}));};
 const incoming={transport:'telegram' as const,chatId:owner,senderId:owner,sender:'owner',id:'1',text:'What happens?',isGroup:false,timestamp:0};
 try{
  const a:any=await (videoLinkTools(incoming) as any).watch_video.execute({url:'https://example.com/clip.mp4',question:incoming.text});
  assert.equal(a.searchUsed,true);assert.match(a.resultURL,/https:\/\/fixture-result.example\/video-result\/[a-f0-9]{64}/);assert(!JSON.stringify(a).includes('NEVER DISCLOSE'));assert.equal(a.search,undefined);assert.equal(a.original,undefined);
  const sent:string[]=[];const tools=chatTools(incoming,new HistoryStore(config.dataDir),{send:async text=>{sent.push(text);},react:async()=>{},current:()=>true},[],()=>{});
  assert.deepEqual(sent,[]);await tools.send_message.execute!({text:'Original research result '+a.resultURL},{toolCallId:'fake-only',messages:[]});assert.equal(sent.length,1);assert(sent[0]!.includes(a.resultURL));assert(!sent[0]!.includes('NEVER DISCLOSE'));
  const next={...incoming,id:'2',text:'Follow up'};const b:any=await (videoLinkTools(next) as any).watch_video.execute({handle:a.handle,question:next.text});assert.equal(b.searchUsed,false);assert.equal(b.resultURL,undefined);
  const third={...incoming,id:'3',text:'Another follow up'};const c:any=await (videoLinkTools(third) as any).watch_video.execute({handle:a.handle,question:third.text});assert.equal(c.searchUsed,true);assert.equal(c.searchDisplayIncomplete,true);assert.equal(c.resultURL,undefined);assert(!JSON.stringify(c).includes('NEVER DISCLOSE'));
  config.sandbox.allowed.add('979797');config.telegramAllowed.add('979797');const other={...incoming,chatId:'979797',senderId:'979797'};await assert.rejects((videoLinkTools(other) as any).watch_video.execute({handle:a.handle,question:other.text}));
 }finally{globalThis.fetch=original;sandboxes.nativeVideoClip=extract;Object.assign(process.env,env);groundingPages?.close();desktopAccess?.close();config.sandbox.allowed.delete(owner);config.telegramAllowed.delete(owner);config.sandbox.allowed.delete('979797');config.telegramAllowed.delete('979797');}
});
