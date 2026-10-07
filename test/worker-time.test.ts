import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker } from '../src/worker.js';
import { config } from '../src/config.js';
import { sandboxes } from '../src/sandbox.js';
import { stopLearning } from '../src/learning-runtime.js';
test('worker puts fresh trusted owner clock last, never in stable instructions',async()=>{
 const fetch=globalThis.fetch,auth=sandboxes.authorized,key=process.env.OPENAI_API_KEY;
 const zones={...config.time.ownerTimeZones};
 process.env.OPENAI_API_KEY='test-key';sandboxes.authorized=()=>true;
 config.time.ownerTimeZones['6612253937']='America/Vancouver';
 let phase=0;let stable='';
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));phase++;
  const instructions=JSON.stringify(body.input[0]);
  assert.ok(!instructions.includes('TRUSTED CURRENT CLOCK.'));
  if(stable)assert.equal(instructions,stable);else stable=instructions;
  assert.match(JSON.stringify(body.input.at(-1)),/TRUSTED CURRENT CLOCK.*America\/Vancouver/s);
  assert.equal(body.input.filter((m:{role:string;content:unknown})=>(m.role==='system'||m.role==='developer')&&JSON.stringify(m.content).includes('TRUSTED CURRENT CLOCK.')).length,1);
  assert.match(JSON.stringify(body.input),/2026-10-01T00:00:00.000Z/);
  const output=phase===1?[{type:'function_call',id:'fc_1',call_id:'call_1',name:'send_message',arguments:JSON.stringify({text:'checking the date'}),status:'completed'}]:[{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'date checked',annotations:[]}]}];
  return new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 };
 try{
  const incoming={transport:'telegram' as const,chatId:'6612253937',senderId:'6612253937',sender:'owner',id:'1',text:'check the current date',isGroup:false,credentialEligible:true,timestamp:Date.parse('2026-10-01T00:00:00Z')};
  const result=await runWorker({id:'clock-test',incoming,task:'check the date',sendMessage:async()=>({sent:true})},new AbortController().signal);
  assert.equal(result,'date checked');assert.equal(phase,2);
 }finally{globalThis.fetch=fetch;sandboxes.authorized=auth;config.time.ownerTimeZones=zones;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;stopLearning();sandboxes.stop();}
});
