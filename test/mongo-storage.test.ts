import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync } from 'node:fs';
import {tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import Database from 'better-sqlite3';
import {ReplyBatches}from'../src/batching.js';
import {spawnSync}from'node:child_process';
import{config}from'../src/config.js';
import {HistoryStore}from'../src/history.js';import{FactsStore}from'../src/facts.js';import{LessonsStore}from'../src/learning.js';import{Reminders}from'../src/reminders.js';
import{collection,namespace,hash,closeMongo}from'../src/mongo.js';

test('Mongo migration preserves backups, genuine duplicates, long uncapped history, scopes and reminder state across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mongo-import-'));const chat='telegram:1';
 const long='whole untruncated sentence '.repeat(250);const repeat={role:'user',senderId:'1',id:'duplicate',text:'identical genuine duplicate',at:1};
 const messages=[repeat,repeat,{role:'user',senderId:'1',id:'long',text:long,at:2},...Array.from({length:5002},(_,n)=>({role:'user',senderId:'1',id:`f${n}`,text:'filler',at:n+3}))];
 const factsDir=join(dir,'facts'),lessonDir=join(dir,'learned');mkdirSync(factsDir);mkdirSync(lessonDir);
 const factsPath=join(factsDir,`${hash(JSON.stringify([chat,'1']))}.json`);const scope=JSON.stringify(['telegram','1','1']);const lessonPath=join(lessonDir,`${hash(scope)}.json`);
 const originalRevision=randomUUID(),olderRevision=randomUUID();const lesson={id:randomUUID(),kind:'preference',text:'Remember I prefer brief explanations',at:1,source:'teaching'};
 const paths=[join(dir,'history-archive.json'),join(dir,'history.json'),factsPath,lessonPath,join(dir,'reminders.sqlite')];
 writeFileSync(paths[0]!,JSON.stringify({[chat]:messages}));writeFileSync(paths[1]!,JSON.stringify({[chat]:[repeat,repeat,{role:'user',senderId:'1',id:'next',text:'recent only',at:9000}]}));
 writeFileSync(factsPath,JSON.stringify({facts:['likes fish']}));writeFileSync(lessonPath,JSON.stringify({current:{revision:originalRevision,at:2,lessons:[lesson]},history:[{revision:olderRevision,at:1,lessons:[]}]}));
 const sqlite=new Database(paths[4]!);sqlite.exec('CREATE TABLE reminders(id INTEGER PRIMARY KEY,transport TEXT,chat TEXT,owner TEXT,text TEXT,due INTEGER,state TEXT)');
 sqlite.prepare('INSERT INTO reminders VALUES(?,?,?,?,?,?,?)').run(41,'telegram','1','1','uncertain reminder',0,'claimed');sqlite.prepare('INSERT INTO reminders VALUES(?,?,?,?,?,?,?)').run(42,'telegram','1','1','deliver pending once',0,'pending');sqlite.close();
 const originals=paths.map(p=>readFileSync(p));
 try{
  const history=new HistoryStore(dir,2);const facts=new FactsStore(factsDir);const lessons=new LessonsStore(lessonDir);const reminders=new Reminders(paths[4]!);
  await Promise.all([history.ready(),facts.ready(),lessons.ready(),reminders.ready()]);
  const coll=await collection('history');assert.equal(await coll.countDocuments({ns:namespace(dir),chat}),5006);assert.equal((await history.get(chat)).length,2);
  assert.equal((await history.lookup(chat,'1',{order:'earliest',limit:2})).messages.length,2);assert.equal((await history.search(chat,'1','untruncated'))[0]!.text,long);
  assert.equal((await history.lookup(chat,'1',{afterId:'long',order:'earliest',limit:1})).messages[0]!.id,'f0');assert.equal((await history.lookup(chat,'2',{order:'earliest'})).matched,0);
  assert.equal(await coll.countDocuments({ns:namespace(dir),chat,owner:'1',$text:{$search:'untruncated'}}),1);
  assert.deepEqual(await facts.read(chat,'1'),['likes fish']);assert.deepEqual(await facts.read(chat,'2'),[]);
  assert.equal((await lessons.versions(scope))[1]!.revision,olderRevision);await lessons.rollback(scope,olderRevision);assert.deepEqual(await lessons.list(scope),[]);
  let sends=0;await reminders.tick(async item=>{assert.equal(item.id,42);sends++;});await reminders.tick(async()=>{sends++;});assert.equal(sends,1);
  await closeMongo();await new HistoryStore(dir,2).ready();await new Reminders(paths[4]!).tick(async()=>{sends++;});assert.equal(sends,1);assert.equal(await(await collection('history')).countDocuments({ns:namespace(dir),chat}),5006);
  assert.ok(await new Reminders(paths[4]!).schedule('telegram','1','1','new reminder',Date.now()+5000)>42);
  for(const [n,p]of paths.entries())assert.deepEqual(readFileSync(p),originals[n],p);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('real Mongo concurrent facts, lessons and reminders have no lost updates or duplicate claims',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mongo-atomic-'));
 try{
  const facts=new FactsStore(join(dir,'facts'));await Promise.all(Array.from({length:20},(_,n)=>facts.update('chat','owner',`confirmed preference ${n}`)));assert.equal((await facts.read('chat','owner')).length,20);
  const lessons=new LessonsStore(join(dir,'learned'));await Promise.all(Array.from({length:12},(_,n)=>lessons.add('owner/chat','preference',`Remember preference number ${n}`,'teaching')));assert.equal((await lessons.list('owner/chat')).length,12);
  const path=join(dir,'reminders.sqlite');const a=new Reminders(path),b=new Reminders(path);const due=Date.now()+1500;
  const scheduled=await Promise.allSettled(Array.from({length:105},(_,n)=>a.schedule('telegram','chat','owner',`reminder ${n}`,due)));assert.equal(scheduled.filter(r=>r.status==='fulfilled').length,100);assert.equal((await a.list('chat','owner')).length,100);
  const buckets=await collection('reminders');await buckets.updateMany({ns:namespace(dir)},{$set:{'items.$[].due':0}});
  let sends=0;for(let n=0;n<10;n++)await Promise.all([a.tick(async()=>{sends++;}),b.tick(async()=>{sends++;})]);assert.equal(sends,100);assert.equal((await a.list('chat','owner')).length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('search merges overlapping chronological context, retains duplicate records and excludes other owners',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mongo-context-'));const history=new HistoryStore(dir,2);const previous=config.historyContextMessages;
 try{
  config.historyContextMessages=1;
  for(const row of [{id:'before',text:'before',role:'assistant'},{id:'a',text:'needle',role:'user'},{id:'other',text:'private',role:'user',senderId:'other'},{id:'b',text:'needle',role:'user'},{id:'after',text:'after',role:'assistant'}])await history.add('chat',{senderId:'owner',...row,role:row.role as 'user'|'assistant',at:100});
  const result=await history.lookup('chat','owner',{query:'needle',role:'user',order:'earliest'});
  assert.deepEqual(result.messages.map(r=>r.id),['a','b']);assert.deepEqual(result.context.map(r=>r.id),['before','a','b','after']);assert.deepEqual(result.context.map(r=>r.matched),[false,true,true,false]);assert.equal(result.messages[0]!.timestamp,'1970-01-01T00:00:00.100Z');
  config.historyContextMessages=0;assert.deepEqual((await history.lookup('chat','owner',{query:'needle'})).context.map(r=>r.id),['a','b']);
 }finally{config.historyContextMessages=previous;rmSync(dir,{recursive:true,force:true});}
});

test('batch persistence retains complete input while reply context is bounded',async()=>{
 const original='z'.repeat(10000);let recorded='',reply='';
 const batch=new ReplyBatches(0,50,async(message)=>{reply=message.text;},async(message)=>{recorded=message.text;},error=>{throw error;});
 batch.receive({transport:'telegram',chatId:'owner',senderId:'owner',sender:'owner',id:'full',text:original,timestamp:0,isGroup:false});
 await new Promise(resolve=>setTimeout(resolve,30));batch.stop();assert.equal(recorded,original);assert.equal(reply.length,50);
});

test('storage fails closed when Mongo is unavailable and never writes a legacy fallback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mongo-unavailable-'));
 try{const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import{HistoryStore}from'./src/history.ts';try{await new HistoryStore(process.env.DATA_DIR,2).add('chat',{role:'user',text:'must not fall back',at:1});process.exitCode=3;}catch{process.exitCode=0;}finally{await(await import('./src/mongo.ts')).closeMongo();}`],{cwd:process.cwd(),env:{...process.env,DATA_DIR:dir,MONGODB_URI:'mongodb://127.0.0.1:1',MONGODB_DATABASE:'kamakura_unavailable_test'},encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.deepEqual(readdirSync(dir),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Mongo Compose is private, unauthenticated and separate from sandbox networks',()=>{
 const compose=readFileSync(new URL('../compose.yaml',import.meta.url),'utf8');const mongo=compose.split('\n  mongo:\n')[1]!.split('  sandbox-image:')[0]!;
 assert.match(mongo,/networks: \[mongo-internal\]/);assert.match(mongo,/\.\/data\/mongo:\/data\/db/);assert.doesNotMatch(mongo,/ports:|expose:|MONGO_INITDB_ROOT|--auth/);assert.match(compose,/mongo-internal:\n\s+internal: true/);assert.match(compose,/networks: \[default, mongo-internal\]/);
 const rules=readFileSync(new URL('../deploy/remapped-network.sh',import.meta.url),'utf8');assert.match(rules,/-i kroot0 ! -o eth0 -m conntrack --ctstate NEW -j DROP/);
});
