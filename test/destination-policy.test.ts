import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {destinationPolicy,resolveDestination} from '../src/destination-policy.js';
import {dangerousConfirmations} from '../src/dangerous-confirmations.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {transferStore} from '../src/transfer-store.js';
import type {IncomingMessage} from '../src/types.js';
const owner='987654331',other='987654332';
function message(id:string,text='transfer report',who=owner):IncomingMessage{
 return {transport:'telegram',chatId:who,senderId:who,sender:who,id,text,timestamp:Date.now(),isGroup:false,authenticatedOwner:true};
}
test('generic verified owner-used destination skips only ordinary transfer; new/foreign/danger requires fresh same-DM confirmation',async()=>{
 for(const o of [owner,other]){config.sandbox.allowed.add(o);config.telegramAllowed.add(o);}
 const metadata={owner,target:'exact-device-id',box:'owner-box',authority:'owner-map-v1'};
 await transferStore.remember(owner,metadata.box,metadata.authority,metadata.target);
 let executions=0,active=true,approval='',notify=()=>{};
 const m=message('known');
 bindLocalDM(m,()=>active,async text=>{approval=/\/confirm [a-f0-9-]{36}/.exec(text)?.[0]??'';notify();});
 const proof=await resolveDestination(m,async()=>({metadata,current:()=>active}));assert.ok(proof);
 const remember=await destinationPolicy(m,'ordinary_file_send',{artifact:'fresh'},proof,false);
 executions++;await remember({receipt:'actual-executor-success'});assert.equal(executions,1);
 let ready=new Promise<void>(r=>notify=r);
 const danger=destinationPolicy(m,'dangerous_change',{exact:'action'},proof,true);
 await ready;assert.equal(executions,1);assert.ok(approval);
 const foreign=message('foreign',approval,other);bindLocalDM(foreign,()=>true,async()=>{});
 await dangerousConfirmations.handle(foreign);assert.equal(executions,1);
 const reply=message('reply',approval);bindLocalDM(reply,()=>true,async()=>{});
 await dangerousConfirmations.handle(reply);await danger;executions++;assert.equal(executions,2);
 ready=new Promise<void>(r=>notify=r);
 const unknown=destinationPolicy(m,'unverifiable_shell_target',{command:'arbitrary-tool send'},Object.freeze({known:true}),false);
 await ready;assert.equal(executions,2);
 const cancel=message('cancel',approval.replace('/confirm','/cancel'));bindLocalDM(cancel,()=>true,async()=>{});
 await dangerousConfirmations.handle(cancel);await assert.rejects(unknown);assert.equal(executions,2);
 assert.equal(await resolveDestination(m,async()=>({metadata:{...metadata,owner:other},current:()=>true})),undefined);
 active=false;await assert.rejects(destinationPolicy(m,'send',{},proof));
});
