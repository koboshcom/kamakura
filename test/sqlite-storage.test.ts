import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import Database from 'better-sqlite3';
import {storageBackend,sqlite,insert,row,put,atomic} from '../src/sqlite.js';
import {namespace,hash,mongo} from '../src/mongo.js';
import {Reminders} from '../src/reminders.js';
import {SqliteLocalDeviceStore} from '../src/local-device-storage.js';
import {MongoDiscordClaims} from '../src/discord-claims.js';
import {storedRows,seedRecord,changeRecord} from './storage-inspection.js';
const only={skip:storageBackend()!=='sqlite'?'SQLite native integration; Mongo-specific fixtures run in Mongo matrix':false};
function child(dir:string,code:string){
 return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,STORAGE:'sqlite',DATA_DIR:dir},encoding:'utf8',timeout:10000});
}
const moduleImport="import {sqlite,closeSqlite} from './src/sqlite.ts';";
test('native SQLite WAL permissions and second-process refusal with crash-safe lock release',only,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sqlite-lock-'));
 const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',moduleImport+"sqlite();console.log('ready');setInterval(()=>{},1000)"],{cwd:process.cwd(),env:{...process.env,STORAGE:'sqlite',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 try{
  const ready=await once(p.stdout!,'data');assert.match(String(ready[0]),/ready/);
  const second=child(dir,moduleImport+"try{sqlite();process.exitCode=3}catch(e){console.log(e.code)}finally{closeSqlite()}");assert.equal(second.status,0,second.stderr);assert.match(second.stdout,/SQLITE_BUSY/);
  const exit=once(p,'exit');p.kill('SIGKILL');await exit;
  const reopened=child(dir,moduleImport+"const d=sqlite();console.log(d.pragma('journal_mode',{simple:true}),d.pragma('foreign_keys',{simple:true}));closeSqlite()");assert.equal(reopened.status,0,reopened.stderr);assert.match(reopened.stdout,/wal 1/);
  assert.equal(statSync(join(dir,'storage-sqlite')).mode&0o777,0o700);
  for(const file of ['store.sqlite','owner.sqlite'])assert.equal(statSync(join(dir,'storage-sqlite',file)).mode&0o777,0o600);
 }finally{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
test('SQLite rejects future, unversioned, corrupt and symlink storage without replacing bytes',only,()=>{
 for(const kind of ['future','unversioned','corrupt','symlink']){
  const dir=mkdtempSync(join(tmpdir(),'sqlite-invalid-')),privateDir=join(dir,'storage-sqlite'),file=join(privateDir,'store.sqlite');mkdirSync(privateDir);
  try{
   if(kind==='corrupt')writeFileSync(file,'not a sqlite file');
   else if(kind==='symlink'){writeFileSync(join(dir,'target'),'keep');symlinkSync(join(dir,'target'),file);}
   else{const d=new Database(file);if(kind==='future')d.pragma('user_version=99');else d.exec('CREATE TABLE unknown(x)');d.close();}
   const r=child(dir,moduleImport+"try{sqlite();process.exitCode=3}catch(e){console.log(e.message)}finally{closeSqlite()}");assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/schema|SQLite|database/);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
test('SQLite real FULL rolls back transaction, preserves prior rows and recovers without Mongo access',only,async()=>{
 await assert.rejects(mongo(),/forbidden/);
 const db=sqlite(),id='full-fixture',before=Number(db.pragma('max_page_count',{simple:true})),pages=Number(db.pragma('page_count',{simple:true}));
 insert('facts',id,'native',{_id:id,text:'before'});
 db.pragma('max_page_count='+Number(db.pragma('page_count',{simple:true})));
 try{
  assert.throws(()=>atomic(()=>{put('facts',id,'native',{_id:id,text:'changed'});insert('facts','huge','native',{text:'x'.repeat(8*1024*1024)});}),e=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='SQLITE_FULL'));
  assert.equal(row<{text:string}>('facts',id)!.text,'before');assert.equal(row('facts','huge'),null);
 }finally{db.pragma('max_page_count='+before);}
 put('facts',id,'native',{_id:id,text:'recovered'});assert.equal(row<{text:string}>('facts',id)!.text,'recovered');assert.ok(pages>0);
});
test('SQLite reminders claim failure never sends, uncertain delivery retries once lease expires',only,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sqlite-reminder-')),r=new Reminders(join(dir,'reminders.sqlite')),ns=namespace(dir),_id=ns+':'+hash('chat');
 try{
  await seedRecord('reminders',{_id,ns,chat:'chat',items:[{id:1,state:'pending',transport:'telegram',chat:'chat',owner:'alice',text:'owned',due:0}]});
  sqlite().exec("CREATE TRIGGER test_claim_failure BEFORE UPDATE ON reminders BEGIN SELECT RAISE(ABORT,'fixture I/O failure'); END");let sends=0;
  await assert.rejects(r.tick(async()=>{sends++;}),/I\/O failure/);assert.equal(sends,0);
  sqlite().exec('DROP TRIGGER test_claim_failure');
  await r.tick(async()=>{sends++;throw new Error('lost send acknowledgement');});assert.equal(sends,1);
  await r.tick(async()=>{sends++;});assert.equal(sends,1);
  await changeRecord('reminders',_id,r=>{r.items[0].leaseUntil=0;});
  await r.tick(async()=>{sends++;});assert.equal(sends,2);assert.equal((await storedRows('reminders',{_id}))[0].items[0].state,'sent');
 }finally{sqlite().exec('DROP TRIGGER IF EXISTS test_claim_failure');await r.close();rmSync(dir,{recursive:true,force:true});}
});
test('SQLite device pairing consume, owner-bound revoke and claims TTL remain atomic',only,async()=>{
 const store=new SqliteLocalDeviceStore('sqlite-device-fixture'),now=Date.now();
 await store.putPair({codeHash:'one',ownerId:'alice',expiresAt:now+10000});
 const claimed=await Promise.all([store.consumePair('one',now),store.consumePair('one',now)]);assert.equal(claimed.filter(Boolean).length,1);
 await store.putPair({codeHash:'expired',ownerId:'alice',expiresAt:now-1});assert.equal(await store.consumePair('expired',now),null);
 await store.putDevice({deviceId:'d',ownerId:'alice',tokenHash:'privatehash',name:'test',platform:'linux',revoked:false,createdAt:now});
 assert.equal(await store.get('bob','d'),null);assert.equal(await store.revoke('bob','d'),false);assert.equal(await store.revoke('alice','d'),true);assert.equal(await store.byToken('privatehash'),null);
 const claims=new MongoDiscordClaims();assert.equal(await claims.claim('chat','message'),true);assert.equal(await claims.claim('chat','message'),false);assert.equal(await claims.claim('other-chat','message'),true);
 const rows=await storedRows('discord_claims');for(const r of rows)await changeRecord('discord_claims',r._id,r=>{r.at=now-600001;});
 assert.equal(await claims.claim('chat','message'),true);
});
test('SQLite does not import Mongo journals or non-history legacy files',only,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sqlite-no-migrate-'));
 try{
  const r=child(dir,"import {HistoryStore} from './src/history.ts';import {FactsStore} from './src/facts.ts';"+moduleImport+"await new HistoryStore(process.env.DATA_DIR,2).ready();await new FactsStore(process.env.DATA_DIR).ready();console.log(sqlite().prepare('SELECT count(*) n FROM history').get().n);closeSqlite()");
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
