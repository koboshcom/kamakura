import {activeTasks} from '../src/active-tasks.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {config} from '../src/config.js';
import {localDMControl} from '../src/local-device-dm.js';
import type {IncomingMessage} from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { LocalDevices,type LocalDeviceStore,type DeviceRecord,type PairRecord,type ActionAudit,type ApprovalNotice } from '../src/local-devices.js';
import { localDeviceTools } from '../src/local-device-tools.js';
class MemoryStore implements LocalDeviceStore {
 pairs=new Map<string,PairRecord>();devices=new Map<string,DeviceRecord>();audits:ActionAudit[]=[];
 async putPair(r:PairRecord){this.pairs.set(r.codeHash,{...r});}async consumePair(h:string,now:number){const r=this.pairs.get(h);if(!r||r.expiresAt<=now)return null;this.pairs.delete(h);return r;}
 async putDevice(r:DeviceRecord){this.devices.set(r.deviceId,{...r});}async byToken(h:string){return [...this.devices.values()].find(r=>r.tokenHash===h&&!r.revoked)??null;}
 async get(o:string,id:string){const r=this.devices.get(id);return r?.ownerId===o&&!r.revoked?r:null;}async list(o:string){return [...this.devices.values()].filter(r=>r.ownerId===o&&!r.revoked);}
 async revoke(o:string,id:string){const r=await this.get(o,id);if(!r)return false;r.revoked=true;return true;}async audit(r:ActionAudit){this.audits.push(r);}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
async function setup(){const store=new MemoryStore(),owners=new Set(['a','b']);const service=new LocalDevices({dataDir:'/unused',store,authorized:o=>owners.has(o),requestTtlMs:1000,approvalTtlMs:200});const server=service.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;const pair=await service.issuePairCode('a');const device=await service.pair(pair.code,'computer','linux');const ws=new WebSocket(base.replace('http','ws')+'/local-devices/connect',{headers:{Authorization:`Bearer ${device.token}`}});await once(ws,'open');const messages:Record<string,unknown>[]=[];ws.on('message',data=>(()=>{const m=JSON.parse(data.toString());if(m.type!=='session')messages.push(m);})());ws.send(JSON.stringify({type:'hello',version:2}));await wait();const resume=async()=>{ws.send(JSON.stringify({type:'pause',paused:false}));await wait();};return {store,owners,service,base,device,ws,messages,resume,close:()=>service.close()};}
test('pair codes consumed atomically; hash-only persistence; owner isolated listing and revocation',async()=>{const x=await setup();try{const {code}=await x.service.issuePairCode('a');const attempts=await Promise.allSettled([x.service.pair(code,'one','linux'),x.service.pair(code,'two','linux')]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert(!JSON.stringify([...x.store.devices.values()]).includes(x.device.token));assert(!JSON.stringify([...x.store.pairs.values()]).includes(code));assert.equal((await x.service.list('b')).length,0);assert.equal(await x.service.revoke('b',x.device.deviceId),false);await assert.rejects(x.service.issuePairCode('evil'));assert.equal(await x.service.revoke('a',x.device.deviceId),true);assert.equal((await x.service.list('a')).some(d=>d.deviceId===x.device.deviceId),false);}finally{await x.close();}});
test('starts paused; shell waits for single-use exact-owner approval; audit contains no command',async()=>{const x=await setup();try{await assert.rejects(x.service.execute('a',x.device.deviceId,'snapshot',{}),/paused/);await x.resume();let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_owner,n)=>{notice=n;});const args={command:'rm -rf /work/fixture-only'};const promise=x.service.execute('a',x.device.deviceId,'shell',args);await wait();assert(notice);args.command='changed';assert.equal(x.messages.length,0);assert.equal(await x.service.approve('b',notice.approvalId,true),false);assert.equal(await x.service.approve('a',notice.approvalId,true),true);await wait();const request=x.messages[0]!;assert.deepEqual(request.args,{command:'rm -rf /work/fixture-only'});assert.equal(await x.service.approve('a',notice.approvalId,true),false);x.ws.send(JSON.stringify({type:'result',id:request.id,ok:true,result:{stdout:'test'}}));assert.deepEqual(await promise,{stdout:'test'});assert(!JSON.stringify(x.store.audits).includes('secret-password'));await assert.rejects(x.service.execute('b',x.device.deviceId,'snapshot',{}));}finally{await x.close();}});
test('read-only snapshot bypasses approval; dangerous-intent cua requires approval and denied requests never sent',async()=>{const x=await setup();try{await x.resume();await assert.rejects(x.service.execute('a',x.device.deviceId,'snapshot',{command:'touch file'}));await assert.rejects(x.service.execute('a',x.device.deviceId,'other' as 'shell',{}));let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_o,n)=>{notice=n;});const denied=x.service.execute('a',x.device.deviceId,'cua',{tool:'click',args:{}},undefined,undefined,true);const rejection=assert.rejects(denied,/denied/);await wait();assert(notice);await x.service.approve('a',notice.approvalId,false);await rejection;assert.equal(x.messages.length,0);const snapshot=x.service.execute('a',x.device.deviceId,'snapshot',{});await wait();assert.equal(x.messages[0]?.action,'snapshot');x.ws.send(JSON.stringify({type:'result',id:x.messages[0]?.id,ok:true,result:'image'}));assert.equal(await snapshot,'image');}finally{await x.close();}});
test('pause cancels sent requests and invalidates waiting approvals; resume cannot resurrect',async()=>{const x=await setup();try{await x.resume();let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_o,n)=>{notice=n;});const waiting=x.service.execute('a',x.device.deviceId,'shell',{command:'rm -rf /work/fixture-only'});const denied=assert.rejects(waiting,/paused/);const sent=x.service.execute('a',x.device.deviceId,'snapshot',{});const cancelled=assert.rejects(sent,/paused/);await wait();x.ws.send(JSON.stringify({type:'pause',paused:true}));await Promise.all([denied,cancelled]);await wait();assert(x.messages.some(m=>m.type==='cancel'));await x.resume();assert(notice);assert.equal(await x.service.approve('a',notice.approvalId,true),false);}finally{await x.close();}});
test('abort, approval expiry, revoke, shutdown all invalidate requests',async()=>{const x=await setup();try{await x.resume();let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_o,n)=>{notice=n;});const ctrl=new AbortController();const aborted=x.service.execute('a',x.device.deviceId,'shell',{command:'rm -rf /work/fixture-only'},ctrl.signal);const rejected=assert.rejects(aborted,/aborted/);await wait();ctrl.abort();await rejected;assert(notice);assert.equal(await x.service.approve('a',notice.approvalId,true),false);const expired=x.service.execute('a',x.device.deviceId,'shell',{command:'rm -rf /work/fixture-only'});await assert.rejects(expired,/expired/);const revoking=x.service.execute('a',x.device.deviceId,'snapshot',{});const revoked=assert.rejects(revoking,/revoked/);await wait();await x.service.revoke('a',x.device.deviceId);await revoked;}finally{await x.close();}});
test('browser Origin and invalid bearer tokens denied on machine websocket; HTTP pair bounded',async()=>{const x=await setup();try{for(const headers of [{Authorization:`Bearer ${x.device.token}`,Origin:'https://evil.example'},{Authorization:'Bearer invalid'}]){const ws=new WebSocket(x.base.replace('http','ws')+'/local-devices/connect',{headers});const event=await new Promise<number>(resolve=>{ws.on('unexpected-response',(_req,res)=>{resolve(res.statusCode!);ws.terminate();});ws.on('error',()=>{});});assert.equal(event,403);}const response=await fetch(x.base+'/local-devices/pair',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'});assert.equal(response.status,404);const large=await fetch(x.base+'/local-devices/pair',{method:'POST',body:'x'.repeat(3000)});assert.equal(large.status,403);}finally{await x.close();}});
test('reconnect replaces and cancels outstanding request; starts paused again',async()=>{const x=await setup();try{await x.resume();const p=x.service.execute('a',x.device.deviceId,'snapshot',{});const rejection=assert.rejects(p,/reconnected/);await wait();const second=new WebSocket(x.base.replace('http','ws')+'/local-devices/connect',{headers:{Authorization:`Bearer ${x.device.token}`}});await once(second,'open');second.send(JSON.stringify({type:'hello',version:2}));await rejection;await wait();assert.equal((await x.service.list('a'))[0]?.paused,true);await assert.rejects(x.service.execute('a',x.device.deviceId,'snapshot',{}),/paused/);second.close();}finally{await x.close();}});
test('shutdown invalidates approvals across restart, devices remain durable and private',async()=>{const x=await setup();await x.resume();let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_o,n)=>{notice=n;});const p=x.service.execute('a',x.device.deviceId,'shell',{command:'rm -rf /work/fixture-only'});const rejection=assert.rejects(p,/closed/);await wait();assert(notice);assert.equal(notice.preview,JSON.stringify({command:'rm -rf /work/fixture-only'}));await x.close();await rejection;const restarted=new LocalDevices({dataDir:'/unused',store:x.store,authorized:o=>o==='a'});assert.equal(await restarted.approve('a',notice.approvalId,true),false);assert.equal((await restarted.list('a'))[0]?.paused,true);await restarted.close();});
test('request timeout emits cancel and late result cannot revive it',async()=>{const x=await setup();try{await x.resume();const p=x.service.execute('a',x.device.deviceId,'snapshot',{});await assert.rejects(p,/expired/);await wait();assert(x.messages.some(m=>m.type==='cancel'));x.ws.send(JSON.stringify({type:'result',id:x.messages.find(m=>m.type==='request')?.id,ok:true,result:'late'}));await wait();assert.equal(x.store.audits.filter(a=>a.state==='completed').length,0);}finally{await x.close();}});
test('concealed executable approval is rejected before notifier, audit or dispatch',async()=>{const x=await setup();try{await x.resume();let notices=0;x.service.setApprovalNotifier(()=>{notices++;});const before=x.store.audits.length;for(const command of ['password=harmlessliteral','password=$(touch${IFS}/tmp/never-run)'])await assert.rejects(x.service.execute('a',x.device.deviceId,'shell',{command}),/Exact action approval unavailable/);assert.equal(notices,0);assert.equal(x.store.audits.length,before);assert.equal(x.messages.length,0);}finally{await x.close();}});
test('worker tools withheld from groups, another chat, and unauthorized owners',()=>{const service=new LocalDevices({dataDir:'/unused',store:new MemoryStore(),authorized:()=>true});const incoming={transport:'telegram' as const,chatId:'a',senderId:'a',sender:'a',id:'1',text:'',isGroup:false,timestamp:0};assert.equal(Object.keys(localDeviceTools(incoming,service,()=>true)).length,0);assert.deepEqual(localDeviceTools({...incoming,isGroup:true},service,()=>true),{});assert.deepEqual(localDeviceTools({...incoming,chatId:'b'},service,()=>true),{});assert.deepEqual(localDeviceTools(incoming,service,()=>false),{});});

test('ordinary local shell and CUA dispatch prompt-free, always remain paused/revoke/session guarded',async()=>{const x=await setup();try{await x.resume();let notices=0;x.service.setApprovalNotifier(()=>{notices++;});for(const [action,args] of [['shell',{command:'pwd'}],['cua',{tool:'list_windows',args:{}}]] as const){const p=x.service.execute('a',x.device.deviceId,action,args);await wait();const req=x.messages.filter(m=>m.type==='request').at(-1)!;assert.equal(req.action,action);assert.equal(JSON.parse(Buffer.from(String(req.authorization),'base64').toString()).human,false);x.ws.send(JSON.stringify({type:'result',id:req.id,ok:true,result:'fixture'}));assert.equal(await p,'fixture');}assert.equal(notices,0);}finally{await x.close();}});

test('legacy protocol cannot dispatch even a benign action and gives explicit update instructions',async()=>{
 const x=await setup();try{
 const legacy=new WebSocket(x.base.replace('http','ws')+'/local-devices/connect',{headers:{Authorization:'Bearer '+x.device.token}});
 await once(legacy,'open');legacy.send(JSON.stringify({type:'hello',version:1}));legacy.send(JSON.stringify({type:'pause',paused:false}));await wait();
 await assert.rejects(x.service.execute('a',x.device.deviceId,'shell',{command:'pwd'}),/protocol update required/);
 legacy.close();
 }finally{await x.close();}
});
test('immutable CUA coordinates, inputs, purpose and risk are confirmed once only',async()=>{
 const x=await setup();try{await x.resume();let notice:ApprovalNotice|undefined;x.service.setApprovalNotifier((_o,n)=>{notice=n;});
 const args={tool:'click',args:{x:12,y:34},purpose:'submit an external message',risk:'destructive'};
 const p=x.service.execute('a',x.device.deviceId,'cua',args);await wait();assert(notice);assert.equal(x.messages.length,0);
 args.args.x=99;args.purpose='changed';
 assert.equal(await x.service.approve('a',notice.approvalId,true),true);await wait();
 const request=x.messages.find(m=>m.type==='request')!;
 assert.deepEqual(request.args,{tool:'click',args:{x:12,y:34},purpose:'submit an external message',risk:'destructive'});
 const envelope=JSON.parse(Buffer.from(String(request.authorization),'base64').toString());
 assert.equal(envelope.human,true);assert.equal(envelope.nonce,notice.approvalId);
 assert.equal(await x.service.approve('a',notice.approvalId,true),false);
 x.ws.send(JSON.stringify({type:'result',id:request.id,ok:true,result:'fixture'}));await p;
 }finally{await x.close();}
});

test('single scratch file removal does not ask for confirmation',async()=>{
 const x=await setup();try{
 await x.resume();let asked=false;x.service.setApprovalNotifier(()=>{asked=true;});
 const p=x.service.execute('a',x.device.deviceId,'shell',{command:'rm /work/scratch.txt',risk:'normal',purpose:'remove own scratch file'});
 await wait();assert.equal(asked,false);const request=x.messages.find(m=>m.type==='request')!;assert(request);
 x.ws.send(JSON.stringify({type:'result',id:request.id,ok:true,result:'fixture only'}));await p;
 }finally{await x.close();}
});

test('held local task stops once without DM approval and sends cancellation out of band',{timeout:5000},async()=>{
 const x=await setup();config.sandbox.allowed.add('a');let notices=0;const sent:string[]=[];
 const m={transport:'discord',chatId:'private',senderId:'a',authenticatedOwner:true,isGroup:false,id:'task-origin',text:'fixture',timestamp:Date.now()} as IncomingMessage;
 bindLocalDM(m,()=>true,async text=>{sent.push(text)});
 try{
 await x.resume();x.service.setApprovalNotifier(()=>{notices++});
 const result=x.service.execute('a',x.device.deviceId,'shell',{command:'fixture-only'},undefined,localDMControl.approvalContext(m));
 const rejected=assert.rejects(result,/Owner stopped/);
 await wait();const req=x.messages.find(m=>m.type==='request')!;assert(req);assert.equal(notices,0);
 assert.equal(sent.length,0);
 x.ws.send(JSON.stringify({type:'task_started',id:req.id}));await wait();
 const handle=sent[0]?.match(/stop_task ([a-f0-9-]{36})/)?.[1];assert(handle);
 assert.equal(await activeTasks.stop(m,handle),true);await rejected;await wait();
 assert.equal(x.messages.filter(m=>m.type==='cancel'&&m.id===req.id).length,1);
 assert.equal(await activeTasks.stop(m,handle),false);assert.equal(notices,0);
 }finally{await x.close();config.sandbox.allowed.delete('a')}
});
