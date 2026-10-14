import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {guardedTaildrop} from '../src/taildrop-transfer.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {dangerousConfirmations} from '../src/dangerous-confirmations.js';
import {transferStore} from '../src/transfer-store.js';
import type {IncomingMessage} from '../src/types.js';
const owner='987654326',other='987654327',data=Buffer.from('fresh artifact'),sha256=createHash('sha256').update(data).digest('hex');
const message=(id:string,who=owner,text='send file to laptop'):IncomingMessage=>({id,text,transport:'telegram',chatId:who,sender:who,senderId:who,isGroup:false,authenticatedOwner:true,learningEligible:true,timestamp:Date.now()});
test('Taildrop current enrolled box security is independent of generic habits; new destination zero until same-DM consent; known success, failures and foreign history',async()=>{
 for(const who of [owner,other]){config.sandbox.allowed.add(who);config.telegramAllowed.add(who);}
 const original={read:sandboxes.workspaceBytes,enrollment:sandboxes.tailscaleEnrollment,send:sandboxes.taildropBytes};
 let calls=0,fail=false,active=true;const box='mockbox',enrollment='exact-owner-enrollment';
 sandboxes.workspaceBytes=async(who,path)=>({data,sha256,bytes:data.length,path,box});
 sandboxes.tailscaleEnrollment=async()=>({box,enrollment});
 sandboxes.taildropBytes=async(who,file,target,actual)=>{calls++;assert.equal(who,owner);assert.equal(file.sha256,sha256);assert.equal(actual,enrollment);if(fail)throw new Error('transfer failed');return {output:'complete',exitCode:0,timedOut:false};};
 try{
 let notified!:()=>void;const notice=new Promise<void>(r=>notified=r);let approval='';
 const m=message('new');bindLocalDM(m,()=>active,async text=>{approval=/\/confirm [a-f0-9-]{36}/.exec(text)?.[0]??'';notified();});
 const pending=guardedTaildrop(m,'tailscale file cp fresh.txt laptop:');await notice;assert.equal(calls,0);assert.ok(approval);
 const foreign=message('foreign',other,approval);bindLocalDM(foreign,()=>true,async()=>{});await dangerousConfirmations.handle(foreign);assert.equal(calls,0);
 const reply=message('confirm',owner,approval);bindLocalDM(reply,()=>true,async()=>{});await dangerousConfirmations.handle(reply);
 assert.equal((await pending)?.exitCode,0);assert.equal(calls,1);assert.equal(await transferStore.known(owner,box,enrollment,'laptop'),true);assert.equal(await transferStore.known(other,box,enrollment,'laptop'),false);
 const next=message('known');let prompts=0;bindLocalDM(next,()=>active,async()=>{prompts++;});assert.equal((await guardedTaildrop(next,'tailscale file cp fresh.txt laptop:'))?.exitCode,0);assert.equal(calls,2);assert.equal(prompts,0);
 await assert.rejects(guardedTaildrop(next,'tailscale file cp fresh.txt laptop:'));assert.equal(calls,2);
 await assert.rejects(guardedTaildrop(next,'tailscale file cp ../secret laptop:'));assert.equal(calls,2);
 await assert.rejects(guardedTaildrop(next,'tailscale file cp fresh.txt $TARGET:'));assert.equal(calls,2);
 fail=true;const failed=message('failed');bindLocalDM(failed,()=>active,async()=>{});await assert.rejects(guardedTaildrop(failed,'tailscale file cp fresh.txt laptop:'));assert.equal(calls,3);await assert.rejects(guardedTaildrop(failed,'tailscale file cp fresh.txt laptop:'));assert.equal(calls,3);
 active=false;await assert.rejects(guardedTaildrop(next,'tailscale file cp fresh.txt laptop:'));assert.equal(calls,3);
 }finally{sandboxes.workspaceBytes=original.read;sandboxes.tailscaleEnrollment=original.enrollment;sandboxes.taildropBytes=original.send;dangerousConfirmations.close();}
});
