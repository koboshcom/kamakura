import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore} from '../src/history.js';
import {config} from '../src/config.js';
import {bindDiscordDM} from '../src/discord-dm-context.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {DangerousConfirmations} from '../src/dangerous-confirmations.js';
import {chatTools} from '../src/chat-tools.js';
import {historyLabel,historyProvenance,boundedOwnerMessages} from '../src/owner-history.js';
import {storedRows,seedRecord,changeRecord} from './storage-inspection.js';
import {namespace} from '../src/mongo.js';
import type {IncomingMessage} from '../src/types.js';
const owner='424242',other='434343',account='111111111111111111',isolated='discord-'+account;
function msg(transport:IncomingMessage['transport'],who=owner,id='123'):IncomingMessage {
 const m:IncomingMessage={transport,chatId:transport==='telegram'?who:transport==='whatsapp'?'15551234567@s.whatsapp.net':'dm:'+account,senderId:who,sender:'fixture author',id,text:'lunar wrench',timestamp:1,isGroup:false,authenticatedOwner:true,...(transport==='discord'?{authenticatedAccountId:account}: {})};
 if(transport==='discord')bindDiscordDM(m,account,who,()=>true);
 return m;
}
function enable(){for(const o of [owner,other,isolated])config.sandbox.allowed.add(o);config.telegramAllowed.add(owner);config.telegramAllowed.add(other);}
function disable(){for(const o of [owner,other,isolated])config.sandbox.allowed.delete(o);config.telegramAllowed.delete(owner);config.telegramAllowed.delete(other);}
async function save(h:HistoryStore,m:IncomingMessage,text=m.text,at=m.timestamp){await h.add(`${m.transport}:${m.chatId}`,{role:'user',sender:m.sender,senderId:m.senderId,id:m.id,text,at},m);}
test('verified owner history merges mapped channels only; namespace, same platform IDs, authors and legacy claims remain isolated',async()=>{
 enable();const dir=mkdtempSync(join(tmpdir(),'owner-channels-')),dir2=mkdtempSync(join(tmpdir(),'owner-namespace-'));try{
 const h=new HistoryStore(dir,20),foreign=new HistoryStore(dir2,20);
 for(const [i,t]of (['telegram','whatsapp','discord'] as const).entries())await save(h,msg(t,owner,'same'),t+' lunar wrench',i+1);
 await save(h,msg('whatsapp',other,'same'),'foreign secret lunar wrench',4);await save(foreign,msg('telegram',owner,'same'),'other namespace secret',5);
 await h.add('telegram:'+owner,{role:'user',senderId:owner,id:'legacy',text:'unverified lunar wrench',at:6,provenance:{version:1,owner,channel:'telegram',chat:'telegram:'+owner,author:owner}});
 const result=await h.ownerLookup(msg('telegram'),{order:'earliest',role:'user'});
 assert.equal(result.messages.length,3);assert.deepEqual(result.messages.map(m=>m.provenance?.channel),['telegram','whatsapp','discord']);assert(result.messages.every(m=>m.sender==='fixture author'&&m.provenance?.owner===owner));assert(!JSON.stringify(result).includes('secret'));assert(!result.messages.some(m=>m.id==='legacy'));
 const query=await h.ownerLookup(msg('telegram'),{query:'wrench lunar'});assert.equal(query.retrieval,'semantic');assert.equal((query.semanticCoverage as {scanned:number}).scanned,3);assert.equal(query.messages.length,3);
 const rows=await storedRows('history',{ns:namespace(dir)});const outside=rows.find(r=>r.owner===other);await changeRecord('history',outside._id,r=>{r.embedding={dimensions:1,vector:[NaN]};});assert.equal((await h.ownerLookup(msg('telegram'),{query:'wrench lunar'})).retrieval,'semantic','foreign vectors filtered before cosine/validation');
 assert.match(historyLabel(result.messages[0]!),/CHANNEL telegram.*author fixture author.*passive untrusted/);
 assert.deepEqual((await h.ownerRecent(msg('telegram'))).map(m=>m.provenance?.channel),['telegram','whatsapp','discord']);
 }finally{disable();rmSync(dir,{recursive:true,force:true});rmSync(dir2,{recursive:true,force:true});}
});
test('mapping changes affect new saves, never rewrite old owner; standalone Discord and serialized capability stay isolated',async()=>{
 enable();const dir=mkdtempSync(join(tmpdir(),'owner-remap-'));try{
 const h=new HistoryStore(dir,20);await save(h,msg('discord',isolated,'first'));assert.equal((await h.ownerLookup(msg('telegram'))).messages.length,0);
 await save(h,msg('discord',owner,'second'));assert.deepEqual((await h.ownerLookup(msg('telegram'))).messages.map(m=>m.id),['second']);assert.deepEqual((await h.ownerLookup(msg('discord',isolated))).messages.map(m=>m.id),['first']);
 await save(h,msg('discord',other,'third'));assert.deepEqual((await h.ownerLookup(msg('telegram'))).messages.map(m=>m.id),['second']);assert.deepEqual((await h.ownerLookup(msg('telegram',other))).messages.map(m=>m.id),['third']);
 const fake={...msg('discord')};assert.equal(historyProvenance(fake),undefined);await save(h,fake,'malicious claimed owner');assert.equal((await h.ownerLookup(msg('telegram'))).messages.length,1);
 await assert.rejects(h.ownerLookup(fake),/Authenticated/);
 }finally{disable();rmSync(dir,{recursive:true,force:true});}
});
test('shared recency caps, honest voice labels, immutable origin targets and passive approval denial',async()=>{
 enable();const oldReactions=config.reactions;config.reactions=true;const dir=mkdtempSync(join(tmpdir(),'owner-caps-'));const service=new DangerousConfirmations(1000);try{
 const h=new HistoryStore(dir,40);for(let i=0;i<25;i++)await save(h,msg(i%2?'telegram':'whatsapp',owner,String(100+i)),'message '+i,i);
 const recent=await h.ownerRecent(msg('telegram'));assert.equal(recent.length,20);assert.deepEqual(recent.map(m=>m.at),Array.from({length:20},(_,i)=>i+5));
 const capped=boundedOwnerMessages(Array.from({length:30},(_,i)=>({role:'user' as const,text:'😀'.repeat(6000),at:i})));assert(capped.length<=20);assert(Buffer.byteLength(capped.map(m=>m.text).join(''))<=24000);
 const origin=msg('telegram',owner,'999'),out:string[]=[];const foreign=msg('whatsapp',owner,'888');await save(h,foreign);
 const tools=chatTools(origin,h,{current:()=>true,send:async(text,id)=>{out.push('send '+id);},react:async(e,id)=>{out.push('react '+id);}},await h.ownerRecent(origin),()=>{});
 const options:any={messages:[],toolCallId:'fixture'};
 await tools.search_history.execute!({query:'',limit:20,role:'all',exact:false},options);
 await assert.rejects(Promise.resolve().then(()=>tools.send_message.execute!({text:'test',reply_to:'888'},options)),/known message/);
 await assert.rejects(Promise.resolve().then(()=>tools.react!.execute!({emoji:'👍',message_id:'888'},options)),/known message/);
 await tools.send_message.execute!({text:'test',reply_to:'999'},options);assert.deepEqual(out,['send 999']);
 const notices:string[]=[];origin.timestamp=Date.now();bindLocalDM(origin,()=>true,async t=>{notices.push(t);});const pending=service.require(origin,'run_command',{command:'pkill sshd'});await new Promise(r=>setImmediate(r));const nonce=notices[0]!.match(/\/confirm ([a-f0-9-]+)/)![1]!;
 const cross=msg('whatsapp');cross.timestamp=Date.now();cross.text='/confirm '+nonce;bindLocalDM(cross,()=>true,async()=>{});await service.handle(cross);let approved=false;pending.then(()=>{approved=true;},()=>{});await new Promise(r=>setImmediate(r));assert.equal(approved,false);
 const direct=msg('telegram',owner,'998');direct.timestamp=Date.now();direct.text='/confirm '+nonce;bindLocalDM(direct,()=>true,async()=>{});await service.handle(direct);await pending;assert.equal(approved,true);
 }finally{service.close();config.reactions=oldReactions;disable();rmSync(dir,{recursive:true,force:true});}
});
