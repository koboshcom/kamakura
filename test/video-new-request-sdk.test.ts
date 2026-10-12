import test from 'node:test';
import assert from 'node:assert/strict';
import {think,reminders} from '../src/brain.js';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {closeMongo} from '../src/mongo.js';
import type {HistoryStore} from '../src/history.js';
test('SDK sees current short URL as first forced tool after quiet history, sends only after inspection',async()=>{
 const original=globalThis.fetch,inspect=sandboxes.inspectVideo;
 const enabled=process.env.VIDEO_LINK_ENABLED;process.env.VIDEO_LINK_ENABLED='true';
 const owner='454545';config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);
 const incoming={transport:'telegram' as const,chatId:owner,senderId:owner,sender:'owner',id:'new-link',text:'https://youtu.be/H_Ab3nKZUfM?si=share\nWhat about this',timestamp:2,isGroup:false};
 const events:string[]=[];let phase=0;
 sandboxes.inspectVideo=async(_owner,url,bounds)=>{
  assert.equal(url,'https://www.youtube.com/watch?v=H_Ab3nKZUfM');
  events.push('inspect');
  return {frames:[Buffer.from([255,216,1,255,217])],seconds:bounds.seconds,transferBytes:5,processedSeconds:5,start:0,duration:90,metadata:{title:'Original publisher title',captions:{status:'unavailable'}}};
 };
 const response=(name:string,args:unknown)=>new Response(JSON.stringify({id:'resp_fixture',created_at:1,model:config.model,status:'completed',output:[{type:'function_call',id:'fc_'+phase,call_id:'call_'+phase,name,arguments:JSON.stringify(args),status:'completed'}],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 try{
  globalThis.fetch=async(_url,init)=>{
   phase++;const body=JSON.parse(String(init?.body));
   if(phase===1){
    assert.deepEqual(body.tools.map((x:{name:string})=>x.name),['inspect_video_url']);
    assert.equal(body.tool_choice.name,'inspect_video_url');
    assert.match(JSON.stringify(body.input),/CURRENT NEW VIDEO REQUEST/);
    return response('inspect_video_url',{url:'https://youtu.be/H_Ab3nKZUfM?si=share'});
   }
   assert.deepEqual(events.slice(0,1),['inspect']);
   if(phase===2)return response('send_message',{text:'the publisher calls it Original publisher title',purpose:'answer',finish_turn:true});
   return response('end_turn',{});
  };
  await think([{role:'assistant',text:'quiet company, then.',at:1}],incoming,undefined,undefined,{history:{} as HistoryStore,delivery:{current:()=>true,send:async text=>{events.push(text);}}});
  assert.deepEqual(events,['inspect','the publisher calls it Original publisher title']);
 }finally{
  globalThis.fetch=original;sandboxes.inspectVideo=inspect;config.sandbox.allowed.delete(owner);config.telegramAllowed.delete(owner);if(enabled===undefined)delete process.env.VIDEO_LINK_ENABLED;else process.env.VIDEO_LINK_ENABLED=enabled;
  await reminders.close();sandboxes.stop();await closeMongo();
 }
});
