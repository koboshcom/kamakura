import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ChannelType} from 'discord.js';
import {DiscordTransport,MongoDiscordClaims} from '../src/transports/discord.js';
import {discordConfig,snowflake} from '../src/discord-config.js';
import {registerDiscord} from '../src/transport-registration.js';
import {config} from '../src/config.js';
import {chatTools} from '../src/chat-tools.js';
import {chatDelivery} from '../src/chat-delivery.js';
import {contextOwner,ownerFactKey} from '../src/owner-context.js';
import {canWork,workTools} from '../src/work-tools.js';
import {HistoryStore} from '../src/history.js';
import {FactsStore} from '../src/facts.js';
import {learningScope} from '../src/learning.js';
import {summaryScope} from '../src/context-budget.js';
import {think,reminders} from '../src/brain.js';
import {prepareIncomingMedia} from '../src/media.js';
import sharp from 'sharp';
import type {IncomingMessage} from '../src/types.js';
const user='123456789012345678',channel='223456789012345678',owner='6612253937';
const env={DISCORD_ENABLED:'true',DISCORD_BOT_TOKEN:'fixture-only',DISCORD_ALLOWED_USERS:user,DISCORD_OWNER_IDS:JSON.stringify({[user]:owner}),SANDBOX_ALLOWED_USERS:owner};
function message(id='323456789012345678',extra:any={}){return {partial:false,guildId:null,system:false,webhookId:null,author:{id:user,bot:false},id,channelId:channel,createdTimestamp:Date.now(),content:'hello',attachments:new Map(),embeds:[],reference:null,...extra};}
async function fixture(download?:any){
 const cfg=discordConfig(env),received:IncomingMessage[]=[],sent:any[]=[],reactions:any[]=[];
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);config.discord=cfg;
 const client:any=new EventEmitter();client.login=async()=>{};client.destroy=async()=>{};
 const dm:any={type:ChannelType.DM,recipientId:user,sendTyping:async()=>{},send:async(payload:any)=>{sent.push(payload);}};
 const seen=new Set<string>();const claims={claim:async(chat:string,id:string)=>{const key=chat+':'+id;if(seen.has(key))return false;seen.add(key);return true;}};
 const tr:any=new DiscordTransport(cfg,client,download,claims);await tr.start((m:IncomingMessage)=>received.push(m));
 const accept=async(id='323456789012345678',extra:any={})=>{await tr.receive({...message(id),channel:dm,react:async(e:any)=>reactions.push(e),...extra},(m:IncomingMessage)=>received.push(m));return received.at(-1)!;};
 const history=new HistoryStore(config.dataDir+'/discord-fixture-'+Math.random(),10);
 return {tr,cfg,dm,accept,received,sent,reactions,history,close:()=>tr.stop()};
}
test('Discord flags fail closed, string snowflakes stay exact above safe integer; off means no registration',()=>{
 assert.equal(snowflake(user),true);assert.equal(snowflake(Number(user)),false);assert.equal(snowflake('18446744073709551616'),false);
 const transports=new Map();registerDiscord(transports,{});assert.equal(transports.size,0);
 for(const patch of [{DISCORD_ENABLED:'yes'},{DISCORD_BOT_TOKEN:''},{DISCORD_ALLOWED_USERS:'*'},{DISCORD_OWNER_IDS:'{}'},{DISCORD_OWNER_IDS:JSON.stringify({[user]:Number(owner)})},{SANDBOX_ALLOWED_USERS:'*'},{DISCORD_OWNER_IDS:JSON.stringify({[user]:'999'})},{DISCORD_ALLOWED_USERS:user+',323456789012345678'}])assert.throws(()=>discordConfig({...env,...patch}));
 assert.equal(discordConfig(env).owners.get(user),owner);
});
test('only authenticated one-to-one owner DMs accepted; bots/guild/group/webhook/replays/stale denied',async()=>{
 const f=await fixture();try{
 for(const extra of [{author:{id:user,bot:true}},{author:{id:'123456789012345679',bot:false}},{guildId:'1'},{channel:{...f.dm,type:ChannelType.GroupDM}},{channel:{...f.dm,recipientId:'other'}},{webhookId:'1'},{system:true},{partial:true},{createdTimestamp:Date.now()-120001},{createdTimestamp:Date.now()+31000}])await f.accept('323456789012345678',extra);
 assert.equal(f.received.length,0);const m=await f.accept();await f.accept();assert.equal(f.received.length,1);
 assert.equal(m.senderId,owner);assert.equal(m.authenticatedOwner,true);assert.equal(m.authenticatedAccountId,user);assert.equal(m.learningEligible,true);
 f.cfg.owners.delete(user);await f.accept('323456789012345679');assert.equal(f.received.length,1);assert.throws(()=>f.tr.preflight(channel,'send'),/unavailable/);
 }finally{await f.close();}
});
test('real send-as-tool delivery is explicit and bound to this DM; preflight/cancel/revocation prevent sends',async()=>{
 const f=await fixture();try{
 const old=await f.accept();const m=await f.accept('323456789012345679');let current=true,attempts=0,recorded=0;
 const delivery=chatDelivery(f.tr,m,{current:()=>current,deliveryStarted:()=>attempts++,pace:async()=>{},delivered:async()=>{recorded++;}});
 const tools=chatTools(m,f.history,delivery,[],()=>{});const options={toolCallId:'fixture',messages:[]};
 assert.equal('send_voice' in tools,false);assert.equal(f.sent.length,0);
 await tools.send_message.execute!({text:'first',purpose:'chat',finish_turn:false},options);
 await tools.send_message.execute!({text:'second',purpose:'chat',finish_turn:true},options);
 await tools.react!.execute!({emoji:'👍'},options);assert.equal(f.sent.length,2);assert.equal(recorded,3);assert.equal(attempts,3);
 assert.deepEqual(f.sent[0].allowedMentions,{parse:[],repliedUser:false});
 await f.tr.send(channel,'quote',{replyTo:old.id});assert.equal(f.sent.at(-1).reply.messageReference,old.id);
 for(const id of ['42','323456789012345680'])await assert.rejects(f.tr.send(channel,'no',{replyTo:id}),/unavailable/);
 await assert.rejects(f.tr.send('other','no'),/unavailable/);await assert.rejects(f.tr.send(channel,'x'.repeat(2001)),/2000/);
 f.tr.accepted.get(channel+':'+old.id).expires=0;await assert.rejects(f.tr.send(channel,'late',{replyTo:old.id}),/unavailable/);
 current=false;await assert.rejects(tools.send_message.execute!({text:'stale'},options) as Promise<any>,/superseded/);assert.equal(attempts,3);
 f.cfg.owners.set(user,'7853500388');config.sandbox.allowed.add('7853500388');await assert.rejects(f.tr.send(channel,'remapped'),/unavailable/);
 }finally{await f.close();}
});
test('shared canonical facts/learning but own history/search/summary, no cross-owner or sandbox/local privileges',async()=>{
 const f=await fixture();try{
 const m=await f.accept(undefined,{content:'I like green tea'}),tg={...m,transport:'telegram' as const,chatId:owner};
 assert.equal(contextOwner(m),owner);assert.equal(ownerFactKey(m),ownerFactKey(tg));assert.equal(learningScope(m),learningScope(tg));
 assert.notEqual(summaryScope('chat','discord:'+channel,owner),summaryScope('chat','telegram:'+owner,owner));
 assert.equal(contextOwner({...m,authenticatedOwner:false}),undefined);assert.equal(contextOwner({...m,authenticatedAccountId:'unknown'}),undefined);
 assert.equal(contextOwner({...m,senderId:'7853500388'}),undefined);assert.equal(canWork(m),false);assert.deepEqual(workTools(m),{});
 const facts=new FactsStore(config.dataDir+'/discord-facts');await facts.update(ownerFactKey(m)!,owner,'I like green tea',false,m);assert.deepEqual(await facts.readUser(tg),['I like green tea']);assert.deepEqual(await facts.readUser({...m,senderId:'7853500388'}),[]);
 for(const [key,id,text]of [['discord:'+channel,m.id,'discord only'],['telegram:'+owner,'42','telegram only'],['whatsapp:phone','opaque','whatsapp only']])await f.history.add(key!,{role:'user',senderId:owner,id,text:text!,at:1},key==='discord:'+channel?m:undefined);
 const lookup=await f.history.ownerLookup(m,{query:'',role:'user'});assert.deepEqual(lookup.messages.map(m=>m.text),['discord only']);
 const tools=chatTools(m,f.history,{current:()=>true,send:async()=>{},react:async()=>{}},[],()=>{});
 const result:any=await tools.search_history.execute!({query:'',limit:8,role:'user',exact:false},{toolCallId:'lookup',messages:[]});assert.deepEqual(result.messages.map((m:any)=>m.text),['discord only']);
 for(const id of ['42','opaque'])await assert.rejects(tools.send_message.execute!({text:'no',reply_to:id},{toolCallId:'no',messages:[]}) as Promise<any>,/known message/);
 }finally{await f.close();}
});
test('attachment acquisition bounded to adapter, unauthorized no download, stale finish never enqueues',async()=>{
 const png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();let fetches=0,release:any;
 const f=await fixture(async()=>{fetches++;return png;});
 const attachment={size:png.length,contentType:'image/png',url:'https://cdn.discordapp.com/attachments/fixture/image.png'};
 try{
 await f.accept(undefined,{author:{id:'123456789012345679',bot:false},attachments:new Map([['a',attachment]])});assert.equal(fetches,0);
 const m=await f.accept(undefined,{content:'what color?',attachments:new Map([['a',attachment]])});assert.equal(m.learningEligible,false);assert.equal(m.credentialEligible,false);
 const prepared=await prepareIncomingMedia(m.media!);assert.equal(prepared.images.length,1);
 f.tr.download=async()=>new Promise(resolve=>{release=resolve;});const pending=f.accept('323456789012345679',{attachments:new Map([['a',attachment]])});await new Promise(resolve=>setImmediate(resolve));const stop=f.close();release(png);await pending;await stop;assert.equal(f.received.length,1);
 }finally{await f.close();}
});
test('actual brain Responses SDK sends image data, strips on explicit unsupported vision then honestly responds; never completion autosend',async()=>{
 const f=await fixture(),original=globalThis.fetch;const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
 try{
 const m=await f.accept(undefined,{content:'what color is this?',learningEligible:false});const media=await prepareIncomingMedia([{kind:'image',mime:'image/png',data:png}]);let calls=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const input=JSON.stringify(body.input);const names=body.tools.map((t:any)=>t.name);
  for(const forbidden of ['run_command','start_worker','send_voice','schedule_reminder','list_reminders','cancel_reminder'])assert.equal(names.includes(forbidden),false);
  calls++;
  if(calls===1){assert.match(input,/input_image/);assert.match(input,/data:image\/jpeg;base64/);return new Response(JSON.stringify({error:{message:'This model does not support image input',type:'invalid_request_error',code:'unsupported_image'}}),{status:400,headers:{'content-type':'application/json'}});}
  assert.doesNotMatch(input,/input_image|data:image/);assert.match(input,/Image inspection is unavailable/);
  return new Response(JSON.stringify({id:'fixture',created_at:1,model:config.model,status:'completed',output:[{type:'function_call',id:'fc',call_id:'send',name:'send_message',arguments:JSON.stringify({text:"i can't inspect this image with the configured model",purpose:'chat',finish_turn:true}),status:'completed'}],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
 };
 await think([],m,media,undefined,{history:f.history,delivery:chatDelivery(f.tr,m,{current:()=>true,deliveryStarted:()=>{},pace:async()=>{},delivered:async()=>{}})});
 assert.equal(calls,2);assert.equal(f.sent.length,1);assert.match(f.sent[0].content,/can't inspect/);
 }finally{globalThis.fetch=original;await f.close();await reminders.close();}
});

test('durable claims suppress restart replay and fail closed without dispatch',async()=>{
 const f=await fixture();try{
 f.tr.claims=new MongoDiscordClaims();await f.accept('523456789012345678');await f.close();await f.tr.start((m:IncomingMessage)=>f.received.push(m));await f.accept('523456789012345678');assert.equal(f.received.length,1);
 f.tr.claims={claim:async()=>{throw new Error('fixture Mongo unavailable');}};
 await assert.rejects(f.accept('523456789012345679'),/Mongo unavailable/);assert.equal(f.received.length,1);
 }finally{await f.close();}
});
