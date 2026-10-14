import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {config} from '../src/config.js';
import {bindLocalDM,localDMOwner,copyLocalDM,consumeLocalCommand} from '../src/local-dm-context.js';
import {LocalDMControl} from '../src/local-device-dm.js';
import {LocalDevices,type LocalDeviceStore,type DeviceRecord,type PairRecord,type ActionAudit} from '../src/local-devices.js';
import {localDeviceTools} from '../src/local-device-tools.js';
import {canWork,workTools} from '../src/work-tools.js';
import {whatsappConfig} from '../src/whatsapp-config.js';
import {WhatsAppTransport} from '../src/transports/whatsapp.js';
import {ReplyBatches} from '../src/batching.js';
import type {IncomingMessage} from '../src/types.js';
const owner='discord-111111111111111111',account='111111111111111111',other='discord-222222222222222222';
class Store implements LocalDeviceStore {
 pairs=new Map<string,PairRecord>();devices=new Map<string,DeviceRecord>();audits:ActionAudit[]=[];
 async putPair(r:PairRecord){this.pairs.set(r.codeHash,r);}async consumePair(h:string,n:number){const r=this.pairs.get(h);if(!r||r.expiresAt<=n)return null;this.pairs.delete(h);return r;}
 async putDevice(r:DeviceRecord){this.devices.set(r.deviceId,r);}async byToken(h:string){return [...this.devices.values()].find(r=>r.tokenHash===h&&!r.revoked)??null;}
 async get(o:string,id:string){const r=this.devices.get(id);return r?.ownerId===o&&!r.revoked?r:null;}async list(o:string){return [...this.devices.values()].filter(r=>r.ownerId===o&&!r.revoked);}
 async revoke(o:string,id:string){const r=await this.get(o,id);if(!r)return false;r.revoked=true;return true;}async audit(r:ActionAudit){this.audits.push(r);}
}
const wait=()=>new Promise(r=>setTimeout(r,25));
function message(text:string,transport:'discord'|'whatsapp'='discord'):IncomingMessage {
 return {transport,chatId:transport==='discord'?'dm:'+account:'15551234567@s.whatsapp.net',senderId:owner,sender:owner,authenticatedOwner:true,authenticatedAccountId:transport==='discord'?account:undefined,isGroup:false,id:randomUUID(),text,timestamp:Date.now()};
}
function trusted(text:string,transport:'discord'|'whatsapp'='discord',current=()=>true,out:string[]=[]){const m=message(text,transport);bindLocalDM(m,current,async text=>{out.push(text);});return m;}
test('capability, not serialized identity, gates tools; clones, groups, stale sessions and mutation denied',()=>{
 config.sandbox.allowed.add(owner);
 try{
 const m=trusted('task'),devices=new LocalDevices({dataDir:'/unused',store:new Store(),authorized:()=>true});
 assert.equal(canWork(m,()=>true),true);assert.equal(Object.keys(localDeviceTools(m,devices,()=>true)).length,4);assert.deepEqual(workTools(m),{});
 for(const fake of [{...m},{...m,isGroup:true},{...m,chatId:'dm:other'},{...m,senderId:other},JSON.parse(JSON.stringify(m))]){assert.equal(localDMOwner(fake),undefined);assert.deepEqual(localDeviceTools(fake,devices,()=>true),{});}
 const copy=copyLocalDM(m,{...m});assert.equal(localDMOwner(copy),owner);
 m.senderId=other;assert.equal(localDMOwner(m),undefined);m.senderId=owner;m.text='/pair';assert.equal(consumeLocalCommand(m),undefined);
 let active=true;const stale=trusted('/pair','discord',()=>active);active=false;assert.equal(localDMOwner(stale),undefined);
 assert.equal(consumeLocalCommand(trusted('/pair'))?.owner,owner);
 const once=trusted('/pair');assert(consumeLocalCommand(once));assert.equal(consumeLocalCommand(once),undefined);
 const old=message('/pair');old.timestamp=Date.now()-120001;bindLocalDM(old,()=>true,async()=>{});assert.equal(consumeLocalCommand(old),undefined);
 config.sandbox.allowed.delete(owner);assert.equal(localDMOwner(copy),undefined);
 }finally{config.sandbox.allowed.delete(owner);}
});
test('pair/list/revoke direct commands on both transports never require Telegram and never accept forged commands',async()=>{
 config.sandbox.allowed.add(owner);const store=new Store(),devices=new LocalDevices({dataDir:'/unused',store,authorized:o=>o===owner}),control=new LocalDMControl();
 try{for(const transport of ['discord','whatsapp'] as const){
 const out:string[]=[],m=trusted('/pair',transport,()=>true,out);
 assert.equal(await control.handle({...m},devices),true);assert.equal(out.length,0);
 await control.handle(m,devices);await control.handle(m,devices);assert.equal(out.length,1);
 const code=out[0]!.split('\n')[1]!;assert.match(code,/^[a-f0-9]{64}$/);
 const paired=await devices.pair(code,'fixture','linux');await assert.rejects(devices.pair(code,'fixture','linux'));
 await control.handle(trusted('/devices',transport,()=>true,out),devices);assert(out.at(-1)!.includes(paired.deviceId));
 await control.handle(trusted('/revoke '+paired.deviceId,transport,()=>true,out),devices);assert.equal((await devices.list(owner)).length,0);
 }assert.equal(config.telegramAllowed.has(owner),false);
 }finally{await devices.close();config.sandbox.allowed.delete(owner);}
});
test('real fixture connector accepts only exact scoped same-DM approval; replay, cross-transport, expiry/session and snapshots remain isolated',async()=>{
 config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);
 const service=new LocalDevices({dataDir:'/unused',store:new Store(),authorized:o=>[owner,other].includes(o),approvalTtlMs:300,requestTtlMs:800}),control=new LocalDMControl();
 const server=service.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
 const pair=await service.issuePairCode(owner),device=await service.pair(pair.code,'fixture','linux');
 const ws=new WebSocket('ws://127.0.0.1:'+addr.port+'/local-devices/connect',{headers:{Authorization:'Bearer '+device.token}});await once(ws,'open');
 const received:any[]=[];ws.on('message',data=>(()=>{const m=JSON.parse(data.toString());if(m.type!=='session')received.push(m);})());ws.send(JSON.stringify({type:'hello',version:2}));ws.send(JSON.stringify({type:'pause',paused:false}));await wait();
 try{
 for(const transport of ['discord','whatsapp'] as const){
 const out:string[]=[],origin=trusted('task',transport,()=>true,out),approval=control.approvalContext(origin);
 const pending=service.execute(owner,device.deviceId,'shell',{command:'rm -rf /work/fixture-only'},undefined,approval);await wait();
 const id=out.at(-1)!.match(/\/approve ([a-f0-9-]+)/)![1]!;
 assert.equal(received.filter(m=>m.type==='request').length,0);
 assert.equal(await service.approve(owner,id,true),false,'Telegram notifier cannot approve a DM scoped action');
 await control.handle(trusted('/approve '+id,transport==='discord'?'whatsapp':'discord'),service);
 await control.handle(message('/approve '+id,transport),service);
 const foreign=message('/approve '+id,transport);foreign.senderId=other;bindLocalDM(foreign,()=>true,async()=>{});await control.handle(foreign,service);
 assert.equal(received.filter(m=>m.type==='request').length,0);
 await control.handle(trusted('/approve '+id,transport),service);await wait();
 const request=received.find(m=>m.type==='request');assert.deepEqual(request.args,{command:'rm -rf /work/fixture-only'});
 await control.handle(trusted('/approve '+id,transport),service);await wait();assert.equal(received.filter(m=>m.type==='request').length,1);
 ws.send(JSON.stringify({type:'result',id:request.id,ok:true,result:'done'}));assert.equal(await pending,'done');received.length=0;
 const snapshot=service.execute(owner,device.deviceId,'snapshot',{},undefined,control.approvalContext(origin));await wait();const req=received.find(m=>m.type==='request');assert.equal(req.action,'snapshot');ws.send(JSON.stringify({type:'result',id:req.id,ok:true,result:'image'}));assert.equal(await snapshot,'image');received.length=0;
 }
 let active=true;const out:string[]=[],origin=trusted('task','discord',()=>active,out),scope=control.approvalContext(origin);
 const stale=service.execute(owner,device.deviceId,'shell',{command:'rm -rf /work/fixture-only'},undefined,scope),rejected=assert.rejects(stale,/expired/);await wait();active=false;
 const id=out[0]!.match(/\/approve ([a-f0-9-]+)/)![1]!;await control.handle(trusted('/approve '+id),service);await rejected;assert.equal(received.length,0);
 await assert.rejects(service.execute(other,device.deviceId,'snapshot',{}));
 // Changed source bytes in outbound formatting or an overlong exact preview must fail, never silently truncate.
 for(const command of ['x'.repeat(1800),'cite'+'turn1search1']){
 const out:string[]=[],m=trusted('task','discord',()=>true,out);
 await assert.rejects(service.execute(owner,device.deviceId,'shell',{command},undefined,control.approvalContext(m),true),/delivery failed/);
 assert.equal(out.length,0);
 }
 }finally{await service.close();config.sandbox.allowed.delete(owner);config.sandbox.allowed.delete(other);}
});
test('WhatsApp arbitrary explicitly allowlisted owners; adapter rejects quote/forward/wrapper/group/replay and invalidates session',async()=>{
 const env={WHATSAPP_ENABLED:'true',WHATSAPP_AUTH_DIR:'/run/private/local-dm-fixture',WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':owner}),WHATSAPP_ALLOWED_NUMBERS:'+15551234567',SANDBOX_ALLOWED_USERS:owner};
 const cfg=whatsappConfig(env);assert.equal(cfg.owners.get('15551234567@s.whatsapp.net'),owner);
 assert.throws(()=>whatsappConfig({...env,SANDBOX_ALLOWED_USERS:other}));assert.throws(()=>whatsappConfig({...env,WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':'../evil'})}));
 const got:IncomingMessage[]=[],seen=new Set<string>(),tr:any=new WhatsAppTransport(cfg,{claim:async(id:string)=>{if(seen.has(id))return false;seen.add(id);return true;}});
 tr.stopped=false;tr.connected=true;tr.socket={signalRepository:{lidMapping:{getPNForLID:async()=>null}}};tr.onMessage=(m:IncomingMessage)=>got.push(m);config.sandbox.allowed.add(owner);
 const send=async(message:any,extra:any={})=>{const id=randomUUID();await tr.receive({key:{remoteJid:'15551234567@s.whatsapp.net',id,...extra.key},messageTimestamp:Date.now()/1000,message,...extra},tr.socket);return got.at(-1);};
 try{
 const clean=await send({conversation:'/pair'});assert.equal(localDMOwner(clean!),owner);
 for(const content of [{extendedTextMessage:{text:'/pair',contextInfo:{isForwarded:true}}},{extendedTextMessage:{text:'/pair',contextInfo:{quotedMessage:{conversation:'task'},stanzaId:'x'}}},{conversation:'> /pair'},{conversation:'/pair',messageContextInfo:{}},{ephemeralMessage:{message:{conversation:'/pair'}}}]){
 const before=got.length;await send(content);if(got.length>before)assert.equal(localDMOwner(got.at(-1)!),undefined);
 }
 const count=got.length;await tr.receive({key:{remoteJid:'15551234567@s.whatsapp.net',id:clean!.id},messageTimestamp:Date.now()/1000,message:{conversation:'/pair'}},tr.socket);assert.equal(got.length,count);
 await send({conversation:'/pair'},{key:{remoteJid:'1@g.us',id:randomUUID()}});assert.equal(got.length,count);
 tr.localGeneration++;assert.equal(localDMOwner(clean!),undefined);
 }finally{config.sandbox.allowed.delete(owner);}
});
test('batching carries only authenticated capabilities and drops them if any combined text is untrusted',async()=>{
 config.sandbox.allowed.add(owner);try{for(const untrusted of [false,true]){
 let result:IncomingMessage|undefined;const batches=new ReplyBatches(1,8000,async m=>{result=m;},()=>{},error=>{throw error;});
 const first=untrusted?message('untrusted'):trusted('first'),second=trusted('second');
 batches.receive(first);batches.receive(second);await wait();assert(result);assert.equal(!!localDMOwner(result),!untrusted);batches.stop();
 }}finally{config.sandbox.allowed.delete(owner);}
});
