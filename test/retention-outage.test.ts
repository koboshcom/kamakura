import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore} from '../src/history.js';
import {Reminders} from '../src/reminders.js';
import {collection,namespace,hash} from '../src/mongo.js';
import {boundedSummary,summaryCoverageLimit,summaryEnvelopeLimit,loadSummary} from '../src/context-budget.js';

test('outage fails closed for semantic, chronological and anchored queries, never reading cached text',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'outage-semantics-'));
 try{const store=new HistoryStore(dir,40);const internal=store as unknown as {recent:Map<string,unknown[]>;recover:()=>Promise<void>};
 internal.recent.set('telegram:123',[{role:'user',senderId:'123',id:'2',text:'hello again',at:2000},{role:'user',senderId:'123',id:'1',text:'hello',at:0},{role:'user',senderId:'other',id:'3',text:'hello',at:1000}]);
 internal.recover=async()=>{const error=new Error('fixture');error.name='MongoNetworkError';throw error;};
 await assert.rejects(store.lookup('telegram:123','123',{query:'hello',exact:true}),/Exact lexical search is unsupported/);
 await assert.rejects(store.lookup('telegram:123','123',{query:'hello',exact:true,afterId:'missing'}),/Exact lexical search is unsupported/);
 for(const options of [{order:'earliest' as const,limit:1},{query:'Hello'},{to:0},{afterId:'1'}]){const result=await store.lookup('telegram:123','123',options);assert.deepEqual(result.messages,[]);assert.deepEqual(result.context,[]);assert.equal(result.retrieval,'unavailable');assert.equal(result.degraded,true);assert.equal(result.matched,0);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('reminders retain 100 terminal entries, atomic pending admission and never replay uncertain sends',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'reminder-retention-'));const reminders=new Reminders(join(dir,'reminders.sqlite'));
 try{await reminders.ready();const coll=await collection('reminders');const _id=`${namespace(dir)}:${hash('chat')}`;
 const item=(id:number,state:string)=>({id,state,transport:'telegram',chat:'chat',owner:'alice',text:'fish',due:0});
 await coll.insertOne({_id,ns:namespace(dir),chat:'chat',items:Array.from({length:250},(_,n)=>item(n,'claimed'))});await (await collection('counters')).updateOne({_id:`${namespace(dir)}:reminders`},{$set:{value:250}},{upsert:true});
 let sends=0;await reminders.tick(async()=>{sends++;});assert.equal(sends,0);let row=await coll.findOne({_id});assert.equal(row!.items.length,100);assert.equal(row!.items[0].id,150);
 const admitted=await Promise.allSettled(Array.from({length:110},(_,n)=>reminders.schedule('telegram','chat','alice','fish '+n,Date.now()+60000)));
 assert.equal(admitted.filter(r=>r.status==='fulfilled').length,100);assert.equal((await reminders.list('chat','alice')).length,100);
 row=await coll.findOne({_id});assert.equal(row!.items.length,200);
 const pending=(await reminders.list('chat','alice')).sort((a,b)=>b.id-a.id);assert.equal(await reminders.cancel('chat','alice',pending[0]!.id),true);row=await coll.findOne({_id});assert.equal(row!.items.filter((r:{state:string})=>r.state!=='pending').length,100);assert.ok(row!.items.some((r:{id:number;state:string})=>r.id===pending[0]!.id&&r.state==='cancelled'));
 await coll.updateOne({_id},{$set:{items:[item(1000,'pending')]}});await reminders.tick(async()=>{sends++;throw new Error('uncertain');});await new Reminders(join(dir,'reminders.sqlite')).tick(async()=>{sends++;});assert.equal(sends,1);assert.equal((await coll.findOne({_id}))!.items[0].state,'claimed');
 }finally{await reminders.close();rmSync(dir,{recursive:true,force:true});}
});

test('reminders quarantine revoked destinations before claim and recheck after claim',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'reminder-revoke-'));const reminders=new Reminders(join(dir,'reminders.sqlite'));
 try{await reminders.ready();const coll=await collection('reminders');const _id=`${namespace(dir)}:${hash('chat')}`;const seed=()=>coll.updateOne({_id},{$set:{ns:namespace(dir),chat:'chat',items:[{id:1,state:'pending',transport:'telegram',chat:'chat',owner:'alice',text:'private',due:0}]}},{upsert:true});
 let sends=0;await seed();await reminders.tick(async()=>{sends++;},()=>false);assert.equal(sends,0);assert.equal((await coll.findOne({_id}))!.items[0].state,'revoked');
 await seed();let checks=0;await reminders.tick(async()=>{sends++;},()=>++checks===1);assert.equal(checks,2);assert.equal(sends,0);assert.equal((await coll.findOne({_id}))!.items[0].state,'revoked');
 }finally{await reminders.close();rmSync(dir,{recursive:true,force:true});}
});

test('summary coverage and full envelope stay bounded and oversized legacy loads are sanitized',async()=>{
 const keys=Array.from({length:10000},(_,n)=>hash(String(n)));const row={_id:hash('bounded-summary'),text:'good',degraded:false,updated:0,covered:keys,lastGood:{text:'good',covered:keys}};
 const bounded=boundedSummary(row);assert.equal(bounded.covered!.length,summaryCoverageLimit);assert.deepEqual(bounded.covered,keys.slice(-summaryCoverageLimit));assert.deepEqual(bounded.lastGood!.covered,bounded.covered);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<summaryEnvelopeLimit);
 await (await collection('context_summaries')).insertOne(row);const loaded=await loadSummary(row._id);assert.equal(loaded!.covered!.length,summaryCoverageLimit);assert.equal(loaded!.lastGood!.text,'good');
 const long=boundedSummary({...row,text:'x'.repeat(100000)});assert.equal(long.text.length,65536);assert.equal(long.degraded,true);
 const coll=await collection('context_summaries');const scopes=Array.from({length:513},(_,n)=>hash('cache-load-'+process.pid+'-'+n));await coll.insertMany(scopes.map(_id=>({_id,text:'bounded',degraded:false,updated:0,covered:[]})));for(const scope of scopes)await loadSummary(scope);await coll.deleteOne({_id:scopes[0]});assert.equal(await loadSummary(scopes[0]!),undefined);
});
