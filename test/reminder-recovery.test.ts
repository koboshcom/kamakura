import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Collection} from 'mongodb';
import {Reminders} from '../src/reminders.js';
import {collection,namespace,hash} from '../src/mongo.js';
test('isolated ENOSPC claim cannot send; durable record retries after recovery; send commit failure stays visible',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'reminder-enospc-')),reminders=new Reminders(join(dir,'reminders.sqlite'));
 try{await reminders.ready();const ns=namespace(dir),_id=ns+':'+hash('chat'),coll=await collection('reminders');
 await coll.insertOne({_id,ns,chat:'chat',items:[{id:1,transport:'telegram',chat:'chat',owner:'alice',text:'owned fixture',due:0,state:'pending'}]});
 const original=Collection.prototype.updateOne;let mode='claim',sends=0;
 t.mock.method(Collection.prototype,'updateOne',async function(this:Collection,filter:any,update:any,options:any){
  if(filter._id===_id&&((mode==='claim'&&update.$set?.['items.$.state']==='sending')||(mode==='commit'&&update.$set?.['items.$.state']==='sent'))){const error=Error('private ENOSPC fixture');error.name='MongoServerError';throw error;}
  return original.call(this,filter,update,options);
 });
 await assert.rejects(reminders.tick(async()=>{sends++;}),/ENOSPC/);assert.equal(sends,0);assert.equal((await reminders.list('chat','alice')).length,1);
 mode='commit';await reminders.tick(async()=>{sends++;});assert.equal(sends,1);assert.equal((await coll.findOne({_id}))!.items[0].state,'sending');assert.equal((await reminders.list('chat','alice')).length,1);
 mode='off';await coll.updateOne({_id},{$set:{'items.0.leaseUntil':0}});await new Reminders(join(dir,'reminders.sqlite')).tick(async()=>{sends++;});assert.equal(sends,2,'send succeeded before persistence failed, at-least-once recovery can duplicate');assert.equal((await coll.findOne({_id}))!.items[0].state,'sent');
 }finally{await reminders.close();await rm(dir,{recursive:true,force:true});}
});
test('schedule never reports success without acknowledged insertion',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'reminder-ack-')),reminders=new Reminders(join(dir,'reminders.sqlite'));
 try{await reminders.ready();const original=Collection.prototype.updateOne;
 t.mock.method(Collection.prototype,'updateOne',async function(this:Collection,filter:any,update:any,options:any){if(update.$push?.items)return {acknowledged:false,modifiedCount:0,matchedCount:0,upsertedCount:0,upsertedId:null};return original.call(this,filter,update,options);});
 await assert.rejects(reminders.schedule('telegram','chat','alice','fixture',Date.now()+60000),/not acknowledged/);assert.deepEqual(await reminders.list('chat','alice'),[]);
 }finally{await reminders.close();await rm(dir,{recursive:true,force:true});}
});
