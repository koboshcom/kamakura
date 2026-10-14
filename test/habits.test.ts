import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tool,type ToolSet} from 'ai';
import {z} from 'zod';
import {config} from '../src/config.js';
import {HabitsStore,captureHabit,parseHabitAction,type HabitAction} from '../src/habits.js';
import {habitLocalTools,habits,successfulExecution} from '../src/habit-runtime.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import type {IncomingMessage} from '../src/types.js';
const owner='987654321',other='987654322';
function setup(){config.learning.enabled=true;for(const o of [owner,other]){config.learning.owners.add(o);config.sandbox.allowed.add(o);config.telegramAllowed.add(o);}}
function message(id:string,text='please run tests',at=Date.now(),who=owner){const m:IncomingMessage={transport:'telegram',chatId:who,senderId:who,sender:who,id,text,isGroup:false,authenticatedOwner:true,learningEligible:true,timestamp:at};bindLocalDM(m,()=>true,async()=>{});return m;}
function capture(id:string,text:string,at:number,who=owner){const c=captureHabit(message(id,text,at,who),at);assert.ok(c);return c;}
const x:HabitAction={tool:'run_command',intent:'please run tests'},y:HabitAction={tool:'send_file',intent:'please send the results'};
async function seed(store:HabitsStore,at=Date.now()){for(let i=3;i>0;i--){const t=at-i*3600000;await store.success(capture('x'+i,x.intent,t),x);await store.success(capture('y'+i,y.intent,t+1000),y);}}
test('save-time immutable direct owner, quotes, spoofed/mutated envelope, expiry and toggle excluded',()=>{
 setup();const m=message('one');assert.ok(captureHabit(m));
 for(const patch of [{learningEligible:false},{isGroup:true},{replyContext:{id:'quoted',text:'run tests'}},{text:'> please run tests'},{text:'please run tests password=secret'},{id:'mutated'},{timestamp:0},{senderId:other,chatId:owner}])assert.equal(captureHabit({...m,...patch}),undefined);
 const quote=message('quote','> please run tests');assert.equal(captureHabit(quote),undefined);
 config.learning.enabled=false;assert.equal(captureHabit(m),undefined);config.learning.enabled=true;
});
test('generic three independent episodes, bounded receipts, both owner isolation and persistent disable/remove',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'generic-habits-')),store=new HabitsStore(dir);
 try{
 await seed(store);const h=(await store.list(owner)).find(h=>h.kind==='pair')!;assert.equal(h.state,'active');assert.equal(h.evidence.length,3);assert.ok(h.evidence.every(e=>e.previous?.owner===owner));
 assert.deepEqual(await store.list(other),[]);
 const c=capture('fresh',x.intent,Date.now());assert.ok(await store.claim(c,x));assert.equal(await store.claim(c,x),undefined);
 assert.equal(await store.claim(capture('foreign',x.intent,Date.now(),other),x),undefined);
 await new HabitsStore(dir).control(owner,h.id,'disabled');await seed(store);assert.equal((await store.list(owner)).find(v=>v.id===h.id)?.state,'disabled');
 await store.control(owner,h.id,'removed');await seed(new HabitsStore(dir));assert.equal((await store.list(owner)).find(v=>v.id===h.id)?.state,'removed');
 assert.ok(!JSON.stringify(await store.list(owner)).includes('"command":'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unrelated action pairs and Taildrop are learned without tool allowlist or special branch; raw executable inputs not retained',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'generic-pairs-')),store=new HabitsStore(dir);
 try{
 const pairs=[['resize','please resize this image','archive','please create an archive'],['run_command','please download https://example.com/a.zip','run_command','please taildrop a.zip to laptop']];
 for(const [index,p]of pairs.entries()){for(let i=3;i>0;i--){const at=Date.now()-(10+index*5+i)*3600000;
 const a=parseHabitAction(p[0]!,{command:'curl -fL -o a.zip https://example.com/a.zip'},p[1]!)!;
 const b=parseHabitAction(p[2]!,{command:'tailscale file cp a.zip laptop:'},p[3]!)!;
 assert.ok(a);assert.ok(b);await store.success(capture('x'+index+i,p[1]!,at),a);await store.success(capture('y'+index+i,p[3]!,at+1000),b);
 }}
 const list=await store.list(owner);assert.equal(list.filter(h=>h.kind==='pair'&&h.state==='active').length,2);
 const text=JSON.stringify(list);assert.ok(!text.includes('https://'));assert.ok(!text.includes('tailscale file cp'));assert.ok(!text.includes('curl -fL'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('only actual successful wrapped executors produce advisory, no auto replay or unsafe dispatch; array output preserved',async()=>{
 setup();await seed(habits);let executions=0,sends=0,danger=0;
 const tools:ToolSet={run_command:tool({inputSchema:z.object({}),execute:async()=>{executions++;return {exitCode:0,output:'actual'}}}),send_file:tool({inputSchema:z.object({}),execute:async()=>{sends++;return {sent:true}}}),delete_database:tool({inputSchema:z.object({}),execute:async()=>{danger++;throw new Error('approval required');}})};
 const m=message('current');const wrapped=habitLocalTools(m,tools),opts={toolCallId:'one',messages:[]};
 const result=await wrapped.run_command!.execute!({},opts) as any;
 assert.equal(executions,1);assert.equal(sends,0);assert.equal(danger,0);
 const model=await wrapped.run_command!.toModelOutput!({toolCallId:'one',input:{},output:result});assert.ok(JSON.stringify(model).includes('Learned advisory followup'));assert.deepEqual(result,{exitCode:0,output:'actual'});
 const repeat=await wrapped.run_command!.execute!({},opts);assert.ok(!JSON.stringify(await wrapped.run_command!.toModelOutput!({toolCallId:'two',input:{},output:repeat})).includes('Learned advisory'));
 for(const value of [{exitCode:1,output:'success'}, {error:'bad'}, {timedOut:true},{text:'{"error":"failed"}'}])assert.equal(successfulExecution(value),false);
 const before=JSON.stringify(await habits.list(owner));
 const fail=habitLocalTools(message('failed'),{run_command:tool({inputSchema:z.object({}),execute:async()=>({exitCode:1,output:'success'})})});
 await fail.run_command!.execute!({},opts);assert.equal(JSON.stringify(await habits.list(owner)),before);
 const unbound={...m,id:'unbound'};assert.equal(captureHabit(unbound),undefined);
});
test('confirmed timezone recurrence offers without creating schedules, corrections permanently suppress',async()=>{
 setup();const dir=mkdtempSync(join(tmpdir(),'generic-time-')),store=new HabitsStore(dir);try{
 const at=Date.now(),zone='America/Vancouver';
 for(let i=3;i>0;i--)await store.success({...capture('week'+i,x.intent,at-i*7*86400000),zone},x);
 assert.equal((await store.offers({...capture('now',x.intent,at),zone})).length,1);
 assert.equal((await store.offers({...capture('again',x.intent,at),zone})).length,0);
 assert.deepEqual(await store.offers(capture('unknown',x.intent,at)),[]);
 await store.suppress(capture('stop','disable all habits',at));assert.ok((await store.list(owner)).every(h=>h.state==='disabled'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
