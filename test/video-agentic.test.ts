import test from 'node:test';
import assert from 'node:assert/strict';
import {captionSegments,searchSegments,segment} from '../src/video-transcript.js';
import {videoLinkTools,inspectionCache,overviewConfig} from '../src/video-link.js';
import {sandboxes} from '../src/sandbox.js';
import {config} from '../src/config.js';
test('bounded caption parsing stable IDs provenance literal/token search no fabricated speech',()=>{
 const meta={captions:{tracks:[{format:'vtt',source:'automatic',language:'en',text:'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<b>Hello</b> cat\n\n00:00:07.000 --> 00:00:09.000\nBlue shirt\n'}]}};
 const cues=captionSegments(meta);assert.equal(cues.length,2);assert.equal(cues[0]!.start,1);assert.equal(cues[0]!.source,'automatic captions');assert.equal(cues[0]!.id,captionSegments(meta)[0]!.id);
 assert.equal(searchSegments(cues,'hello')[0]!.text,'Hello cat');assert.deepEqual(searchSegments(cues,'absent'),[]);
 assert.equal(searchSegments(Array(20).fill(cues[0]),'cat').length,8);
 assert.deepEqual(captionSegments({captions:{tracks:[{format:'vtt',text:'bad'}]}}),[]);
 assert.match(segment(4,9,'hi','spoken STT').timing,/no exact timestamps/);
 for(const val of ['NaN','0','2'])assert.throws(()=>overviewConfig({VIDEO_SCENE_THRESHOLD:val}));
});
test('actual registered agentic tools owner/session checks shared budgets n and no STT repeated cache',async()=>{
 const keys=['VIDEO_LINK_ENABLED','VISION_ENABLED'];const saved=keys.map(k=>process.env[k]);const old=sandboxes.inspectVideo;
 const owner='4747';config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);process.env.VIDEO_LINK_ENABLED='true';process.env.VISION_ENABLED='true';
 const calls:any[]=[];const frame=Buffer.from([255,216,1,255,217]);
 (sandboxes as any).inspectVideo=async(_o:string,_u:string,l:any)=>{calls.push(l);return {frames:Array(l.overview?1:l.frames).fill(frame),seconds:l.seconds,transferBytes:10,processedSeconds:l.seconds,start:l.start,duration:90,frameTimes:[l.start],metadata:{captions:{status:'available',tracks:[{format:'vtt',source:'manual',language:'en',text:'WEBVTT\n\n00:00:20.000 --> 00:00:21.000\nkitty\n'}]}}};};
 const input={transport:'telegram' as const,chatId:owner,senderId:owner,id:'a',sender:'x',text:'video',isGroup:false,timestamp:0};
 try {
  const tools:any=videoLinkTools(input);assert.ok(tools.search_transcript);assert.ok(tools.get_frames);
  const initial=await tools.inspect_video_url.execute({url:'https://example.com/video'},{});const handle=JSON.parse(initial.text.split('\n').at(-1)).handle;
  const hit=await tools.search_transcript.execute({handle,query:'kitty'},{});assert.equal(hit.status,'matches');assert.equal(hit.segments[0].start,20);
  assert.equal((await tools.search_transcript.execute({handle,query:'missing'},{})).status,'no_match');assert.equal(calls.length,1);
  const result=await tools.get_frames.execute({handle,start:20,end:23,n:3},{});assert.equal(calls[1].frames,3);assert.equal(calls[1].noAudio,true);assert.equal(calls[1].scene,true);assert.equal(result.images.length,3);
  await tools.get_frames.execute({handle,start:20,end:23,n:3},{});assert.equal(calls.length,2);
  await assert.rejects(tools.get_frames.execute({handle,start:20,end:30,n:3},{}),/bound/);
  const clone:any=videoLinkTools({...input,id:'b'});await assert.rejects(clone.search_transcript.execute({handle,query:'kitty'},{}),/owner\/session/);
  const e=inspectionCache.entries.get(handle)!;e.transcript=[];e.metadata=undefined;
  assert.equal((await tools.search_transcript.execute({handle,query:'kitty'},{})).status,'unavailable');
  e.expires=0;await assert.rejects(tools.search_transcript.execute({handle,query:'kitty'},{}),/expired/);
 }finally{sandboxes.inspectVideo=old;config.sandbox.allowed.delete(owner);config.telegramAllowed.delete(owner);keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
});
