import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tool,type ToolSet} from 'ai';
import {z} from 'zod';
import {config} from '../src/config.js';
import {HabitsStore,captureHabit,type HabitCapture,type HabitAction} from '../src/habits.js';
import {habitLocalTools,habits,habitTools} from '../src/habit-runtime.js';
import type {IncomingMessage} from '../src/types.js';
import type {LocalDevices} from '../src/local-devices.js';
const owner='987654321',other='987654322',device='12345678-1234-4234-8234-123456789abc';
const x:HabitAction={tool:'list_local_devices'},y:HabitAction={tool:'local_snapshot',deviceId:device};
const setup=()=>{config.learning.enabled=true;config.learning.owners.add(owner);config.learning.owners.add(other);config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);config.telegramAllowed.add(owner);config.telegramAllowed.add(other);};
const message=(id:string,at=Date.now(),text='show my devices',who=owner):IncomingMessage=>({transport:'telegram',chatId:who,senderId:who,sender:who,id,text,isGroup:false,learningEligible:true,timestamp:at});
function captured(id:string,at:number,text='show my devices',who=owner){const c=captureHabit(message(id,at,text,who),at);assert.ok(c);return c;}
async function seed(store:HabitsStore,who=owner,at=Date.now()){
 for(let i=3;i>0;i--){const t=at-i*3600000;await store.success(captured('x'+i,t,'show my devices',who),x);await store.success(captured('y'+i,t+1000,'take a screenshot',who),y);}
}
test('direct verified save-time envelope rejects unverified, failed provenance, quotes, expiry and toggle; mapped channels retain immutable source',()=>{
 setup();const m=message('a');assert.ok(captureHabit(m));
 for(const patch of [{learningEligible:undefined},{learningEligible:false},{senderId:other,chatId:owner},{isGroup:true},{replyContext:{id:'q',text:'do stuff'}},{timestamp:0},{timestamp:Date.now()-120001},{text:'> screenshot'},{text:'forwarded screenshot'},{text:'password=secret'}, {media:[{kind:'image' as const,mime:'image/png',data:Buffer.alloc(0)}]}])assert.equal(captureHabit({...m,...patch}),undefined);
 const wa=captureHabit({...m,transport:'whatsapp',chatId:'verified-chat',authenticatedOwner:true});assert.equal(wa?.owner,owner);assert.equal(wa?.source.channel,'whatsapp');
 config.learning.enabled=false;assert.equal(captureHabit(m),undefined);config.learning.enabled=true;
});
test('three distinct independent successful episodes, dedup retries/replay; pair constraints persist and owners isolated',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'habits-'));const store=new HabitsStore(dir);
 try{
  const t=Date.now()-5*3600000,c=captured('one',t);await store.success(c,x);await store.success(captured('two',t+1000,'screenshot'),y);
  for(let i=0;i<8;i++){await store.success(c,x);await store.success(captured('retry'+i,t+2000+i,'screenshot'),y);}
  assert.equal((await store.list(owner)).find(h=>h.kind==='pair')?.evidence.length,1);
  assert.deepEqual(await store.list(other),[]);
  await seed(store);const active=(await store.list(owner)).find(h=>h.kind==='pair');assert.equal(active?.state,'active');assert.equal(active?.evidence.length,3);
  const fresh=captured('trigger',Date.now());assert.ok(await store.claim(fresh,x));assert.equal(await store.claim(fresh,x),undefined);
  assert.equal(await store.claim(captured('foreign',Date.now(),'show devices',other),x),undefined);
  assert.equal(await store.claim(fresh,{tool:'local_snapshot',deviceId:'12345678-1234-4234-8234-123456789abd'}),undefined);
  const reopened=new HabitsStore(dir);await reopened.control(owner,active!.id,'disabled');await seed(reopened);assert.equal((await store.list(owner)).find(h=>h.id===active!.id)?.state,'disabled');
  await reopened.control(owner,active!.id,'removed');await seed(new HabitsStore(dir));assert.equal((await store.list(owner)).find(h=>h.id===active!.id)?.state,'removed');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('confirmed timezone recurrence offers only current turn, never schedules; unknown timezone learns no times',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'habits-'));const store=new HabitsStore(dir);
 try{
  const at=Date.now(),zone='America/Vancouver';
  for(let i=3;i>0;i--)await store.success({...captured('time'+i,at-i*7*86400000),zone},x);
  const now={...captured('current',at),zone};const offers=await store.offers(now);assert.equal(offers.length,1);assert.equal(offers[0]!.evidenceCount,3);assert.deepEqual(await store.offers(now),[]);
  assert.deepEqual(await store.offers({...now,owner:other,source:{...now.source,owner:other}}),[]);
  assert.deepEqual(await store.offers({...now,zone:undefined}),[]);
  assert.ok((await store.list(owner)).every(h=>h.kind!=='time'||h.zone===zone));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('real executor wrapping learns only successful results, executes safe Y once with fresh owned device; stale/offline/foreign/danger never dispatch',async()=>{
 setup();await seed(habits);let xCount=0,yCount=0,dangerCount=0,schedules=0;
 const tools:ToolSet={
 list_local_devices:tool({inputSchema:z.object({}),execute:async()=>{xCount++;return []}}),
 local_snapshot:tool({inputSchema:z.object({deviceId:z.string()}),execute:async()=>{yCount++;return {text:'{}',images:['aGVsbG8=']}}}),
 local_shell:tool({inputSchema:z.object({}),execute:async()=>{dangerCount++;throw new Error('same DM approval required')}}),
 schedule_reminder:tool({inputSchema:z.object({}),execute:async()=>{schedules++;return {}}})
 };
 const devices={list:async(who:string)=>who===owner?[{deviceId:device,connected:true,paused:false}]:[]} as unknown as LocalDevices;
 const m=message('freshtrigger');const opts={toolCallId:'one',messages:[]};
 const wrapped=habitLocalTools(m,tools,devices);const result=await wrapped.list_local_devices!.execute!({},opts) as any;
 assert.equal(xCount,1);assert.equal(yCount,1);assert.equal(result.habitFollowup.success,true);
 await wrapped.list_local_devices!.execute!({},opts);assert.equal(yCount,1);
 const offline=habitLocalTools(message('offlinetrigger'),tools,{list:async()=>[]} as unknown as LocalDevices);
 await offline.list_local_devices!.execute!({},opts);assert.equal(yCount,1);
 const foreign=habitLocalTools(message('foreigntrigger',Date.now(),'show devices',other),tools,devices);await foreign.list_local_devices!.execute!({},opts);assert.equal(yCount,1);
 config.learning.enabled=false;await habitLocalTools(message('toggletrigger'),tools,devices).list_local_devices!.execute!({},opts);assert.equal(yCount,1);config.learning.enabled=true;
 assert.equal(dangerCount,0);assert.equal(schedules,0);
 const h=(await habits.list(owner)).find(h=>h.kind==='pair')!;
 await assert.rejects(async()=>habitTools(message('noapproval')).control_habit!.execute!({id:h.id,mode:'disabled'},opts));
 const request=message('disable',Date.now(),'disable habit '+h.id);await habitTools(request).control_habit!.execute!({id:h.id,mode:'disabled'},opts);
 await habitLocalTools(message('disabledtrigger'),tools,devices).list_local_devices!.execute!({},opts);assert.equal(yCount,1);
});
test('failed executor and model-like results are not successful evidence; no arbitrary code or destinations accepted',async()=>{
 setup();let count=0;
 const tools:ToolSet={local_snapshot:tool({inputSchema:z.object({deviceId:z.string()}),execute:async()=>{count++;return {text:'{"error":"fail"}',images:[]};}})};
 const before=await habits.list(owner);await habitLocalTools(message('failed',Date.now(),'screenshot'),tools,{list:async()=>[]} as unknown as LocalDevices).local_snapshot!.execute!({deviceId:device},{toolCallId:'fail',messages:[]});
 assert.equal(count,1);assert.deepEqual(await habits.list(owner),before);
 const dir=mkdtempSync(join(tmpdir(),'habits-'));try{const store=new HabitsStore(dir);await assert.rejects(()=>store.success(captured('code',Date.now()),{tool:'run_command',command:'arbitrary code'} as any));await assert.rejects(()=>store.success(captured('dest',Date.now()),{tool:'send_message',target:'foreign'} as any));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('plain correction disables paired behavior authoritatively; removed tombstone persists without replay',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'habits-'));try{const store=new HabitsStore(dir);await seed(store);
 await store.suppress(captured('correction',Date.now(),"don't take a screenshot automatically anymore"));
 const pair=(await store.list(owner)).find(h=>h.kind==='pair')!;assert.equal(pair.state,'disabled');
 await seed(new HabitsStore(dir));assert.equal(await store.claim(captured('fresh-correction',Date.now()),x),undefined);
 await store.suppress(captured('forget',Date.now(),'forget all habits'));assert.ok((await store.list(owner)).every(h=>h.state==='removed'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('workspace list/search to exact read pairs and recurring read/list/search intents; persistence and cross-domain exclusion',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'habits-files-'));const store=new HabitsStore(dir);
 const list:HabitAction={tool:'list_files',glob:'**/*'},read:HabitAction={tool:'read_file',path:'report.txt',offset:0},search:HabitAction={tool:'grep',glob:'**/*',query:'TODO'};
 const at=Date.now(),zone='America/Vancouver';
 try{
  for(let i=3;i>0;i--){
   const t=at-i*7*86400000;
   await store.success({...captured('fl'+i,t,'list my files'),zone},list);
   await store.success({...captured('fr'+i,t+1000,'read report.txt'),zone},read);
   await store.success({...captured('fg'+i,t+2000,'search TODO'),zone},search);
  }
  const pairs=(await store.list(owner)).filter(h=>h.kind==='pair');
  assert.ok(pairs.some(h=>h.x.tool==='list_files'&&h.y?.tool==='read_file'&&h.state==='active'));
  assert.ok(pairs.some(h=>h.x.tool==='read_file'&&h.y?.tool==='grep'&&h.state==='active'));
  for(const text of ['list my files','read report.txt','search TODO']){
   const offers=await store.offers({...captured('fo'+text,at,text),zone});assert.equal(offers.length,1);
  }
  assert.equal(await store.claim(captured('different-file',at,'read other.txt'),{tool:'read_file',path:'other.txt',offset:0}),undefined);
  await store.success(captured('domain-a',at,'list files'),list);
  await store.success(captured('domain-b',at+1000,'screenshot'),y);
  assert.ok(!(await store.list(owner)).some(h=>h.x.tool==='list_files'&&h.y?.tool==='local_snapshot'));
  const h=pairs.find(h=>h.x.tool==='list_files')!;
  await store.control(owner,h.id,'removed');
  assert.equal(await new HabitsStore(dir).claim(captured('removed-files',at,'list files'),list),undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual workspace tool factory mock runs exact safe Y once only after successful X; failed/retry/foreign/new-target exclude dispatch',async()=>{
 setup();const who='987654323';config.learning.owners.add(who);config.sandbox.allowed.add(who);config.telegramAllowed.add(who);
 const list:HabitAction={tool:'list_files',glob:'**/*'},read:HabitAction={tool:'read_file',path:'report.txt',offset:0};
 const at=Date.now();
 for(let i=3;i>0;i--){const t=at-i*3600000;await habits.success(captured('factory-list'+i,t,'list files',who),list);await habits.success(captured('factory-read'+i,t+1000,'read report.txt',who),read);}
 let reads=0,lists=0,checks=0,fail=false;const requests:Record<string,unknown>[]=[];
 const {sandboxFileTools}=await import('../src/sandbox-files.js');
 const tools=sandboxFileTools(async command=>{
  const req=JSON.parse(Buffer.from(command.split("'")[1]!,'base64').toString());
  requests.push(req);
  if(req.op==='list_files'){lists++;if(fail)return {output:'{"ok":false,"error":"mock failure"}',exitCode:1,timedOut:false};}
  if(req.op==='read_file')reads++;
  return {output:JSON.stringify({ok:true,result:req.op==='read_file'?{text:'untrusted file contents',nextOffset:null}:{matches:['report.txt'],truncated:false}}),exitCode:0,timedOut:false};
 },()=>{checks++;});
 const opts={toolCallId:'filemock',messages:[]},m=message('factory-fresh',at,'list files',who);
 fail=true;await assert.rejects(()=>habitLocalTools(m,tools).list_files!.execute!({glob:'**/*'},opts) as Promise<unknown>);assert.equal(reads,0);
 fail=false;const wrapped=habitLocalTools(m,tools);
 const out=await wrapped.list_files!.execute!({glob:'**/*'},opts) as any;
 assert.equal(out.habitFollowup.success,true);assert.equal(reads,1);
 assert.deepEqual(requests.at(-1),{op:'read_file',path:'report.txt',offset:0});
 await wrapped.list_files!.execute!({glob:'**/*'},opts);assert.equal(reads,1);
 await habitLocalTools(message('other-glob',at,'list files other/*',who),tools).list_files!.execute!({glob:'other/*'},opts);assert.equal(reads,1);
 await habitLocalTools(message('other-owner',at,'list files',other),tools).list_files!.execute!({glob:'**/*'},opts);assert.equal(reads,1);
 assert.ok(checks>=lists*2+reads*2);
 const before=await habits.list(who);
 const malformed:ToolSet={list_files:tool({inputSchema:z.object({}),execute:async()=>({matches:[],truncated:false,error:'bad'})})};
 await habitLocalTools(message('failed-shape',at,'list files',who),malformed).list_files!.execute!({},opts);
 assert.deepEqual(await habits.list(who),before);
 for(const action of [{tool:'read_file',path:'../foreign/file',offset:0},{tool:'read_file',path:'.env',offset:0},{tool:'send_file',recipient:other},{tool:'taildrop',recipient:who},{tool:'local_shell',command:'tailscale file cp ...'},{tool:'write_file',path:'report.txt',content:'overwrite'}]){
  await assert.rejects(()=>habits.success(captured('unsafe'+JSON.stringify(action),at,'list files',who),action as any));
 }
 const pair=(await habits.list(who)).find(h=>h.kind==='pair')!;
 await habits.control(who,pair.id,'disabled');
 await habitLocalTools(message('files-disabled',at,'list files',who),tools).list_files!.execute!({glob:'**/*'},opts);assert.equal(reads,1);
 // Dangerous and external tools are not registered automatic Y. Their ordinary DM-confirmation tests remain authoritative.
});

test('fixed action parser never keeps code, extra delivery fields, secret targets or recipient parameters',async()=>{
 const {parseHabitAction,supportedHabitPair}=await import('../src/habits.js');
 assert.equal(parseHabitAction('read_file',{path:'../x'}),undefined);
 assert.equal(parseHabitAction('grep',{query:'password=secret'}),undefined);
 assert.equal(parseHabitAction('download_phone',{recipient:owner}),undefined);
 assert.equal(parseHabitAction('send_file',{recipient:other}),undefined);
 assert.equal(supportedHabitPair(x,{tool:'read_file',path:'report.txt',offset:0}),false);
 assert.deepEqual(parseHabitAction('list_files',{}),{tool:'list_files',glob:'**/*'});
});
