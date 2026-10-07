import { preventCredentialStorage } from './credentials.js';
import Database from 'better-sqlite3';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorType, logger } from './logger.js';
import { collection,hash,namespace,migrate,nextSequence } from './mongo.js';
export interface Reminder {id:number;transport:string;chat:string;owner:string;text:string;due:number;state:string;}
interface Bucket {_id:string;ns:string;chat:string;items:Reminder[];}
// At most 100 pending and the 100 highest-ID non-pending records per chat are retained.
// Terminal audit retention follows scheduling order, not completion time; legacy backups are untouched.
// Claimed means delivery uncertain and is NEVER replayed, even after its audit record is pruned.
const terminalLimit=100;
const retention=[{$set:{items:{$concatArrays:[{$filter:{input:'$items',as:'r',cond:{$eq:['$$r.state','pending']}}},{$slice:[{$sortArray:{input:{$filter:{input:'$items',as:'r',cond:{$ne:['$$r.state','pending']}}},sortBy:{id:1}}},-terminalLimit]}]}}}];
export type ReminderAuthorization=(reminder:Reminder)=>boolean;
// One chat document makes the 100-pending limit, insertion and claims atomic on standalone Mongo.
export class Reminders {
 private readonly ns:string;private timer?:NodeJS.Timeout;private busy=false;private active?:Promise<void>;
 constructor(private readonly path:string){this.ns=namespace(dirname(path));}
 async ready():Promise<void>{await migrate(this.ns,'reminders',async()=>{
  if(!existsSync(this.path))return;if(lstatSync(this.path).isSymbolicLink()||!lstatSync(this.path).isFile())throw new Error('Unsafe legacy reminder file');
  // SQLite exists solely for read-only migration. Never create, change pragmas or update legacy rows.
  const db=new Database(this.path,{readonly:true,fileMustExist:true});let rows:Reminder[];try{rows=db.prepare('SELECT * FROM reminders ORDER BY id').all() as Reminder[];}finally{db.close();}
  const coll=await collection<Bucket>('reminders');let maximum=0;
  for(const row of rows){preventCredentialStorage(row.text);if(!Number.isSafeInteger(row.id)||!Number.isFinite(row.due))throw new Error('Invalid legacy reminder');maximum=Math.max(maximum,row.id);const _id=`${this.ns}:${hash(row.chat)}`;await coll.updateOne({_id},{$setOnInsert:{ns:this.ns,chat:row.chat,items:[]}},{upsert:true});await coll.updateOne({_id,'items.id':{$ne:row.id}},{$push:{items:row}});await coll.updateOne({_id},retention);}
  await(await collection<{_id:string;value:number}>('counters')).updateOne({_id:`${this.ns}:reminders`},{$max:{value:maximum}},{upsert:true});
 });}
 async schedule(transport:string,chat:string,owner:string,text:string,due:number):Promise<number>{
  if(!Number.isSafeInteger(due)||due<Date.now()+1000||due>Date.now()+366*86400000)throw new Error('Due time must be within the next year');if(!text.trim()||text.length>1200)throw new Error('Reminder must be 1-1200 characters');preventCredentialStorage(text);await this.ready();
  const coll=await collection<Bucket>('reminders');const _id=`${this.ns}:${hash(chat)}`;await coll.updateOne({_id},{$setOnInsert:{ns:this.ns,chat,items:[]}},{upsert:true});const id=await nextSequence(this.ns,'reminders');
  await coll.updateOne({_id},retention);
  const result=await coll.updateOne({_id,$expr:{$lt:[{$size:{$filter:{input:'$items',as:'item',cond:{$eq:['$$item.state','pending']}}}},100]}},{$push:{items:{id,transport,chat,owner,text,due,state:'pending'}}});
  if(!result.modifiedCount)throw new Error('This chat has 100 pending reminders');return id;
 }
 async list(chat:string,owner:string):Promise<Reminder[]>{await this.ready();return ((await(await collection<Bucket>('reminders')).findOne({_id:`${this.ns}:${hash(chat)}`}))?.items??[]).filter(r=>r.owner===owner&&r.state==='pending').sort((a,b)=>a.due-b.due);}
 async cancel(chat:string,owner:string,id:number):Promise<boolean>{await this.ready();const coll=await collection<Bucket>('reminders');const _id=`${this.ns}:${hash(chat)}`;const changed=Boolean((await coll.updateOne({_id,items:{$elemMatch:{id,owner,state:'pending'}}},{$set:{'items.$.state':'cancelled'}})).modifiedCount);await coll.updateOne({_id},retention);return changed;}
 async tick(deliver:(reminder:Reminder)=>Promise<void>,authorized:ReminderAuthorization=()=>true):Promise<void>{
  if(this.busy)return;this.busy=true;
  try{await this.ready();const coll=await collection<Bucket>('reminders');await coll.updateMany({ns:this.ns},retention);const now=Date.now();const buckets=await coll.find({ns:this.ns,items:{$elemMatch:{state:'pending',due:{$lte:now}}}}).toArray();
   const due=buckets.flatMap(b=>b.items.filter(r=>r.state==='pending'&&r.due<=now).map(r=>({bucket:b._id,item:r}))).sort((a,b)=>a.item.due-b.item.due).slice(0,10);
   for(const {bucket,item}of due){if(!authorized(item)){await coll.updateOne({_id:bucket,items:{$elemMatch:{id:item.id,state:'pending'}}},{$set:{'items.$.state':'revoked'}});continue;}if(!(await coll.updateOne({_id:bucket,items:{$elemMatch:{id:item.id,state:'pending'}}},{$set:{'items.$.state':'claimed'}})).modifiedCount)continue;
    try{if(!authorized(item)){await coll.updateOne({_id:bucket,items:{$elemMatch:{id:item.id,state:'claimed'}}},{$set:{'items.$.state':'revoked'}});continue;}await deliver(item);await coll.updateOne({_id:bucket,items:{$elemMatch:{id:item.id,state:'claimed'}}},{$set:{'items.$.state':'sent'}});}catch(error){logger.error({err:errorType(error),reminderId:item.id},'reminder send uncertain; not retrying');}
   }
   await coll.updateMany({ns:this.ns},retention);
  }finally{this.busy=false;}
 }
 start(deliver:(reminder:Reminder)=>Promise<void>,authorized:ReminderAuthorization=()=>true):void{const run=()=>{if(this.busy)return;this.active=this.tick(deliver,authorized).catch(error=>logger.error({err:errorType(error)},'reminder store unavailable'));};this.timer=setInterval(run,1000);run();}
 stop():void{clearInterval(this.timer);}
 async close():Promise<void>{this.stop();await this.active;}
}
