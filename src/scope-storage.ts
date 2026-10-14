import {collection} from './mongo.js';
import {storageBackend,row,insert,put,atomic} from './sqlite.js';
import type {Document} from 'mongodb';
/** Fixed domain operations: initialization, read and optimistic revision replacement. */
export interface ScopeRepository<T extends Document & {_id:string;ns:string}> {
 get(id:string):Promise<T|null>;initialize(row:T):Promise<void>;replace(id:string,revision:string|number,next:T):Promise<boolean>;
}
export function scopeRepository<T extends Document & {_id:string;ns:string}>(domain:'facts'|'lessons'):ScopeRepository<T> {
 const revision=(doc:T):string|number=>domain==='facts'?doc.revision:doc.envelope.current.revision;
 if(storageBackend()==='sqlite')return {
  async get(id){return row<T>(domain,id);},
  async initialize(doc){insert(domain,doc._id,doc.ns,doc);},
  async replace(id,expected,next){return atomic(()=>{const old=row<T>(domain,id);if(!old||revision(old)!==expected)return false;put(domain,id,old.ns,next);return true;});}
 };
 return {
  async get(id){return (await collection<T>(domain)).findOne({_id:id} as never) as Promise<T|null>;},
  async initialize(doc){await (await collection<T>(domain)).updateOne({_id:doc._id} as never,{$setOnInsert:doc} as never,{upsert:true});},
  async replace(id,expected,next){const match=domain==='facts'?{_id:id,revision:expected}:{_id:id,'envelope.current.revision':expected};return (await (await collection<T>(domain)).updateOne(match as never,{$set:next} as never)).modifiedCount===1;}
 };
}
