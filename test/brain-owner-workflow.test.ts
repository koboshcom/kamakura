import test from 'node:test';
import assert from 'node:assert/strict';
import { think, reminders } from '../src/brain.js';
import { sandboxes } from '../src/sandbox.js';
import { config } from '../src/config.js';
import { hasCredentials } from '../src/credentials.js';
test('actual SDK owner-DM uses credentials transiently, awaits ack and redacts its reply; forwarded keys never reach model',async()=>{
 const fetch=globalThis.fetch;const run=sandboxes.run;const auth=sandboxes.authorized;const env=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY='test-key';const owner='6612253937';config.telegramAllowed.add(owner);
 sandboxes.authorized=()=>true;const key='tskey-auth-sdkdummy0123456789';let phase=0;const events:string[]=[];
 sandboxes.run=async()=>{events.push('execute');return {exitCode:0,output:key,timedOut:false,truncated:false};};
 const output=(parts:unknown[])=>new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output:parts,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 const call=(name:string,args:unknown)=>({type:'function_call',id:`fc_${phase}`,call_id:`call_${phase}`,name,arguments:JSON.stringify(args),status:'completed'});
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));phase++;
  assert.ok(JSON.stringify(body.input).includes(key));
  if(phase===1)return output([call('announce_task',{text:'checking that key without saving it'})]);
  if(phase===2)return output([call('run_command',{command:`printf '%s' '${key}'`})]);
  return output([{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:`checked ${key}`,annotations:[]}]}]);
 };
 const incoming={transport:'telegram' as const,chatId:owner,senderId:owner,sender:'owner',id:'1',text:`Use ${key} for this check`,isGroup:false,credentialEligible:true,timestamp:0};
 try {
  const reply=await think([],incoming,undefined,async text=>{events.push('ack');assert.ok(!hasCredentials(text));});
  assert.deepEqual(events,['ack','execute']);assert.ok(!reply.includes(key));
  globalThis.fetch=async(_url,init)=>{assert.ok(!String(init?.body).includes(key));return output([{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'send it directly for setup',annotations:[]}]}]);};
  await think([], {...incoming,credentialEligible:false});
 }finally{globalThis.fetch=fetch;sandboxes.run=run;sandboxes.authorized=auth;if(env===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=env;reminders.close();sandboxes.stop();}
});
