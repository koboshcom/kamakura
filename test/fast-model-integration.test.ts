import test from 'node:test';import assert from 'node:assert/strict';
import {think,reminders} from '../src/brain.js';import {config} from '../src/config.js';import {HistoryStore} from '../src/history.js';
const incoming={transport:'telegram' as const,chatId:'fast-fixture',senderId:'fast-fixture',sender:'owner',id:'1',text:'hey',timestamp:0,isGroup:false};
const response=(output:unknown[])=>new Response(JSON.stringify({id:'fixture',created_at:1,model:'fixture',status:'completed',output,usage:{input_tokens:10,output_tokens:3,total_tokens:13}}),{headers:{'content-type':'application/json'}});
const call=(name:string,args:unknown)=>({type:'function_call',id:'fc1',call_id:'call1',name,arguments:JSON.stringify(args),status:'completed'});
test('fast-model provider failure falls back once before delivery; tool failure cannot replay a send',async()=>{
 const fetch=globalThis.fetch,model=config.fastModel,key=process.env.OPENAI_API_KEY;config.fastModel='fast-fixture';process.env.OPENAI_API_KEY='test-only';
 const sent:string[]=[],models:string[]=[];
 const history=Object.create(HistoryStore.prototype) as HistoryStore;
 try{
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));models.push(body.model);
 assert.equal(body.store,false);assert.match(JSON.stringify(body.input),/Runtime rules/);assert.match(JSON.stringify(body.input),/DELIVERY OVERRIDE/);
 assert.ok(body.tools.every((t:{type:string;name:string})=>t.type==='function'&&['send_message','react','end_turn'].includes(t.name)));
 return models.length===1?new Response(JSON.stringify({error:{message:'unsupported',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}}):response([call('send_message',{text:'hey',purpose:'chat',finish_turn:true})]);};
 assert.equal(await think([],incoming,undefined,undefined,{history,delivery:{current:()=>true,send:async text=>{sent.push(text);}}}),'');
 assert.deepEqual(models,['fast-fixture',config.model]);assert.deepEqual(sent,['hey']);
 models.length=0;sent.length=0;
 globalThis.fetch=async(_url,init)=>{models.push(JSON.parse(String(init?.body)).model);return response([call('send_message',{text:'hey',purpose:'chat',finish_turn:true})]);};
 await think([],incoming,undefined,undefined,{history,delivery:{current:()=>true,send:async text=>{sent.push(text);throw new Error('delivery failed');}}}).catch(()=>{});
 // SDK may recover from a tool error on main, but never retries the fast call or resets delivery guards.
 assert.equal(models[0],'fast-fixture');assert.ok(models.slice(1).every(m=>m===config.model));assert.equal(sent.length,1);
 }finally{globalThis.fetch=fetch;config.fastModel=model;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;await reminders.close();}
});
