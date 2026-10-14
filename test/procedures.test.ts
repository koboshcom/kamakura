import {procedureTools,procedureExecution,procedureThrown} from '../src/procedure-runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.js';
import {ProceduresStore,type VectorPort} from '../src/procedures.js';
import {captureHabit,type HabitAction} from '../src/habits.js';
import {receiptSource} from '../src/receipt-model.js';
import {bindLocalDM} from '../src/local-dm-context.js';
import {hash} from '../src/mongo.js';
import {validatedVector,cosine} from '../src/embeddings.js';
import type {IncomingMessage} from '../src/types.js';
const owner='987650001',foreign='987650002',DAY=86400000;
let now=Date.now(),profile='mock-profile',embeds=0,scores=0,unavailable=false;
const port:VectorPort={
 config:()=>({baseURL:'https://mock.invalid',apiKey:'mock',model:'mock-model',dimensions:2,timeout:100,minScore:0.8,profile}),
 embed:async(text,c)=>{embeds++;if(unavailable)throw new Error('offline');return {profile:c.profile,model:c.model,dimensions:2,textHash:hash(text),vector:text.includes('weather')?[0,1]:[1,0]};},
 validate:validatedVector,score:(a,b)=>{scores++;return cosine(a,b);}
};
function cap(id:string,text='review the budget',who=owner){
 const m:IncomingMessage={transport:'telegram',chatId:who,senderId:who,sender:who,id,text,isGroup:false,authenticatedOwner:true,learningEligible:true,timestamp:now};
 bindLocalDM(m,()=>true,async()=>{});const c=captureHabit(m,now);assert.ok(c);return c;
}
const action:HabitAction={tool:'custom_report',intent:'review the budget'};
function receipt(id:string,who=owner){const c=cap(id,action.intent,who);return {action,capture:receiptSource(c,action,{}, {ok:true})};}
function fixture(){
 config.learning.enabled=true;for(const o of [owner,foreign]){config.learning.owners.add(o);config.sandbox.allowed.add(o);config.telegramAllowed.add(o);}
 now=Date.now();profile='mock-profile';unavailable=false;embeds=0;scores=0;
 const dir=mkdtempSync(join(tmpdir(),'procedures-mock-'));return {dir,store:new ProceduresStore(dir,port,()=>now)};
}
async function seed(store:ProceduresStore,who=owner){let id:string|undefined;for(let i=0;i<3;i++){now+=3600000;const r=receipt('seed'+who+i,who);id=await store.extract(r.capture,[r]);}assert.ok(id);return id;}
test('distills bounded noncommand steps from three successful independent receipts, dedup and owner isolation',async()=>{
 const {dir,store}=fixture();try{
 const r=receipt('first');await store.extract(r.capture,[r]);await store.extract(r.capture,[r]);
 assert.equal((await store.list(owner))[0]?.evidence.length,1);assert.equal((await store.list(owner))[0]?.state,'pending');
 assert.deepEqual(await store.retrieve(owner,'budget'),[]);
 assert.deepEqual(await store.list(foreign),[]);
 const invalid={...r,capture:cap('unexecuted')};await store.extract(invalid.capture,[invalid]);assert.equal((await store.list(owner)).length,1);
 for(let i=0;i<2;i++){now+=3600000;const r=receipt('next'+i);await store.extract(r.capture,[r]);}
 const notes=await store.retrieve(owner,'budget');assert.equal(notes.length,1);assert.equal(notes[0]!.steps[0]!.note,action.intent);
 assert.ok(!JSON.stringify(notes).includes('command'));
 const hostile={...r,action:{tool:'run_command',intent:'sudo bash script'}};await assert.rejects(store.extract(hostile.capture,[{...hostile,capture:receiptSource(hostile.capture,hostile.action,{}, {})}]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('relevance only, scoped before cosine, incompatible profile and unavailable embedding never fall back',async()=>{
 const {dir,store}=fixture();try{
 await seed(store);await seed(store,foreign);scores=0;
 assert.equal((await store.retrieve(owner,'budget')).length,1);assert.equal(scores,1);
 assert.deepEqual(await store.retrieve(owner,'weather'),[]);
 profile='different-profile';scores=0;assert.deepEqual(await store.retrieve(owner,'budget'),[]);assert.equal(scores,0);
 unavailable=true;await assert.rejects(store.retrieve(owner,'budget'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('targeted owner correction pending until three exact successful revalidations; foreign and executable corrections denied',async()=>{
 const {dir,store}=fixture();try{
 const id=await seed(store),title='compare the totals',steps=[{tool:'custom_report',note:title}];
 const text='correct procedure '+id+'\n'+title;
 await assert.rejects(store.correct(cap('foreign',text,foreign),id,title,steps));
 await assert.rejects(store.correct(cap('noid',title),id,title,steps));
 await store.correct(cap('correction',text),id,title,steps);
 assert.equal((await store.list(owner))[0]?.state,'pending');assert.deepEqual(await store.retrieve(owner,'budget'),[]);
 await assert.rejects(store.correct(cap('evil','correct '+id+'\nsudo bash script'),id,'sudo bash script',[{tool:'run_command',note:'sudo bash script'}]));
 for(let i=0;i<3;i++){now+=3600000;const c=cap('revalidation'+i,title),a={tool:'custom_report',intent:title};const r={action:a,capture:receiptSource(c,a,{}, {ok:true})};await store.revalidate(c,id,[r]);await store.revalidate(c,id,[r]);}
 assert.equal((await store.list(owner))[0]?.state,'active');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('fake-clock lifecycle excludes transient, cancel, denial, unknown and stale revisions; persistent tombstones never resurrect',async()=>{
 const {dir,store}=fixture();try{
 const id=await seed(store),revision=(await store.list(owner))[0]!.updated;
 for(const outcome of ['transient','cancelled','approval','unknown'] as const)await store.outcome(owner,id,outcome,revision,outcome);
 await store.outcome(owner,id,'stale',revision-1,'task-failure');assert.equal((await store.list(owner))[0]!.failures,0);
 await store.outcome(owner,id,'one',revision,'task-failure');await store.outcome(owner,id,'one',revision,'task-failure');assert.equal((await store.list(owner))[0]!.failures,1);
 await store.outcome(owner,id,'two',revision,'task-failure');assert.equal((await store.list(owner))[0]!.state,'deprecated');
 for(const invocation of ['three','four'])await store.outcome(owner,id,invocation,revision,'task-failure');
 assert.equal((await store.list(owner))[0]!.state,'deleted');
 const before=embeds;const r=receipt('resurrect');await new ProceduresStore(dir,port,()=>now).extract(r.capture,[r]);assert.equal(embeds,before);assert.equal((await store.list(owner))[0]!.state,'deleted');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('inactivity deprecates at sixty days and drops at one hundred twenty; owner disable beats extraction and corrections',async()=>{
 const {dir,store}=fixture();try{
 const id=await seed(store);now+=60*DAY;assert.equal((await store.list(owner))[0]!.state,'deprecated');
 now+=60*DAY;assert.equal((await store.list(owner))[0]!.state,'deleted');
 const otherId=await seed(store,foreign);const c=cap('disable','disable procedure '+otherId,foreign);await store.control(c,otherId,'disabled');
 const r=receipt('after-disable',foreign),before=embeds;await store.extract(r.capture,[r]);assert.equal(embeds,before);
 await assert.rejects(store.correct(cap('correction','correct '+otherId+'\ncompare the totals',foreign),otherId,'compare the totals',[{tool:'custom_report',note:'compare the totals'}]));
 assert.equal((await new ProceduresStore(dir,port,()=>now).list(foreign))[0]!.state,'disabled');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('explicit semantic teaching is owner-supported and relevance retrieved; toggle off disables mutations and prompts',async()=>{
 const {dir,store}=fixture();try{
 await store.teach(cap('teach','remember\nreview the budget'),'review the budget');
 assert.equal((await store.retrieve(owner,'budget'))[0]!.type,'semantic');
 assert.equal(await store.teach(cap('invented','remember\nreview the budget'),'invented unsupported preference'),undefined);
 config.learning.enabled=false;assert.deepEqual(await store.retrieve(owner,'budget'),[]);assert.deepEqual(await store.list(owner),[]);
 assert.equal(await store.teach(capToggle(),'review the budget'),undefined);
 }finally{config.learning.enabled=true;rmSync(dir,{recursive:true,force:true});}
});
function capToggle(){config.learning.enabled=true;const c=cap('toggle','remember\nreview the budget');config.learning.enabled=false;return c;}

function currentMessage(id:string,text:string){
 const m:IncomingMessage={transport:'telegram',chatId:owner,senderId:owner,sender:owner,id,text,isGroup:false,authenticatedOwner:true,learningEligible:true,timestamp:Date.now()};
 bindLocalDM(m,()=>true,async()=>{});return m;
}
test('runtime attributes only declared matching executions, excludes throws/transients/no invocation; no action dispatched by memory',async()=>{
 const {dir,store}=fixture();try{
 const id=await seed(store);let classifications=0,executions=0;
 const classifier=async()=>{classifications++;return 'task-failure' as const;};
 const noInvocation=currentMessage('noinv','review the budget');
 await procedureExecution(noInvocation,'custom_report',{exitCode:1},undefined,classifier,store);assert.equal(classifications,0);
 const opts={toolCallId:'begin',messages:[]};
 async function begin(label:string){const m=currentMessage(label,'review the budget using procedure '+id);const tools=procedureTools(m,store);
 await tools.begin_procedure!.execute!({id},opts);assert.equal(executions,0);return m;}
 const thrown=await begin('thrown');procedureThrown(thrown,'custom_report');
 await procedureExecution(thrown,'custom_report',{exitCode:1},undefined,classifier,store);assert.equal(classifications,0);
 const unrelated=await begin('unrelated');await procedureExecution(unrelated,'foreign_tool',{exitCode:1},undefined,classifier,store);assert.equal(classifications,0);
 const timed=await begin('timed');await procedureExecution(timed,'custom_report',{exitCode:1,timedOut:true},undefined,classifier,store);assert.equal(classifications,0);
 const failed=await begin('failed');executions++;await procedureExecution(failed,'custom_report',{exitCode:1},undefined,classifier,store);
 await procedureExecution(failed,'custom_report',{exitCode:1},undefined,classifier,store);
 assert.equal(classifications,1);assert.equal((await store.list(owner))[0]!.failures,1);
 executions=0;const success=await begin('success');await procedureExecution(success,'custom_report',{exitCode:0},undefined,classifier,store);
 assert.equal((await store.list(owner))[0]!.failures,0);
 const guard=await begin('guard');await procedureExecution(guard,'custom_report',{sent:false},undefined,classifier,store);assert.equal(classifications,1);
 const mutated=await begin('mutated');mutated.text='changed';
 await procedureExecution(mutated,'custom_report',{exitCode:1},undefined,classifier,store);assert.equal(classifications,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
