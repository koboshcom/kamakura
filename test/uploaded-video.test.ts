import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {prepareIncomingMedia} from '../src/media.js';
import {inspectionCache,videoLinkTools} from '../src/video-link.js';
import {bindDiscordDM} from '../src/discord-dm-context.js';
import type {IncomingMessage} from '../src/types.js';
const owner='42',account='1112392784117235752',jpg=Buffer.from([255,216,1,255,217]);
test('all three transports share first5s two frames; stop performs no further work, next/seek/overlap and owner-channel isolation',async()=>{
 const old={stage:sandboxes.stageVideoUpload,inspect:sandboxes.inspectVideo,remove:sandboxes.removeVideoUpload};
 const env={enabled:process.env.VIDEO_LINK_ENABLED,vision:process.env.VISION_ENABLED};
 const allowed=config.sandbox.allowed.has(owner),tg=config.telegramAllowed.has(owner);
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);process.env.VIDEO_LINK_ENABLED='true';process.env.VISION_ENABLED='true';
 let staged=0,removed=0;const calls:any[]=[];
 sandboxes.stageVideoUpload=async(_,data)=>({id:(++staged).toString(16).padStart(48,'0'),sha256:'a'.repeat(64),bytes:data.length});
 sandboxes.removeVideoUpload=async()=>{removed++;};
 sandboxes.inspectVideo=async(id,url,limits,upload)=>{assert.equal(id,owner);assert.equal(url,'');assert.ok(upload);calls.push(limits);return {frames:[jpg,jpg],seconds:limits.seconds,start:limits.start,processedSeconds:limits.seconds*2,transferBytes:0,duration:60,downloadMode:'local-upload'};};
 try{
 for(const transport of ['telegram','whatsapp','discord'] as const){
  const message:IncomingMessage={transport,chatId:transport==='telegram'?owner:transport==='discord'?'dm:'+account:'15555555555@s.whatsapp.net',senderId:owner,sender:'fixture',id:transport,text:'describe',isGroup:false,timestamp:0,authenticatedOwner:true,...(transport==='discord'?{authenticatedAccountId:account}:{})};
  if(transport==='discord')bindDiscordDM(message,account,owner,()=>true);
  const before=calls.length;
  const prepared=await prepareIncomingMedia([{kind:'video',mime:'video/mp4',data:Buffer.from('offlinefixture')}],()=>true,message);
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).seconds,5);assert.equal(calls.at(-1).frames,2);assert.equal(prepared.images.length,2);
  const handle=JSON.parse(prepared.text.split('\n').at(-1)!).handle;
  const cached=await prepareIncomingMedia([{kind:'video',mime:'video/mp4',data:Buffer.from('offlinefixture')}],()=>true,message);
  assert.equal(calls.length,before+1);assert.match(cached.text,new RegExp(handle));
  const another={...message,id:'next'};
  if(transport==='discord')bindDiscordDM(another,account,owner,()=>true);
  const tool:any=videoLinkTools(another);
  await tool.inspect_video_url.execute({handle,start:0,end:5},{});assert.equal(calls.length,before+1);
  await tool.inspect_video_url.execute({handle,next:true},{});assert.equal(calls.at(-1).start,5);
  await tool.inspect_video_url.execute({handle,timestamps:[20]},{});assert.equal(calls.at(-1).seconds,1);
  const entry=inspectionCache.entries.get(handle)!;assert.equal(entry.frames,6);assert.equal(entry.bytes,14);assert.deepEqual(entry.ranges,[[0,10],[20,21]]);
  const wrong={...message,chatId:'different'};
  assert.throws(()=>inspectionCache.resolve(owner,wrong,undefined,handle),/channel/);
  assert.throws(()=>inspectionCache.resolve('43',message,undefined,handle),/owner/);
  const own=entry.upload!;entry.expires=0;inspectionCache.sweep();await new Promise(resolve=>setImmediate(resolve));assert.ok(removed>0);
  await assert.rejects(tool.inspect_video_url.execute({handle,next:true},{}),/expired|unavailable/);
  assert.ok(own.id);
 }
 const unauth={transport:'discord' as const,chatId:'dm:'+account,senderId:owner,sender:'fixture',authenticatedOwner:true,authenticatedAccountId:account,id:'forged',text:'x',isGroup:false,timestamp:0};
 const count=staged;
 const denied=await prepareIncomingMedia([{kind:'video',mime:'video/mp4',data:Buffer.from('x')}],()=>true,unauth);
 assert.equal(staged,count);assert.match(denied.text,/unavailable/);
 }finally{
 Object.assign(sandboxes,{stageVideoUpload:old.stage,inspectVideo:old.inspect,removeVideoUpload:old.remove});
 if(!allowed)config.sandbox.allowed.delete(owner);if(!tg)config.telegramAllowed.delete(owner);
 for(const [key,val] of [['VIDEO_LINK_ENABLED',env.enabled],['VISION_ENABLED',env.vision]])if(val===undefined)delete process.env[key!];else process.env[key!]=val;
 inspectionCache.entries.clear();
 }
});
