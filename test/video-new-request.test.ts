import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVideoURL,newVideoURLs,videoRequestGate} from '../src/video-url.js';
import {videoTitleGuidance} from '../src/video-title-policy.js';
const short='https://youtu.be/H_Ab3nKZUfM';
test('bare tracked short link after quiet conversation is a new URL, not old handle',()=>{
 const urls=newVideoURLs(short+'?si=mN1bKIrIX0aNbavb\nWhat about this');
 assert.deepEqual(urls,['https://www.youtube.com/watch?v=H_Ab3nKZUfM']);
 const gate=videoRequestGate(urls);
 assert.equal(gate.step().toolChoice?.toolName,'inspect_video_url');
 assert.match(gate.instructions(),/not an old handle/);
});
test('YouTube canonical identity drops playlist time and tracking per owner',()=>{
 assert.equal(normalizeVideoURL(short+'?si=abc&t=34&list=PLx&sig=secret'), 'https://www.youtube.com/watch?v=H_Ab3nKZUfM');
 const signed='https://cdn.example/a.mp4?si=signed&signature=abc&expires=5';
 assert.equal(normalizeVideoURL(signed),signed);
 assert.equal(normalizeVideoURL('https://www.youtube.com/watch?v=H_Ab3nKZUfM&si=abc&t=10'),'https://www.youtube.com/watch?v=H_Ab3nKZUfM&t=10');
});
test('silence save only quote and malformed inputs do not force inspection',()=>{
 for(const text of ["don't inspect "+short,'save this link '+short,'stay silent '+short,'> '+short,'https://youtu.be/nope','https://youtu.be.evil/H_Ab3nKZUfM','https://user:pass@youtu.be/H_Ab3nKZUfM','https://www.youtube.com/','thanks'])assert.deepEqual(newVideoURLs(text),[],text);
});
test('gate refuses old handle/current mismatch but permits followup after real attempt, including honest error',async()=>{
 const gate=videoRequestGate(newVideoURLs(short));
 await assert.rejects(gate.inspect(undefined,async()=>({ok:true})),/current new URL/);
 await assert.rejects(gate.inspect('https://youtu.be/3-4xv2jKc9U',async()=>({ok:true})),/current new URL/);
 assert.equal(gate.pending,true);
 assert.deepEqual(await gate.inspect(short+'?si=abc',async()=>({ok:false,error:'blocked'})),{ok:false,error:'blocked'});
 assert.equal(gate.pending,false);assert.deepEqual(gate.step(),{});
 assert.equal(await gate.inspect(undefined,async()=>42),42);
});
test('throwing inspection releases gate to report blocker rather than loop',async()=>{
 const gate=videoRequestGate(newVideoURLs(short));
 await assert.rejects(gate.inspect(short,async()=>{throw Error('unavailable');}),/unavailable/);
 assert.equal(gate.pending,false);
});
test('title policy separates title kinds and requires verified official source, no hardcoded title',()=>{
 assert.match(videoTitleGuidance,/original publisher metadata title exactly/);
 assert.match(videoTitleGuidance,/rough translation/);assert.match(videoTitleGuidance,/web_search/);
 assert.match(videoTitleGuidance,/song title, artist/);assert.match(videoTitleGuidance,/unknown/);
 assert.doesNotMatch(videoTitleGuidance,/Love Unseen|Transparent Night/);
});

test('video arriving during old generation suppresses stale delivery without blanket text dedup',async()=>{
 const {ReplyBatches}=await import('../src/batching.js');
 let release!:()=>void,start!:()=>void;const held=new Promise<void>(r=>{release=r;});const ready=new Promise<void>(r=>{start=r;});
 const sent:string[]=[];let count=0;
 const queue=new ReplyBatches(1,4096,async(m,current,delivered)=>{
  count++;if(count===1){start();await held;}
  if(current()){sent.push(newVideoURLs(m.text).length?'video request':'quiet company, then.');delivered?.();}
 },()=>{},e=>{throw e;});
 const message=(id:string,text:string)=>({transport:'discord' as const,chatId:'private-test',senderId:'isolated-test',sender:'test',id,text,timestamp:1,isGroup:false});
 try{queue.receive(message('1','quiet evening'));await ready;queue.receive(message('2',short+'?si=abc'));queue.receive(message('3','What about this'));release();await new Promise(r=>setTimeout(r,30));assert.deepEqual(sent,['video request']);queue.receive(message('4','quiet evening'));await new Promise(r=>setTimeout(r,30));queue.receive(message('5','quiet evening'));await new Promise(r=>setTimeout(r,30));assert.deepEqual(sent,['video request','quiet company, then.','quiet company, then.']);}
 finally{release();queue.stop();}
});
test('diagnostic correlation is stable, isolated and content-free',async()=>{
 const {turnFields}=await import('../src/turn-trace.js');
 const m={transport:'discord' as const,chatId:'private-chat-id',senderId:'owner-secret',sender:'private-name',id:'private-message-id',text:'secret-content',timestamp:4,isGroup:false};
 const a=turnFields(m);assert.deepEqual(turnFields({...m}),a);
 assert.notEqual(turnFields({...m,id:'next'}).turnId,a.turnId);
 assert.notEqual(turnFields({...m,chatId:'different'}).turnId,a.turnId);
 const raw=JSON.stringify(a);for(const v of ['private-chat-id','owner-secret','private-name','private-message-id','secret-content'])assert.ok(!raw.includes(v));
});
