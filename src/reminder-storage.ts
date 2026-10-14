import {collection,hash,nextSequence} from './mongo.js';
import {storageBackend,sqlite,row,rows,insert,put,atomic} from './sqlite.js';
import type {Reminder} from './reminders.js';
export interface ReminderBucket {_id:string;ns:string;chat:string;items:Reminder[]}
export type ReminderMatch=Pick<Reminder,'id'|'state'> & Partial<Pick<Reminder,'claim'|'leaseUntil'>>;
export interface ReminderRepository {
 ready():Promise<void>;initialize(ns:string,chat:string):Promise<void>;next(ns:string):Promise<number>;schedule(ns:string,chat:string,item:Reminder):Promise<void>;
 list(ns:string,chat:string):Promise<Reminder[]>;retain(ns:string):Promise<void>;due(ns:string,now:number):Promise<ReminderBucket[]>;
 transition(bucket:string,match:ReminderMatch,patch:Partial<Reminder>,clearLease?:boolean):Promise<boolean>;
}
const retention=[{$set:{items:{$concatArrays:[{$filter:{input:'$items',as:'r',cond:{$in:['$$r.state',['pending','sending']]}}},{$slice:[{$sortArray:{input:{$filter:{input:'$items',as:'r',cond:{$not:[{$in:['$$r.state',['pending','sending']]}]}}},sortBy:{id:1}}},-100]}]}}}];
const bucketId=(ns:string,chat:string)=>ns+':'+hash(chat);
class MongoReminders implements ReminderRepository {
 async ready(){await collection<ReminderBucket>('reminders');}
 async initialize(ns:string,chat:string){await (await collection<ReminderBucket>('reminders')).updateOne({_id:bucketId(ns,chat)},{$setOnInsert:{ns,chat,items:[]}},{upsert:true});}
 async next(ns:string){return nextSequence(ns,'reminders');}
 async schedule(ns:string,chat:string,item:Reminder){
  const c=await collection<ReminderBucket>('reminders'),_id=bucketId(ns,chat);await c.updateOne({_id},retention);
  const result=await c.updateOne({_id,$expr:{$lt:[{$size:{$filter:{input:'$items',as:'item',cond:{$in:['$$item.state',['pending','sending']]}}}},100]}},{$push:{items:item}});
  if(!result.acknowledged)throw new Error('Reminder persistence not acknowledged');if(!result.modifiedCount)throw new Error('This chat has 100 pending reminders');
 }
 async list(ns:string,chat:string){return (await (await collection<ReminderBucket>('reminders')).findOne({_id:bucketId(ns,chat)}))?.items??[];}
 async retain(ns:string){await (await collection<ReminderBucket>('reminders')).updateMany({ns},retention);}
 async due(ns:string,now:number){return (await collection<ReminderBucket>('reminders')).find({ns,items:{$elemMatch:{due:{$lte:now},$or:[{state:'pending'},{state:'sending',leaseUntil:{$lte:now}}]}}}).toArray();}
 async transition(bucket:string,match:ReminderMatch,patch:Partial<Reminder>,clearLease=false){
  const set=Object.fromEntries(Object.entries(patch).map(([k,v])=>['items.$.'+k,v]));
  const result=await (await collection<ReminderBucket>('reminders')).updateOne({_id:bucket,items:{$elemMatch:match}},{$set:set,...(clearLease?{$unset:{'items.$.claim':'','items.$.leaseUntil':''}}:{})});
  if(!result.acknowledged)throw new Error('Reminder persistence not acknowledged');return Boolean(result.modifiedCount);
 }
}
function trim(items:Reminder[]){return [...items.filter(r=>r.state==='pending'||r.state==='sending'),...items.filter(r=>r.state!=='pending'&&r.state!=='sending').sort((a,b)=>a.id-b.id).slice(-100)];}
class SqliteReminders implements ReminderRepository {
 async ready(){sqlite();}
 async initialize(ns:string,chat:string){insert('reminders',bucketId(ns,chat),ns,{_id:bucketId(ns,chat),ns,chat,items:[]});}
 async next(ns:string){return atomic(()=>{const key=ns+':reminders',value=(row<{value:number}>('counters',key)?.value??0)+1;if(!Number.isSafeInteger(value))throw new Error('Reminder counter exhausted');put('counters',key,ns,{_id:key,value});return value;});}
 async schedule(ns:string,chat:string,item:Reminder){atomic(()=>{const key=bucketId(ns,chat),b=row<ReminderBucket>('reminders',key)!;b.items=trim(b.items);if(b.items.filter(r=>r.state==='pending'||r.state==='sending').length>=100)throw new Error('This chat has 100 pending reminders');b.items.push(item);put('reminders',key,ns,b);});}
 async list(ns:string,chat:string){return row<ReminderBucket>('reminders',bucketId(ns,chat))?.items??[];}
 async retain(ns:string){atomic(()=>{for(const b of rows<ReminderBucket>('reminders',ns)){const next=trim(b.items);if(JSON.stringify(next)!==JSON.stringify(b.items))put('reminders',b._id,ns,{...b,items:next});}});}
 async due(ns:string,now:number){return rows<ReminderBucket>('reminders',ns).filter(b=>b.items.some(r=>r.due<=now&&(r.state==='pending'||r.state==='sending'&&(r.leaseUntil??0)<=now)));}
 async transition(bucket:string,match:ReminderMatch,patch:Partial<Reminder>,clearLease=false){return atomic(()=>{const b=row<ReminderBucket>('reminders',bucket);if(!b)return false;const r=b.items.find(r=>Object.entries(match).every(([k,v])=>r[k as keyof Reminder]===v));if(!r)return false;Object.assign(r,patch);if(clearLease){delete r.claim;delete r.leaseUntil;}put('reminders',bucket,b.ns,b);return true;});}
}
export const reminderRepository=():ReminderRepository=>storageBackend()==='sqlite'?new SqliteReminders():new MongoReminders();
