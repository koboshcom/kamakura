import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { think, reminders } from '../src/brain.js';
import { config } from '../src/config.js';
import { HistoryStore } from '../src/history.js';
import { measureTurn, type TurnTiming } from '../src/latency.js';
import { mongo } from '../src/mongo.js';

test('isolated actual think path measures prompt, model, Mongo-backed tool and delivery without leaking content',async()=>{
 const originalFetch=globalThis.fetch,key=process.env.OPENAI_API_KEY,metrics=config.latencyMetrics,fast=config.fastModel;
 config.latencyMetrics=true;config.fastModel='';process.env.OPENAI_API_KEY='fixture-only';
 const incoming={transport:'telegram' as const,chatId:'latency-fixture-owner',senderId:'latency-fixture-owner',sender:'owner',id:'1',text:'list my reminders',timestamp:0,isGroup:false};
 const history=new HistoryStore(config.dataDir,10);
 let calls=0,timing:TurnTiming|undefined;const sent:string[]=[];
 try{
 assert.match((await mongo()).databaseName,/^kamakura_test_/);
 await history.add('telegram:'+incoming.chatId,{role:'user',id:'1',senderId:incoming.senderId,text:incoming.text,at:1});
 globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));
   assert.match(JSON.stringify(body.input),/Runtime rules/);
   const first=calls++===0;
   if(!first){
     assert.ok(body.input.some((part:{type:string;call_id:string})=>part.type==='function_call_output'&&part.call_id==='reminders'));
   }
   await new Promise(r=>setTimeout(r,8));
   return new Response(JSON.stringify({id:'fixture-'+calls,created_at:1,model:'fixture',status:'completed',
    output:[{type:'function_call',id:'fc-'+calls,call_id:first?'reminders':'send',name:first?'list_reminders':'send_message',arguments:first?'{}':JSON.stringify({text:'no pending reminders',purpose:'chat',finish_turn:true}),status:'completed'}],
    usage:{input_tokens:10,output_tokens:3,total_tokens:13,...(!first?{input_tokens_details:{cached_tokens:0}}:{})}}),{headers:{'content-type':'application/json'}});
 };
 await measureTurn(12,async()=>{
   assert.equal(await think(await history.get('telegram:'+incoming.chatId),incoming,undefined,undefined,{history,delivery:{
     current:()=>true,send:async text=>{await new Promise(r=>setTimeout(r,5));sent.push(text);}
   }}),'');
 },value=>{timing=value;});
 assert.deepEqual(sent,['no pending reminders']);assert.equal(calls,2);
 assert.equal(timing!.failed,false);assert.ok(timing!.promptBuildMs>0);assert.equal(timing!.model.length,2);
 assert.ok(timing!.model.every(m=>m.totalMs>0&&m.firstContentMs===null&&m.firstProviderEventMs===null));
 assert.equal(timing!.model[0]!.cacheReadTokens,null);assert.equal(timing!.model[1]!.cacheReadTokens,0);
 assert.equal(timing!.toolMs.length,2);assert.equal(timing!.sendMs.length,1);
 assert.ok(timing!.toolMs.every(ms=>ms>=0));assert.ok(timing!.sendMs[0]!>=4);
 assert.ok(timing!.totalMs>=timing!.promptBuildMs+12);
 assert.ok(!/latency-fixture-owner|no pending reminders|list my reminders|fixture-only/.test(JSON.stringify(timing)));
 if(process.env.LATENCY_THINK_REPORT)writeFileSync(process.env.LATENCY_THINK_REPORT,JSON.stringify({kind:'synthetic provider actual think path, isolated Mongo, not real-provider speed evidence',timing},null,2));
 }finally{globalThis.fetch=originalFetch;config.latencyMetrics=metrics;config.fastModel=fast;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;await reminders.close();}
});
