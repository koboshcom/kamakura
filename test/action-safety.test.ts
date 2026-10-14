import test from 'node:test';
import assert from 'node:assert/strict';
import {dangerousText,dangerousLocal,dangerousInputs} from '../src/action-safety.js';
import {DangerousConfirmations} from '../src/dangerous-confirmations.js';
import {config} from '../src/config.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import type {IncomingMessage} from '../src/types.js';
import {randomUUID} from 'node:crypto';
const owner='91',other='92';
function msg(text:string,transport='discord',o=owner,chat='dm:account',out:string[]=[],current=()=>true){
 const m={transport,chatId:chat,senderId:o,sender:o,authenticatedOwner:true,isGroup:false,id:randomUUID(),text,timestamp:Date.now()} as IncomingMessage;
 bindLocalDM(m,current,async text=>{out.push(text);});return m;
}
const tick=()=>new Promise(r=>setTimeout(r,5));
test('short guards inspect actual unescaped command strings and avoid echo literals',()=>{
 for(const s of ['rm -rf /work/project','sudo rm -rf /home/owner','sh -c "rm -rf /data"','pwd; rm -rf /','mkfs.ext4 /dev/fake','dd if=/dev/zero of=/dev/fake','pkill sshd','mongosh --eval "db.dropDatabase()"'])assert(dangerousText(s),s);
 for(const s of ['pwd','printf test','echo "rm -rf /work"','ls /work','git status'])assert(!dangerousText(s),s);
 assert(dangerousLocal('shell',{command:'rm -rf /work'}));assert(!dangerousLocal('shell',{command:'pwd'}));assert(dangerousLocal('cua',{tool:'click',args:{}},true));
 assert(dangerousInputs('run_command',{command:'rm -rf /work'}));assert(!dangerousInputs('file',{content:'rm -rf /work'}));
});
test('same-DM exact single-use confirmation rejects forged/cross-scope replies and mutated args',async()=>{
 config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);
 try{for(const transport of ['telegram','discord','whatsapp']){
 const service=new DangerousConfirmations(100),out:string[]=[],args={command:'rm -rf /work/test'},origin=msg('task',transport,owner,'dm:account',out);
 let executed=0;const pending=service.require(origin,'run_command',args).then(()=>{executed++;});
 await tick();const nonce=out[0]!.match(/\/confirm ([a-f0-9-]+)/)![1]!;
 await service.handle({...msg('/confirm '+nonce,transport)});await service.handle(msg('/confirm '+nonce,transport,other));await service.handle(msg('/confirm '+nonce,transport,owner,'wrong'));
 assert.equal(executed,0);await service.handle(msg('/confirm '+nonce,transport));await pending;assert.equal(executed,1);await service.handle(msg('/confirm '+nonce,transport));assert.equal(executed,1);
 const out2:string[]=[],mutable={command:'rm -rf /work/old'};const p=service.require(msg('task',transport,owner,'dm:account',out2),'run_command',mutable);const rejected=assert.rejects(p,/changed/);await tick();mutable.command='rm -rf /work/new';await service.handle(msg('/confirm '+out2[0]!.match(/\/confirm ([a-f0-9-]+)/)![1],transport));await rejected;service.close();
 }}finally{config.sandbox.allowed.delete(owner);config.sandbox.allowed.delete(other);}
});
test('deny, abort, expired nonce, disconnected session and shutdown never authorize execution',async()=>{
 config.sandbox.allowed.add(owner);
 try{for(const mode of ['deny','abort','expire','stale','close']){
 const s=new DangerousConfirmations(25),out:string[]=[],ctrl=new AbortController();let active=true;
 const pending=s.require(msg('task','discord',owner,'dm:account',out,()=>active),'run_command',{command:'rm -rf /work/test'},ctrl.signal),rejected=assert.rejects(pending);
 await tick();const id=out[0]!.match(/\/confirm ([a-f0-9-]+)/)![1]!;
 if(mode==='deny')await s.handle(msg('/cancel '+id));else if(mode==='abort')ctrl.abort();else if(mode==='close')s.close();else if(mode==='stale'){active=false;await s.handle(msg('/confirm '+id));}
 await rejected;await s.handle(msg('/confirm '+id));s.close();
 }}finally{config.sandbox.allowed.delete(owner);}
});

test('actual cloud wrappers dispatch ordinary work immediately and dangerous work only after same-DM confirmation',async()=>{
 const {workTools}=await import('../src/work-tools.js');
 const {sandboxes}=await import('../src/sandbox.js');
 const {dangerousConfirmations}=await import('../src/dangerous-confirmations.js');
 config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);config.telegramAllowed.add(owner);
 const run=sandboxes.run,py=sandboxes.execPython;let runs=0,python=0;
 sandboxes.run=async()=>{runs++;return {output:'fixture',exitCode:0,timedOut:false,truncated:false,workspace:'/work',diskLimit:1,quota:'fixture'};};
 sandboxes.execPython=async()=>{python++;return {text:'fixture',images:[]};};
 try{
 const out:string[]=[],origin=msg('task','telegram',owner,owner,out),tools=workTools(origin),options={toolCallId:'fixture',messages:[]};
 await tools.run_command!.execute!({command:'pwd',risk:'normal',purpose:'fixture benign',requires_confirmation:false},options);assert.equal(runs,1);assert.equal(out.length,0);
 const pending=tools.run_command!.execute!({command:'rm -rf /work/test',risk:'normal',purpose:'fixture benign',requires_confirmation:false},options);
 await tick();assert.equal(runs,1);const nonce=out[0]!.match(/\/confirm ([a-f0-9-]+)/)![1]!;
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'telegram',other,other));assert.equal(runs,1);
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'telegram',owner,owner));await pending;assert.equal(runs,2);
 const p=tools.desktop_cua!.execute!({operation:'click',args:{x:1,y:1},risk:'destructive',purpose:'fixture danger',requires_confirmation:true},options);
 await tick();assert.equal(python,0);const cancel=out.find(s=>s.includes('desktop_cua'))!.match(/\/cancel ([a-f0-9-]+)/)![1]!;
 const denied=assert.rejects(Promise.resolve(p));await dangerousConfirmations.handle(msg('/cancel '+cancel,'telegram',owner,owner));await denied;assert.equal(python,0);
 await tools.desktop_cua!.execute!({operation:'list_windows',args:{},risk:'normal',purpose:'fixture benign',requires_confirmation:false},options);assert.equal(python,1);
 await tools.exec_py!.execute!({code:'log(1)',risk:'normal',purpose:'fixture benign',requires_confirmation:false},options);assert.equal(python,2);
 }finally{sandboxes.run=run;sandboxes.execPython=py;dangerousConfirmations.close();config.sandbox.allowed.delete(owner);config.telegramAllowed.delete(owner);config.sandbox.allowed.delete(other);}
});

test('shared TypeScript/Go obvious-action classification',async()=>{const {readFile}=await import('node:fs/promises');const rows=JSON.parse(await readFile(new URL('./action-safety-fixtures.json',import.meta.url),'utf8'));for(const r of rows)assert.equal(dangerousText(r.command),r.dangerous,r.command);});

test('latest kill policy mock execution counts and trusted same-DM approval',{timeout:5000},async()=>{
 const {workTools}=await import('../src/work-tools.js'),{sandboxes}=await import('../src/sandbox.js'),{dangerousConfirmations}=await import('../src/dangerous-confirmations.js');
 const old=sandboxes.run;let executions=0;
 config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);config.telegramAllowed.add(owner);
 sandboxes.run=async()=>{executions++;return {output:'mock only',exitCode:0,timedOut:false,truncated:false,workspace:'/work',diskLimit:1,quota:'mock'}};
 try{
 const out:string[]=[],origin=msg('task','telegram',owner,owner,out),tools=workTools(origin),opts={toolCallId:'latest-kill',messages:[]};
 for(const command of ['kill 12345','kill -TERM 12345','kill -9 12345','pkill firefox','pkill initialization-worker']){
 const before=executions,asked=out.length;
 await tools.run_command!.execute!({command,risk:'normal',purpose:'mock only',requires_confirmation:false},opts);
 assert.equal(executions,before+1);assert.equal(out.length,asked);
 }
 for(const command of ['kill 1','kill -s HUP 1','pkill sshd','pkill dockerd','pkill systemd','pkill init','pkill kamakura-core','kill -1','killall node']){
 const before=executions,asked=out.length;
 const args={command,risk:'normal' as const,purpose:'mock only',requires_confirmation:false};
 const pending=tools.run_command!.execute!(args,opts);
 await tick();assert.equal(executions,before);
 const nonce=out[asked]!.match(/\/confirm ([a-f0-9-]+)/)![1]!;
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'discord',owner,owner));assert.equal(executions,before);
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'telegram',other,other));assert.equal(executions,before);
 args.command='changed fixture';
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'telegram',owner,owner));
 await pending;assert.equal(executions,before+1);
 await dangerousConfirmations.handle(msg('/confirm '+nonce,'telegram',owner,owner));assert.equal(executions,before+1);
 }
 }finally{sandboxes.run=old;dangerousConfirmations.close();config.sandbox.allowed.delete(owner);config.sandbox.allowed.delete(other);config.telegramAllowed.delete(owner)}
});

test('literal Python kill guard follows actual target rather than all process kills',()=>{assert(!dangerousInputs('exec_py',{code:'os.kill(12345, 9)'}));assert(dangerousInputs('exec_py',{code:'os.kill(1, 9)'}));assert(!dangerousInputs('exec_py',{code:'os.system("pkill firefox")'}));assert(dangerousInputs('exec_py',{code:'os.system("pkill sshd")'}));});
