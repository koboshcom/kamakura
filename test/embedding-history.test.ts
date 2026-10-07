import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore} from '../src/history.js';
import {embeddingConfig,embedText,unitVector,cosine,EmbeddingUnavailable} from '../src/embeddings.js';
import {collection,namespace} from '../src/mongo.js';
import {embeddingFixture} from './embedding-fixture.js';
import {Collection,MongoNetworkError} from 'mongodb';
test('actual SDK save embeds full redacted text in every row atomically, concurrent duplicate IDs remain one row',async()=>{
 const fixture=await embeddingFixture(),old=process.env.EMBEDDING_BASE_URL,dir=mkdtempSync(join(tmpdir(),'vector-save-'));
 process.env.EMBEDDING_BASE_URL=fixture.url;
 try{
  const store=new HistoryStore(dir,2),text='first '.repeat(600)+'tailword';
  await Promise.all(Array.from({length:20},(_,i)=>store.add('telegram:42',{role:i%2?'assistant':'user',senderId:'42',id:String(i),text:i===0?text:'password=uniquetestsecret99',at:i})));
  await Promise.all(Array.from({length:5},()=>store.add('telegram:42',{role:'user',senderId:'42',id:'same',text:'same text',at:30})));
  const rows=await(await collection('history')).find({ns:namespace(dir)}).toArray();assert.equal(rows.length,21);
  for(const row of rows){assert.equal(row.embedding.model,'fixture');assert.equal(row.embedding.dimensions,64);assert.equal(row.embedding.vector.length,64);assert(!JSON.stringify(row).includes('uniquetestsecret99'));}
  assert(fixture.requests.every(r=>r.encoding_format==='float'));assert(fixture.requests.flatMap(r=>r.input).join('').includes(text));
  assert(!JSON.stringify(fixture.requests).includes('uniquetestsecret99'));assert.deepEqual(JSON.parse(readFileSync(join(dir,'history-pending.json'),'utf8')),[]);
 }finally{process.env.EMBEDDING_BASE_URL=old;await fixture.close();rmSync(dir,{recursive:true,force:true});}
});
test('full-scope streamed cosine finds old semantic matches beyond 64, filters transport/chat/owner and stable tie ordering',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vector-query-'));try{
  const store=new HistoryStore(dir,2),coll=await collection('history');
  await store.add('telegram:42',{role:'user',senderId:'42',id:'old',text:'lunar wrench',at:1});
  for(let i=0;i<520;i++)await store.add('telegram:42',{role:'user',senderId:'42',id:'f'+i,text:'unrelated recent',at:i+2});
  for(const [key,owner]of [['whatsapp:15551234567@s.whatsapp.net','42'],['telegram:42','99'],['telegram:-100','42']])await store.add(key!,{role:'user',senderId:owner,id:'private',text:'lunar wrench',at:999});
  const result=await store.lookup('telegram:42','42',{query:'wrench lunar',limit:2});assert.equal(result.retrieval,'semantic');assert.deepEqual(result.messages.map(m=>m.id),['old']);assert.equal((result.semanticCoverage as {scanned:number}).scanned,521);
  const row=await coll.findOne({ns:namespace(dir),id:'old'});assert(row);await coll.updateOne({_id:row._id},{$set:{'embedding.owner':'99','embedding.chat':'whatsapp:evil'}});
  assert.deepEqual((await store.search('telegram:42','42','wrench lunar')).map(m=>m.id),['old']);
  await store.add('telegram:42',{role:'user',senderId:'42',id:'tie',text:'lunar wrench',at:1000});
  const first=await store.search('telegram:42','42','wrench lunar');const second=await store.search('telegram:42','42','wrench lunar');assert.deepEqual(first.map(m=>m.id),second.map(m=>m.id));
  await coll.updateOne({_id:row._id},{$set:{'embedding.dimensions':2}});const invalid=await store.lookup('telegram:42','42',{query:'recent'});assert.equal(invalid.retrieval,'unavailable');assert.deepEqual(invalid.messages,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('save embedding failure leaves durable pending record and no unvectorized Mongo row; query fails closed; recovery retries full save',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vector-failure-')),base=process.env.EMBEDDING_BASE_URL;try{
  const store=new HistoryStore(dir,2);process.env.EMBEDDING_BASE_URL='http://127.0.0.1:1/v1';
  await assert.rejects(store.add('telegram:42',{role:'user',senderId:'42',id:'retry',text:'not silently dropped',at:1}),EmbeddingUnavailable);
  assert.equal(await(await collection('history')).countDocuments({ns:namespace(dir)}),0);
  assert.equal(JSON.parse(readFileSync(join(dir,'history-pending.json'),'utf8')).length,1);
  const unavailable=await store.lookup('telegram:42','42',{query:'not silently dropped'});assert.equal(unavailable.retrieval,'unavailable');assert.deepEqual(unavailable.messages,[]);
  process.env.EMBEDDING_BASE_URL=base;await new HistoryStore(dir,2).recover();assert.equal(await(await collection('history')).countDocuments({ns:namespace(dir)}),1);
  assert.equal((await store.search('telegram:42','42','dropped silently')).length,1);
  await assert.rejects(store.lookup('telegram:42','42',{query:'not silently dropped',exact:true}),/unsupported/);
  for(const anchor of [{afterId:'missing'},{beforeId:'missing'}])await assert.rejects(store.lookup('telegram:42','42',{query:'not silently dropped',exact:true,...anchor}),/unsupported/);
  const chronology=await store.lookup('telegram:42','42',{query:'',exact:true});assert.equal(chronology.retrieval,'chronological');assert.equal(chronology.messages.length,1);
 }finally{process.env.EMBEDDING_BASE_URL=base;rmSync(dir,{recursive:true,force:true});}
});
test('cosine normalization and metadata are strict, including zero and nonfinite vectors',async()=>{
 assert.equal(cosine(unitVector([3,4],2),unitVector([6,8],2)),1);
 assert.equal(cosine(unitVector([1,0],2),unitVector([0,1],2)),0);
 for(const vector of [[0,0],[NaN,1],[Infinity,1],[1]])assert.throws(()=>unitVector(vector,2),EmbeddingUnavailable);
 const config=embeddingConfig(),fetch=globalThis.fetch;
 try{for(const change of [{model:'wrong'},{data:[{index:0,embedding:[1]}]},{data:[{index:1,embedding:Array(64).fill(1)}]}]){
  globalThis.fetch=async()=>new Response(JSON.stringify({model:config.model,data:[{index:0,embedding:Array(64).fill(1)}],...change}),{headers:{'content-type':'application/json'}});
  await assert.rejects(embedText('query',config),EmbeddingUnavailable);
 }}finally{globalThis.fetch=fetch;}
});
test('ambiguous Mongo commit retries idempotently and query Mongo outage has no journal or keyword fallback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vector-ambiguous-')),ns=namespace(dir),store=new HistoryStore(dir,2);
 const originalUpdate=Collection.prototype.updateOne,originalFind=Collection.prototype.find;
 let injected=false;
 try{
  Object.defineProperty(Collection.prototype,'updateOne',{configurable:true,writable:true,value:async function(this:Collection,...args:Parameters<typeof originalUpdate>){
   const result=await Reflect.apply(originalUpdate,this,args);
   const insert=(args[1] as {$setOnInsert?:{ns?:string}}).$setOnInsert;
   if(this.collectionName==='history'&&insert?.ns===ns&&!injected){injected=true;throw new MongoNetworkError('synthetic lost reply after actual committed upsert');}
   return result;
  }});
  await store.add('telegram:42',{role:'user',senderId:'42',id:'commit',text:'lunar wrench',at:1});
  assert(injected);const coll=await collection('history');
  const rows=await coll.find({ns}).toArray();assert.equal(rows.length,1);assert(rows[0]!.embedding?.vector.length);
  assert.equal(JSON.parse(readFileSync(join(dir,'history-pending.json'),'utf8')).length,1);
  Object.defineProperty(Collection.prototype,'updateOne',{configurable:true,writable:true,value:originalUpdate});
  await Promise.all([store.recover(),store.recover(),store.add('telegram:42',{role:'user',senderId:'42',id:'commit',text:'lunar wrench',at:1})]);
  assert.equal(await coll.countDocuments({ns}),1);assert.deepEqual(JSON.parse(readFileSync(join(dir,'history-pending.json'),'utf8')),[]);
  Object.defineProperty(Collection.prototype,'find',{configurable:true,writable:true,value:function(this:Collection,...args:Parameters<typeof originalFind>){
   if(this.collectionName==='history'&&(args[0] as {ns?:string})?.ns===ns)throw new MongoNetworkError('synthetic query outage');
   return Reflect.apply(originalFind,this,args);
  }});
  const result=await store.lookup('telegram:42','42',{query:'lunar wrench'});
  assert.equal(result.retrieval,'unavailable');assert.equal(result.degraded,true);assert.deepEqual(result.messages,[]);assert.deepEqual(result.context,[]);
  assert.match(result.coverage,/no lexical, cached, journal or bounded-window fallback/);
  Object.defineProperty(Collection.prototype,'find',{configurable:true,writable:true,value:originalFind});
  assert.equal((await store.search('telegram:42','42','wrench lunar')).length,1);
 }finally{
  Object.defineProperty(Collection.prototype,'updateOne',{configurable:true,writable:true,value:originalUpdate});
  Object.defineProperty(Collection.prototype,'find',{configurable:true,writable:true,value:originalFind});
  rmSync(dir,{recursive:true,force:true});
 }
});
