import test from 'node:test';
import assert from 'node:assert/strict';
import { think, reminders } from '../src/brain.js';
import { config } from '../src/config.js';
import { sandboxes } from '../src/sandbox.js';
import { closeMongo } from '../src/mongo.js';
import type { HistoryStore } from '../src/history.js';
test('actual SDK quick work is available first; premature end after progress continues within same turn',async()=>{
 const original=globalThis.fetch;const run=sandboxes.run;const auth=sandboxes.authorized;const key=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY='test-key';sandboxes.authorized=()=>true;config.telegramAllowed.add('6612253937');
 const incoming={transport:'telegram' as const,chatId:'6612253937',senderId:'6612253937',sender:'owner',id:'1',text:'check the sandbox once and tell me the result',isGroup:false,credentialEligible:true,timestamp:0,learningEligible:false};
 const response=(calls:{name:string,args:unknown}[])=>new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output:calls.map((c,i)=>({type:'function_call',id:`fc_${i}`,call_id:`call_${i}`,name:c.name,arguments:JSON.stringify(c.args),status:'completed'})),usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 const history={} as HistoryStore;
 try{
  for(const progress of [false,true]){
   const events:string[]=[];let phase=0;sandboxes.run=async()=>{events.push('work');return {exitCode:0,output:'done',timedOut:false,truncated:false};};
   globalThis.fetch=async(_url,init)=>{
    phase++;const body=JSON.parse(String(init?.body));const names=body.tools.map((t:{name:string})=>t.name);
    if(phase===1){assert.ok(names.includes('run_command'),'quick tool visible without ack');if(progress)return response([{name:'send_message',args:{text:"i'll check the box",purpose:'progress'}},{name:'end_turn',args:{}}]);}
    if(phase===(progress?2:1)){if(progress){assert.ok(!names.includes('end_turn'));assert.equal(body.tool_choice,'required');assert.ok(JSON.stringify(body.input).includes('finished\\\":false')||JSON.stringify(body.input).includes('Progress is not completion'));}return response([{name:'run_command',args:{command:'printf done'}}]);}
    if(phase===(progress?3:2))return response([{name:'send_message',args:{text:'it printed done',purpose:'answer'}}]);
    return response([{name:'end_turn',args:{}}]);
   };
   await think([],incoming,undefined,undefined,{history,delivery:{current:()=>true,send:async text=>{events.push(text);},react:async()=>{}}});
   assert.deepEqual(events,progress?["i'll check the box",'work','it printed done']:['work','it printed done']);assert.equal(phase,progress?4:3);
  }
 }finally{globalThis.fetch=original;sandboxes.run=run;sandboxes.authorized=auth;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;await reminders.close();sandboxes.stop();await closeMongo();}
});
