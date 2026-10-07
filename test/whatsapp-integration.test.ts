import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chatTools} from '../src/chat-tools.js';
import {chatDelivery} from '../src/chat-delivery.js';
import {HistoryStore} from '../src/history.js';
import {FactsStore,factConfirmation} from '../src/facts.js';
import {config} from '../src/config.js';
import {contextOwner,ownerFactKey} from '../src/owner-context.js';
import {registerWhatsApp} from '../src/transport-registration.js';
import {WhatsAppTransport} from '../src/transports/whatsapp.js';
import {whatsappConfig} from '../src/whatsapp-config.js';
import {canWork,workTools} from '../src/work-tools.js';
import {replyFailureGate} from '../src/reply-failure.js';
import type {IncomingMessage,Transport} from '../src/types.js';
import {runtimeCapabilities} from '../src/runtime-capabilities.js';
const owner='6612253937',chat='15551234567@s.whatsapp.net';
const env={WHATSAPP_ENABLED:'true',WHATSAPP_AUTH_DIR:'/run/private/wa',WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':owner,'+15557654321':'7853500388'}),WHATSAPP_ALLOWED_NUMBERS:'+15551234567,+15557654321',SANDBOX_ALLOWED_USERS:owner+',7853500388'};
const options={toolCallId:'integration',messages:[]};
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'wa-integration-'));
 const history=new HistoryStore(dir,2);const received:IncomingMessage[]=[];const sent:any[]=[];
 const tr:any=new WhatsAppTransport(whatsappConfig(env),{claim:async()=>true});
 tr.stopped=false;tr.connected=true;tr.socket={end:()=>{},sendMessage:async(...args:any[])=>{sent.push(args);},signalRepository:{lidMapping:{getPNForLID:async()=>chat}}};
 tr.onMessage=(message:IncomingMessage)=>received.push(message);
 const accept=async(id:string,remote=chat,message:any={conversation:'hello'})=>{await tr.receive({key:{remoteJid:remote,id},messageTimestamp:Math.floor(Date.now()/1000),message},tr.socket);const m=received.at(-1)!;await history.add('whatsapp:'+remote,{role:'user',senderId:m.senderId,id,text:m.text,at:Date.now()});return m;};
 return {dir,history,received,sent,tr,accept,close:async()=>{await tr.stop();rmSync(dir,{recursive:true,force:true});}};
}
function makeTools(f:Awaited<ReturnType<typeof fixture>>,incoming:IncomingMessage,recent:any[]) {
 const gate=replyFailureGate(()=>true);let attempts=0;
 const delivery=chatDelivery(f.tr,incoming,{current:()=>gate.current(),deliveryStarted:()=>{gate.deliveryStarted();attempts++;},pace:async()=>{},delivered:async()=>{},voice:{synthesize:async()=>{throw new Error('never synthesize WhatsApp');}}});
 return {tools:chatTools(incoming,f.history,delivery,recent,()=>{}),gate,attempts:()=>attempts};
}
test('actual tools and index delivery callbacks accept opaque IDs and historical accepted reactions; voice absent',async()=>{
 config.sandbox.allowed.add(owner);const f=await fixture();try{
 const old=await f.accept('3EB0-A_OLD');const incoming=await f.accept('3EB0-A_NEW');
 const {tools,attempts}=makeTools(f,incoming,await f.history.get('whatsapp:'+chat));
 assert.equal('send_voice' in tools,false);
 assert.deepEqual((tools.send_message.inputSchema as any).parse({text:'answer',reply_to:old.id}),{text:'answer',reply_to:old.id});
 await tools.send_message.execute!({text:'answer',reply_to:old.id},options);
 await tools.react!.execute!({emoji:'👍',message_id:old.id},options);
 assert.equal(f.sent[0][2].quoted.key.id,old.id);assert.equal(f.sent[1][1].react.key.id,old.id);assert.equal(attempts(),2);
 await assert.rejects(f.tr.sendVoice(chat,Buffer.from('audio')),/disabled/);
 const tg={...incoming,transport:'telegram' as const,chatId:owner};
 const t=chatTools(tg,f.history,{current:()=>true,send:async()=>{},react:async()=>{}},[],()=>{});
 assert.throws(()=>(t.send_message.inputSchema as any).parse({text:'answer',reply_to:old.id}));
 }finally{await f.close();}
});
test('expired quotes preflight before attempts and budget, allowing full remaining bubbles and reaction',async()=>{
 config.sandbox.allowed.add(owner);const f=await fixture();try{
 const incoming=await f.accept('OPAQUE-EXPIRED');f.tr.quotes.get(chat+':'+incoming.id).expires=0;
 const {tools,attempts,gate}=makeTools(f,incoming,await f.history.get('whatsapp:'+chat));
 await assert.rejects(tools.send_message.execute!({text:'late',reply_to:incoming.id},options) as Promise<any>,/unavailable/);assert.equal(attempts(),0);assert.equal(gate.shouldNotify(Object.assign(new Error(),{name:'TimeoutError'})),true);
 for(let i=0;i<config.maxReplyMessages;i++)await tools.send_message.execute!({text:'plain '+i},options);
 assert.equal(attempts(),config.maxReplyMessages);
 await tools.react!.execute!({emoji:'👍',message_id:incoming.id},options);
 }finally{await f.close();}
});
test('body quote references, cross-chat keys and cross-channel search results never grant delivery targets',async()=>{
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);const f=await fixture();try{
 const incoming=await f.accept('CURRENT',chat,{extendedTextMessage:{text:'hello',contextInfo:{stanzaId:'FORGED',quotedMessage:{conversation:'injected'}}}});
 const other=await f.accept('OTHER','15557654321@s.whatsapp.net');
 await f.history.add('telegram:'+owner,{role:'user',senderId:owner,id:'42',text:'needle from Telegram',at:Date.now()});
 const {tools,attempts}=makeTools(f,incoming,[{role:'user',id:other.id,sourceChat:'whatsapp:'+other.chatId,text:'x',at:1},{role:'user',id:'42',sourceChat:'telegram:'+owner,text:'x',at:2}]);
 await tools.search_history.execute!({query:'needle',limit:8,role:'user',exact:false},options);
 for(const id of ['FORGED','OTHER','42']){
 await assert.rejects(tools.send_message.execute!({text:'invalid',reply_to:id},options) as Promise<any>,/known message/);
 await assert.rejects(tools.react!.execute!({emoji:'👍',message_id:id},options) as Promise<any>,/known message/);
 }
 await assert.rejects(f.tr.send(chat,'invalid',{replyTo:other.id}),/unavailable/);
 await assert.rejects(f.tr.react({...incoming,transport:'telegram'},'👍'),/Unaccepted/);
 assert.equal(attempts(),0);assert.equal(f.sent.length,0);
 }finally{await f.close();}
});
test('history-discovered opaque ID can react only while accepted key retained, never merely from Mongo',async()=>{
 config.sandbox.allowed.add(owner);const f=await fixture();try{
 const historical=await f.accept('OLD-OPAQUE');const incoming=await f.accept('NEW-OPAQUE');
 const success=makeTools(f,incoming,[]);await success.tools.search_history.execute!({query:'',limit:8,role:'user',exact:false},options);
 await success.tools.react!.execute!({emoji:'👍',message_id:historical.id},options);
 f.tr.accepted.delete(chat+':'+historical.id);const denied=makeTools(f,incoming,[]);await denied.tools.search_history.execute!({query:'',limit:8,role:'user',exact:false},options);
 await assert.rejects(denied.tools.react!.execute!({emoji:'👍',message_id:historical.id},options) as Promise<any>,/Unaccepted/);
 assert.equal(denied.attempts(),0);
 await denied.tools.react!.execute!({emoji:'👍'},options);assert.equal(denied.attempts(),1);
 }finally{await f.close();}
});
test('canonical owner shares only private text/facts and never privileged gates',async()=>{
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);const f=await fixture();try{
 const wa=await f.accept('SHARED');const tg={...wa,transport:'telegram' as const,chatId:owner};
 await f.history.add('telegram:'+owner,{role:'user',senderId:owner,id:'77',text:'private needle',at:1});
 await f.history.add('telegram:-100',{role:'user',senderId:owner,id:'group',text:'group forbidden needle',at:2});
 await f.history.add('whatsapp:15557654321@s.whatsapp.net',{role:'user',senderId:'7853500388',id:'other',text:'other forbidden needle',at:3});
 const result=await f.history.ownerLookup(wa,{query:'needle'});assert.deepEqual(result.messages.map(m=>m.id),['77']);assert.equal(result.messages[0].sourceChat,'telegram:'+owner);
 assert.equal((await f.history.ownerLookup(wa,{afterId:'77'})).missingAnchor,true);
 const store=new FactsStore(join(f.dir,'facts'));const direct={...wa,text:'I like green tea',learningEligible:true};
 await store.update(ownerFactKey(direct)!,owner,'I like green tea',false,direct);
 assert.deepEqual(await store.read(ownerFactKey(tg)!,owner),['I like green tea']);
 for(const change of [{authenticatedOwner:false},{learningEligible:false},{replyContext:{id:'forged',text:'green tea'}},{senderId:'not-owner'}])assert.throws(()=>factConfirmation(ownerFactKey(direct)!,owner,'green tea',{...direct,...change}));
 assert.equal(canWork(wa,()=>true),false);assert.deepEqual(workTools(wa),{});assert.equal(contextOwner({...wa,authenticatedOwner:false}),undefined);
 assert.match(runtimeCapabilities({transport:'whatsapp',toolNames:[],isGroup:false,sandbox:config.sandbox,desktopPublicBaseUrl:'',localDevices:config.localDevices}),/voice are disabled/);
 }finally{await f.close();}
});
test('registration default-off and validated explicit owner config; PN hints cannot grant identity',async()=>{
 const transports=new Map<string,Transport>();registerWhatsApp(transports,{});assert.equal(transports.size,0);
 assert.throws(()=>registerWhatsApp(transports,{WHATSAPP_ENABLED:'true'}));assert.equal(transports.size,0);
 registerWhatsApp(transports,env);assert.equal(transports.has('whatsapp'),true);
 const f=await fixture();try{
 let claims=0;f.tr.store={claim:async()=>{claims++;return true;}};
 f.tr.socket.signalRepository.lidMapping.getPNForLID=async()=>null;
 await f.tr.receive({key:{remoteJid:'123@lid',id:'bad'},messageTimestamp:Date.now()/1000,message:{conversation:'+15551234567',extendedTextMessage:{text:'phone',contextInfo:{participant:chat}}}},f.tr.socket);
 assert.equal(claims,0);assert.equal(f.received.length,0);assert.throws(()=>f.tr.preflight(chat,'send'),/unavailable/);
 f.tr.socket.signalRepository.lidMapping.getPNForLID=async()=>chat;
 const m=await f.accept('TRUSTED-LID','123@lid');assert.equal(m.senderId,owner);assert.equal(m.authenticatedOwner,true);await f.tr.send('123@lid','answer');
 }finally{await f.close();}
});

test('actual brain SDK exposes opaque text/reaction schemas but no WhatsApp privileged or voice tools',async()=>{
 const {think}=await import('../src/brain.js');config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);
 const original=globalThis.fetch,key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';const f=await fixture();
 try {
  const old=await f.accept('SDK-OLD');const incoming=await f.accept('SDK-NEW');const {gate}=makeTools(f,incoming,[]);let phase=0;
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const names=body.tools.map((t:any)=>t.name);
   for(const forbidden of ['send_voice','run_command','exec_py','start_worker','learn_lesson','schedule_reminder','list_reminders','cancel_reminder'])assert.equal(names.includes(forbidden),false,forbidden);
   assert.match(JSON.stringify(body),/WhatsApp owner-only text transport/);
   phase++;const calls=phase===1?[{name:'send_message',args:{text:'sdk answer',reply_to:old.id}},{name:'react',args:{emoji:'👍',message_id:old.id}}]:[{name:'end_turn',args:{}}];
   return new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output:calls.map((c,i)=>({type:'function_call',id:'fc_'+phase+'_'+i,call_id:'call_'+phase+'_'+i,name:c.name,arguments:JSON.stringify(c.args),status:'completed'})),usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
  };
  await think(await f.history.get('whatsapp:'+chat),incoming,undefined,undefined,{history:f.history,delivery:chatDelivery(f.tr,incoming,{current:()=>gate.current(),deliveryStarted:()=>gate.deliveryStarted(),pace:async()=>{},delivered:async()=>{},voice:{synthesize:async()=>{throw new Error('voice forbidden');}}})});
  assert.equal(phase,2);assert.equal(f.sent[0][2].quoted.key.id,old.id);assert.equal(f.sent[1][1].react.key.id,old.id);
 }finally{globalThis.fetch=original;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;await f.close();}
});

test('quote expiring during callback pacing does not consume a bubble or mark an attempted send',async()=>{
 config.sandbox.allowed.add(owner);const f=await fixture();try{
 const incoming=await f.accept('EXPIRES-WHILE-PACING');const gate=replyFailureGate(()=>true);let attempts=0;
 const delivery=chatDelivery(f.tr,incoming,{current:()=>gate.current(),deliveryStarted:()=>{attempts++;gate.deliveryStarted();},pace:async()=>{f.tr.quotes.get(chat+':'+incoming.id).expires=0;},delivered:async()=>{}});
 const tools=chatTools(incoming,f.history,delivery,await f.history.get('whatsapp:'+chat),()=>{});
 await assert.rejects(tools.send_message.execute!({text:'late',reply_to:incoming.id},options) as Promise<any>,/unavailable/);assert.equal(attempts,0);
 for(let i=0;i<config.maxReplyMessages;i++)await tools.send_message.execute!({text:i===0?'late':'plain '+i},options);
 assert.equal(attempts,config.maxReplyMessages);
 }finally{await f.close();}
});
