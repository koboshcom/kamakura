import test from 'node:test';
import assert from 'node:assert/strict';
import {ActiveTasks} from '../src/active-tasks.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {config} from '../src/config.js';
import type {IncomingMessage} from '../src/types.js';
function message(owner='active-test',chat='private',current=()=>true){
 config.sandbox.allowed.add(owner);
 const m={transport:'discord',chatId:chat,senderId:owner,authenticatedOwner:true,isGroup:false,id:crypto.randomUUID(),text:'fixture',timestamp:Date.now()} as IncomingMessage;
 bindLocalDM(m,current,async()=>{});return m;
}
test('actual held task stop once; foreign, stale session, protected handle and guessed PID cannot stop',{timeout:5000},async()=>{
 const tasks=new ActiveTasks();let stops=0,active=true,session=true;
 const origin=message('active-test','private',()=>session);
 const t=tasks.register(origin,async()=>{stops++},()=>active,false);
 assert(!await tasks.stop(message('foreign-test'),t.id));
 assert(!await tasks.stop(message('active-test','other'),t.id));
 assert(!await tasks.stop(origin,'1234'));
 assert(await tasks.stop(message(),t.id));assert.equal(stops,1);
 assert(!await tasks.stop(origin,t.id));assert.equal(stops,1);
 const critical=tasks.register(origin,async()=>{stops++},()=>true,true);
 assert(!await tasks.stop(origin,critical.id));assert.equal(stops,1);critical.close();
 const stale=tasks.register(origin,async()=>{stops++},()=>active,false);
 active=false;assert(!await tasks.stop(origin,stale.id));active=true;stale.close();assert(!await tasks.stop(origin,stale.id));
 const changed=tasks.register(origin,async()=>{stops++},()=>true,false);session=false;
 assert(!await tasks.stop(message(),changed.id));assert.equal(stops,1);changed.close();
 config.sandbox.allowed.delete('active-test');config.sandbox.allowed.delete('foreign-test');
});

test('cloud stop resolves the retained execution container abort, never a PID',{timeout:5000},async()=>{
 const {SandboxManager}=await import('../src/sandbox.js');
 const {PassThrough}=await import('node:stream');
 const stream=new PassThrough();let starts=0,kills=0,handle='';
 const container={exec:async()=>({start:async()=>{starts++;return stream},inspect:async()=>({ExitCode:0})}),kill:async()=>{kills++;stream.destroy()}};
 const docker={modem:{demuxStream:()=>{}}};
 const manager=new SandboxManager({...config.sandbox,commandMs:1000},docker as any);
 const tasks=new ActiveTasks(),m=message();
 const run=(manager as any).execute(container,'fixture-only',1000,undefined,1000,(stop:()=>Promise<void>)=>{
 const t=tasks.register(m,stop,()=>true,false);handle=t.id;return t.close;
 });
 await new Promise(resolve=>setImmediate(resolve));assert.equal(starts,1);assert(handle);
 assert(await tasks.stop(m,handle));await run;assert.equal(kills,1);
 assert(!await tasks.stop(m,handle));assert.equal(kills,1);
 config.sandbox.allowed.delete('active-test');
});
