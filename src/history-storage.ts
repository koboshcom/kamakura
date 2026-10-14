import {collection} from './mongo.js';
import {storageBackend,sqlite,insert,row,rows} from './sqlite.js';
import type {StoredMessage} from './history.js';
import type {StoredEmbedding} from './embeddings.js';
export interface HistoryRow extends StoredMessage {_id:string;ns:string;chat:string;owner:string;sequence:number;embedding?:StoredEmbedding}
export interface HistoryScope {ns:string;chat:string;owner?:string}
export interface HistorySelection extends HistoryScope {id?:string;role?:'user'|'assistant';from?:number;to?:number;after?:{at:number;sequence:number};before?:{at:number;sequence:number};highWater?:number}
export type HistoryOrder='oldest'|'newest'|'sequenceAsc'|'sequenceDesc';
export interface HistoryRepository {
 ready():Promise<void>;commit(doc:HistoryRow):Promise<HistoryRow>;select(scope:HistorySelection,order:HistoryOrder,limit?:number):Promise<HistoryRow[]>;count(scope:HistorySelection):Promise<number>;scan(scope:HistorySelection):AsyncIterable<HistoryRow>;
}
function filter(q:HistorySelection){return {ns:q.ns,chat:q.chat,...(q.owner===undefined?{}:{owner:q.owner}),...(q.id===undefined?{}:{id:q.id}),...(q.role?{role:q.role}:{}),...((q.from!==undefined||q.to!==undefined)?{at:{...(q.from!==undefined?{$gte:q.from}:{}),...(q.to!==undefined?{$lte:q.to}:{})}}:{}),...(q.highWater!==undefined?{sequence:{$lte:q.highWater}}:{}),$and:[...(q.after?[{$or:[{at:{$gt:q.after.at}},{at:q.after.at,sequence:{$gt:q.after.sequence}}]}]:[]),...(q.before?[{$or:[{at:{$lt:q.before.at}},{at:q.before.at,sequence:{$lt:q.before.sequence}}]}]:[]),{}]};}
const sort=(order:HistoryOrder):import('mongodb').Sort=>order==='oldest'?{at:1,sequence:1,_id:1} as const:order==='newest'?{at:-1,sequence:-1,_id:-1} as const:order==='sequenceAsc'?{sequence:1,_id:1} as const:{sequence:-1,_id:-1} as const;
class MongoHistory implements HistoryRepository {
 async ready(){await collection<HistoryRow>('history');}
 async commit(doc:HistoryRow){const c=await collection<HistoryRow>('history');await c.updateOne({_id:doc._id},{$setOnInsert:doc},{upsert:true});return (await c.findOne({_id:doc._id}))!;}
 async select(q:HistorySelection,order:HistoryOrder,limit?:number){let c=(await collection<HistoryRow>('history')).find(filter(q)).sort(sort(order));if(limit!==undefined)c=c.limit(limit);return c.toArray();}
 async count(q:HistorySelection){return (await collection<HistoryRow>('history')).countDocuments(filter(q));}
 async *scan(q:HistorySelection){const c=(await collection<HistoryRow>('history')).find(filter(q)).sort(sort('sequenceAsc')).batchSize(256);try{for await(const r of c)yield r;}finally{await c.close();}}
}
class SqliteHistory implements HistoryRepository {
 async ready(){sqlite();}
 async commit(doc:HistoryRow){insert('history',doc._id,doc.ns,doc);return row<HistoryRow>('history',doc._id)!;}
 private eligible(q:HistorySelection){
  return rows<HistoryRow>('history',q.ns).filter(r=>r.chat===q.chat&&(q.owner===undefined||r.owner===q.owner)&&(q.id===undefined||r.id===q.id)&&(!q.role||r.role===q.role)&&(q.from===undefined||r.at>=q.from)&&(q.to===undefined||r.at<=q.to)&&(q.highWater===undefined||r.sequence<=q.highWater)&&(!q.after||r.at>q.after.at||r.at===q.after.at&&r.sequence>q.after.sequence)&&(!q.before||r.at<q.before.at||r.at===q.before.at&&r.sequence<q.before.sequence));
 }
 async select(q:HistorySelection,order:HistoryOrder,limit?:number){
  const direction=order==='newest'||order==='sequenceDesc'?-1:1;
  const result=this.eligible(q).sort((a,b)=>direction*((order==='oldest'||order==='newest'?a.at-b.at:0)||a.sequence-b.sequence||a._id.localeCompare(b._id)));
  return limit===undefined?result:result.slice(0,limit);
 }
 async count(q:HistorySelection){return this.eligible(q).length;}
 async *scan(q:HistorySelection){for(const r of await this.select(q,'sequenceAsc'))yield r;}
}
export const historyRepository=():HistoryRepository=>storageBackend()==='sqlite'?new SqliteHistory():new MongoHistory();
