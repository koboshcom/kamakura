import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore} from '../src/history.js';
import {FactsStore} from '../src/facts.js';
import {Reminders} from '../src/reminders.js';
import {collection,namespace,hash} from '../src/mongo.js';

test('JSON credentials do not survive history Mongo/journal and cannot enter facts or reminders',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'credential-boundaries-'));
 try {
  const raw=JSON.stringify({password:'fake correct horse battery staple',token:'synthetic-token-'+'q'.repeat(64)});
  const history=new HistoryStore(dir,40);
  await history.add('telegram:123',{role:'user',senderId:'123',id:'credential-1',text:raw,at:1});
  const stored=JSON.stringify(await history.get('telegram:123'));
  assert.ok(!stored.includes('horse battery staple'));assert.ok(!stored.includes('q'.repeat(64)));
  const db=JSON.stringify(await(await collection('history')).find({ns:namespace(dir)}).toArray());
  assert.ok(!db.includes('horse battery staple'));assert.ok(!db.includes('q'.repeat(64)));
  const facts=new FactsStore(join(dir,'facts'));
  await assert.rejects(facts.update('telegram:123','123',raw,false,{transport:'telegram',chatId:'123',senderId:'123',sender:'owner',id:'credential-1',timestamp:1,text:raw,isGroup:false,learningEligible:true}));
  await assert.rejects(new Reminders(join(dir,'reminders.sqlite')).schedule('telegram','123','123',raw,Date.now()+2000),/Credentials cannot be stored/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('confirmed facts persist current owner/message evidence only in the matching scope',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fact-provenance-'));
 try {
  const facts=new FactsStore(join(dir,'facts'));const fact='My favorite color is blue.';
  await facts.update('telegram:123','123',fact,false,{transport:'telegram',chatId:'123',senderId:'123',sender:'owner',id:'direct-fact-1',timestamp:1234,text:fact,isGroup:false,learningEligible:true});
  const rows=await(await collection('facts')).find({ns:namespace(join(dir,'facts'))}).toArray();
  assert.equal(rows.length,1);assert.deepEqual(rows[0].provenance[hash(fact)],{owner:'123',message:'direct-fact-1',at:1234,excerpt:fact});
  assert.deepEqual(await facts.read('telegram:123','456'),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
