import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {videoLinkTools} from '../src/video-link.js';
test('actual watch_video fresh exact question, owner/channel URL cache, handle checks and frame fallback',async()=>{
 const env={...process.env},fetcher=globalThis.fetch,extract=sandboxes.nativeVideoClip,inspect=sandboxes.inspectVideo;
 const owner='gemini-owner-fixture'; // numeric owner remains required for Telegram.
 const id='767676';config.sandbox.allowed.add(id);config.telegramAllowed.add(id);
 process.env.VIDEO_LINK_ENABLED='true';process.env.GEMINI_VIDEO_BASE_URL='https://native.example';process.env.GEMINI_VIDEO_KEY='fixture-private';process.env.GEMINI_VIDEO_MODEL='explicit-native';
 let extracted=0,generated=0,questions:string[]=[];
 const data=Buffer.alloc(16);data.write('ftyp',4);
 sandboxes.nativeVideoClip=async(o,_url,b)=>{assert.equal(o,id);extracted++;return {data:Buffer.from(data),mime:'video/mp4',start:b.start!,end:b.start!+b.seconds,transferBytes:20,processedSeconds:10,fingerprint:createHash('sha256').update(data).digest('hex')};};
 globalThis.fetch=async(_url,init)=>{generated++;questions.push(JSON.parse(String(init?.body)).contents[0].parts[1].text);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'bounded evidence'}]}}]}));};
 const incoming={transport:'telegram' as const,chatId:id,senderId:id,sender:'owner',id:'1',text:'What do you think?',isGroup:false,timestamp:0};
 try{
  const first:any=videoLinkTools(incoming);assert.ok(first.watch_video);
  await assert.rejects(first.watch_video.execute({url:'https://example.com/native-fixture.mp4',question:'generic overview'}),/actual latest/);
  assert.equal(generated,0);
  const a=await first.watch_video.execute({url:'https://example.com/native-fixture.mp4',question:incoming.text});
  const follow:any=videoLinkTools({...incoming,id:'2',text:'Is the height actually verified?'});
  const b=await follow.watch_video.execute({handle:a.handle,question:'Is the height actually verified?'});
  assert.equal(a.sourceFingerprint,b.sourceFingerprint);assert.equal(b.cachedClip,true);assert.equal(extracted,1);assert.equal(generated,2);assert.match(questions[1]!,/Is the height/);
  const other:any=videoLinkTools({...incoming,chatId:'not-authorized'});assert.equal(other.watch_video,undefined);
  const frames:any=videoLinkTools({...incoming,id:'3'});sandboxes.inspectVideo=async(_o,_u,b)=>({frames:[Buffer.from([255,216,1,255,217])],seconds:b.seconds,transferBytes:5,processedSeconds:5,start:b.start!,duration:30});
  await frames.inspect_video_url.execute({handle:a.handle,start:0,end:5,framesOnly:true,n:2});
  assert.equal(extracted,1);
  await assert.rejects(follow.watch_video.execute({handle:a.handle,question:'Is the height actually verified?',start:0,end:6}),/range limit/);
  delete process.env.GEMINI_VIDEO_KEY;assert.equal((videoLinkTools(incoming) as any).watch_video,undefined);
 }finally{
  globalThis.fetch=fetcher;sandboxes.nativeVideoClip=extract;sandboxes.inspectVideo=inspect;config.sandbox.allowed.delete(id);config.telegramAllowed.delete(id);
  for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);
 }
});
