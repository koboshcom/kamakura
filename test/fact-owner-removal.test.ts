import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FactsStore,factConfirmation} from '../src/facts.js';
import {config} from '../src/config.js';
import {chatKey,type IncomingMessage} from '../src/types.js';
import {ownerFactKey} from '../src/owner-context.js';
const owner='6612253937',other='7853500388',fact='I like green tea';
function messages(){
 config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);config.telegramAllowed.add(owner);config.telegramAllowed.add(other);
 const wa:IncomingMessage={transport:'whatsapp',chatId:'15551234567@s.whatsapp.net',senderId:owner,sender:'owner',id:'direct',text:fact,timestamp:1,isGroup:false,authenticatedOwner:true,learningEligible:true};
 return {wa,tg:{...wa,transport:'telegram' as const,chatId:owner},group:{...wa,transport:'telegram' as const,chatId:'-100',isGroup:true},another:{...wa,transport:'telegram' as const,senderId:other,chatId:other}};
}
async function seed(store:FactsStore){
 const m=messages();
 await store.update(chatKey(m.tg),owner,fact,false,m.tg);
 await store.update(chatKey(m.wa),owner,fact,false,m.wa);
 await store.update(ownerFactKey(m.wa)!,owner,fact,false,m.wa);
 await store.update(chatKey(m.group),owner,fact,false,m.group);
 await store.update(ownerFactKey(m.another)!,other,fact,false,m.another);
 await store.update(chatKey(m.another),other,fact,false,m.another);
 await store.update(chatKey(m.wa),undefined,fact,false,m.wa);
 return m;
}
test('user removal deletes current WhatsApp and its transport canonical duplicates, retaining Telegram, not group/other owner/chat facts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fact-owner-'));const store=new FactsStore(dir);
 try{
 const m=await seed(store);assert.deepEqual(await store.readUser(m.wa),[fact]);
 await assert.rejects(store.update(chatKey(m.tg),owner,fact,true,m.wa),/current direct/);
 assert.throws(()=>factConfirmation(chatKey(m.tg),owner,fact,m.wa,true));
 assert.deepEqual(await store.removeUser(fact,m.wa),[]);
 for(const key of [chatKey(m.wa),ownerFactKey(m.wa)!])assert.deepEqual(await store.read(key,owner),[]);
 assert.deepEqual(await store.readUser(m.tg),[fact]);
 assert.deepEqual(await store.read(chatKey(m.group),owner),[fact]);
 assert.deepEqual(await store.readUser(m.another),[fact]);
 assert.deepEqual(await store.read(chatKey(m.wa)),[fact]);
 const fresh='I like black tea';const direct={...m.wa,text:fresh};
 await store.update(ownerFactKey(direct)!,owner,fresh,false,direct);
 assert.deepEqual(await store.read(ownerFactKey(direct)!,owner),[fresh]);
 assert.deepEqual(await store.read(chatKey(m.wa),owner),[]);assert.deepEqual(await store.read(chatKey(m.tg),owner),[fact]);
 assert.deepEqual(await store.readUser(m.tg),[fact]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('remove-only helper rejects unverified, quoted, media and forwarded WhatsApp before modifying any source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fact-reject-'));const store=new FactsStore(dir);
 try{
 const m=await seed(store);
 for(const change of [{authenticatedOwner:false},{senderId:'not-owner'},{isGroup:true},{learningEligible:false},{replyContext:{id:'quote',text:fact}},{media:[{kind:'image' as const,data:Buffer.alloc(0),mime:'image/png'}]}]){
 await assert.rejects(store.removeUser(fact,{...m.wa,...change}),/current direct/);
 for(const key of [chatKey(m.wa),chatKey(m.tg),ownerFactKey(m.wa)!])assert.deepEqual(await store.read(key,owner),[fact]);
 }
 // A group Telegram removal stays local, and must not reach that sender's private owner sources.
 await store.removeUser(fact,m.group);
 assert.deepEqual(await store.read(chatKey(m.group),owner),[]);assert.deepEqual(await store.readUser(m.wa),[fact]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('successful additions/deletes refresh bounded fallback cache without an intervening read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fact-cache-'));const store=new FactsStore(dir);const {wa}=messages();
 try{
 const key=ownerFactKey(wa)!;await store.update(key,owner,fact,false,wa);assert.deepEqual(await store.read(key,owner),[fact]);
 await store.update(key,owner,fact,true,wa);
 const ready=store.ready;store.ready=async()=>{throw new Error('simulated storage outage');};
 assert.deepEqual(await store.read(key,owner),[]);
 store.ready=ready;await store.update(key,owner,fact,false,wa);
 store.ready=async()=>{throw new Error('simulated storage outage');};assert.deepEqual(await store.read(key,owner),[fact]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual brain remember_fact remove tool clears merged private owner sources and retains canonical-only additions',async()=>{
 const {think,facts,reminders}=await import('../src/brain.js');const m=await seed(facts);const fetch=globalThis.fetch,key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';let phase=0;
 try{
 globalThis.fetch=async(_url,init)=>{
 const body=JSON.parse(String(init?.body));phase++;
 if(phase===1)assert.ok(JSON.stringify(body.input).includes(fact));
 const output=phase===1?[{type:'function_call',id:'fc_remove',call_id:'call_remove',name:'remember_fact',arguments:JSON.stringify({scope:'user',fact,remove:true}),status:'completed'}]:[{type:'message',id:'done',role:'assistant',status:'completed',content:[{type:'output_text',text:'forgot it',annotations:[]}]}];
 return new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 };
 await think([],m.wa);assert.equal(phase,2);
 for(const source of [chatKey(m.wa),ownerFactKey(m.wa)!])assert.deepEqual(await facts.read(source,owner),[]);
 assert.deepEqual(await facts.read(chatKey(m.group),owner),[fact]);assert.deepEqual(await facts.readUser(m.another),[fact]);
 phase=0;globalThis.fetch=async(_url,init)=>{
 phase++;const output=phase===1?[{type:'function_call',id:'fc_add',call_id:'call_add',name:'remember_fact',arguments:JSON.stringify({scope:'user',fact,remove:false}),status:'completed'}]:[{type:'message',id:'done2',role:'assistant',status:'completed',content:[{type:'output_text',text:'saved',annotations:[]}]}];
 return new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 };
 await think([],m.wa);assert.deepEqual(await facts.read(ownerFactKey(m.wa)!,owner),[fact]);
 assert.deepEqual(await facts.read(chatKey(m.tg),owner),[fact]);assert.deepEqual(await facts.read(chatKey(m.wa),owner),[]);
 }finally{globalThis.fetch=fetch;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;await reminders.close();}
});
