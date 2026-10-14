import {literalDownloadPath} from '../src/download-proof.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {sendFileTools,executionArtifacts} from '../src/send-file.js';
import {sandboxes} from '../src/sandbox.js';
import {transferPath,decodeWorkspaceBytes,workspaceReadPython} from '../src/workspace-bytes.js';
import {createHash} from 'node:crypto';
import {TelegramTransport} from '../src/transports/telegram.js';
import {WhatsAppTransport} from '../src/transports/whatsapp.js';
import {whatsappConfig} from '../src/whatsapp-config.js';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IncomingMessage} from '../src/types.js';
const owner='987654325';const data=Buffer.from('safe artifact'),sha256=createHash('sha256').update(data).digest('hex');
test('send_file immutable origin on all channels, successful actual upload receipt, duplicate/failure/current-owner revocation fail closed',async()=>{
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);
 const original=sandboxes.workspaceBytes;sandboxes.workspaceBytes=async(o,p)=>{assert.equal(o,owner);return {data,sha256,bytes:data.length,path:p,box:'fixture-owner-box'};};
 try{
 for(const channel of ['telegram','whatsapp','discord'] as const){
 let sends=0,active=true;const m:IncomingMessage={id:'file-'+channel,text:'send the result',transport:channel,chatId:channel==='telegram'?owner:'current-dm',sender:owner,senderId:owner,isGroup:false,authenticatedOwner:true,timestamp:Date.now()};
 bindLocalDM(m,()=>active,async()=>{},async file=>{sends++;assert.deepEqual(file.data,data);assert.equal(file.filename,'result.txt');return {receipt:'fixture'};});
 const tools=sendFileTools(m),opts={toolCallId:'one',messages:[]};assert.equal((await tools.send_file!.execute!({path:'result.txt'},opts) as any).sent,true);assert.equal(sends,1);
 await assert.rejects(async()=>tools.send_file!.execute!({path:'result.txt'},opts));assert.equal(sends,1);
 active=false;await assert.rejects(async()=>tools.send_file!.execute!({path:'other.txt'},opts));assert.equal(sends,1);
 assert.deepEqual(sendFileTools({...m}),{});
 }
 let attempts=0;const m:IncomingMessage={id:'failure',text:'send the result',transport:'telegram',chatId:owner,sender:owner,senderId:owner,isGroup:false,authenticatedOwner:true,timestamp:Date.now()};
 bindLocalDM(m,()=>true,async()=>{},async()=>{attempts++;throw new Error('upload failed');});const tools=sendFileTools(m),opts={toolCallId:'failure',messages:[]};
 await assert.rejects(async()=>tools.send_file!.execute!({path:'result.txt'},opts));await assert.rejects(async()=>tools.send_file!.execute!({path:'result.txt'},opts));assert.equal(attempts,1);
 sandboxes.workspaceBytes=async()=>{throw new Error('read failure');};await assert.rejects(async()=>tools.send_file!.execute!({path:'missing.txt'},opts));assert.equal(attempts,1);
 }finally{sandboxes.workspaceBytes=original;}
});
test('bounded canonical regular-file reads exclude traversal, symlinks, pipes, secrets and nested mounts',()=>{
 for(const p of ['/etc/passwd','../escape','a/../escape','a//file','.env','credentials.json','tokens.txt','/work/id_rsa','secret.dat'])assert.throws(()=>transferPath(p));
 assert.equal(transferPath('/work/reports/result.txt'),'reports/result.txt');
 const dir=mkdtempSync(join(tmpdir(),'workspace-read-'));try{
 mkdirSync(join(dir,'reports'));writeFileSync(join(dir,'reports','safe.txt'),data);symlinkSync('/etc/passwd',join(dir,'link.txt'));symlinkSync('/etc',join(dir,'outside'));spawnSync('mkfifo',[join(dir,'fifo')]);
 const script=workspaceReadPython.replace("os.open('/work'","os.open("+JSON.stringify(dir));
 const run=(p:string,cap=8192)=>spawnSync('python3',['-I','-c',script,p,String(cap)],{encoding:'utf8',timeout:3000});
 const safe=run('reports/safe.txt');assert.equal(safe.status,0);assert.deepEqual(decodeWorkspaceBytes(safe.stdout,'reports/safe.txt','box',8192).data,data);
 for(const p of ['link.txt','outside/passwd','fifo'])assert.notEqual(run(p).status,0);
 assert.notEqual(run('reports/safe.txt',2).status,0);
 assert.throws(()=>decodeWorkspaceBytes(JSON.stringify({data:data.toString('base64'),sha256:'bad',bytes:data.length}),'safe','box',8192));
 const secrets=Buffer.from('password=not-for-delivery');assert.throws(()=>decodeWorkspaceBytes(JSON.stringify({data:secrets.toString('base64'),sha256:createHash('sha256').update(secrets).digest('hex'),bytes:secrets.length}),'safe','box',8192));
 assert.match(workspaceReadPython,/mount\.startswith\('\/work\/'\)/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Telegram real upload adapter requires returned document and correct DM acknowledgement',async()=>{
 config.telegramAllowed.add(owner);const tr=new TelegramTransport('12345:offline-fixture-only'),api:any=tr.bot.api;const old=api.sendDocument;let calls=0;
 api.sendDocument=async(chat:string,file:any)=>{calls++;assert.equal(chat,owner);assert.ok(file);return {document:{file_id:'fixture'},chat:{id:Number(owner)},message_id:88};};
 try{assert.deepEqual(await tr.uploadFile(owner,{data,filename:'result.txt'}),{receipt:'88'});assert.equal(calls,1);await assert.rejects(tr.uploadFile('987000000',{data,filename:'result.txt'}));assert.equal(calls,1);
 api.sendDocument=async()=>({chat:{id:Number(owner)},message_id:88});await assert.rejects(tr.uploadFile(owner,{data,filename:'result.txt'}));
 await assert.rejects(tr.uploadFile(owner,{data:Buffer.alloc(8*1024*1024+1),filename:'large.bin'}));
 }finally{api.sendDocument=old;}
});
test('WhatsApp actual document upload waits for SDK acknowledgement, reserved ID and exact socket destination',async()=>{
 const chat='15551234567@s.whatsapp.net',cfg=whatsappConfig({WHATSAPP_ENABLED:'true',WHATSAPP_AUTH_DIR:'/run/private/wa',WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':owner}),WHATSAPP_ALLOWED_NUMBERS:'+15551234567',SANDBOX_ALLOWED_USERS:owner});
 const tr:any=new WhatsAppTransport(cfg,{claim:async()=>true});tr.stopped=false;tr.connected=true;let sends=0;tr.socket={user:{id:'other@s.whatsapp.net'},end:()=>{},sendMessage:async(jid:string,payload:any,options:any)=>{sends++;assert.equal(jid,chat);assert.deepEqual(payload.document,data);assert.equal(payload.fileName,'result.txt');return {key:{id:options.messageId,remoteJid:chat}};}};
 tr.destinations.set(chat,chat);
 try{assert.ok((await tr.uploadFile(chat,{data,filename:'result.txt'})).receipt);assert.equal(sends,1);
 await assert.rejects(tr.uploadFile('15559999999@s.whatsapp.net',{data,filename:'result.txt'}));assert.equal(sends,1);
 tr.socket.sendMessage=async()=>({key:{id:'foreign',remoteJid:chat}});await assert.rejects(tr.uploadFile(chat,{data,filename:'result.txt'}));
 }finally{await tr.stop();}
});
test('fresh successful execution artifacts are current-turn scoped, hash-bound, single-use; changed and foreign files are denied',async()=>{
 config.sandbox.allowed.add(owner);config.telegramAllowed.add(owner);
 const previous={read:sandboxes.workspaceBytes,changed:sandboxes.changedWorkspaceFiles};
 let changed=false,sends=0;
 sandboxes.changedWorkspaceFiles=async()=>['new.txt'];
 sandboxes.workspaceBytes=async(o,path)=>({data:changed?Buffer.from('changed'):data,sha256:changed?'different':sha256,bytes:data.length,path,box:'owner-artifact-box'});
 try{
  const m:IncomingMessage={id:'artifact-test',text:'download the report',transport:'telegram',chatId:owner,sender:owner,senderId:owner,isGroup:false,authenticatedOwner:true,timestamp:Date.now()};
  bindLocalDM(m,()=>true,async()=>{},async()=>{sends++;return {receipt:'fixture'};});
  const found=await executionArtifacts(m,Date.now());assert.equal(found.length,1);
  const opts={toolCallId:'artifact',messages:[]},tools=sendFileTools(m);
  changed=true;await assert.rejects(async()=>tools.send_file!.execute!({artifact_handle:found[0]!.artifact_handle},opts));assert.equal(sends,0);
  changed=false;assert.equal((await tools.send_file!.execute!({artifact_handle:found[0]!.artifact_handle},opts) as any).sent,true);assert.equal(sends,1);
  await assert.rejects(async()=>tools.send_file!.execute!({artifact_handle:found[0]!.artifact_handle},opts));assert.equal(sends,1);
  const fresh=await executionArtifacts(m,Date.now());const n={...m,id:'different-turn',timestamp:Date.now()};bindLocalDM(n,()=>true,async()=>{},async()=>{sends++;return {receipt:'bad'};});
  await assert.rejects(async()=>sendFileTools(n).send_file!.execute!({artifact_handle:fresh[0]!.artifact_handle},opts));assert.equal(sends,1);
 }finally{sandboxes.workspaceBytes=previous.read;sandboxes.changedWorkspaceFiles=previous.changed;}
});

test('literal download evidence requires exact output file, not stdout, echo or dynamic scripts',()=>{
 assert.equal(literalDownloadPath('curl -fsSL https://fixture.invalid/file -o fresh.txt'),'fresh.txt');
 assert.equal(literalDownloadPath('wget -q -O fresh.txt https://fixture.invalid/file'),'fresh.txt');
 for(const command of ['curl https://fixture.invalid/file','echo curl -o fresh.txt https://fixture.invalid','curl -o fresh.txt https://fixture.invalid; echo success','curl -o $FILE https://fixture.invalid','curl -o ../secrets https://fixture.invalid','curl -o fresh.txt https://user:password@fixture.invalid','sh -c curl']){
  assert.equal(literalDownloadPath(command),undefined);
 }
});
