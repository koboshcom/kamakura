import { config } from './config.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { captureCredentials, redactCredentials } from './credentials.js';
import { collection, hash, namespace, legacyJson, migrate, nextSequence } from './mongo.js';
export interface StoredMessage {role:'user'|'assistant';sender?:string;senderId?:string;id?:string;credentialEligible?:boolean;text:string;at:number;}
export interface HistoryQuery {query?:string;limit?:number;order?:'earliest'|'latest';role?:'user'|'assistant'|'all';afterId?:string;beforeId?:string;from?:number;to?:number;exact?:boolean;}
interface Row extends StoredMessage {_id:string;ns:string;chat:string;owner:string;sequence:number;}
const clean=(m:StoredMessage):StoredMessage=>{captureCredentials(m.text);return {...m,text:redactCredentials(m.text),credentialEligible:false};};
const message=(r:Row):StoredMessage=>{const {_id,ns,chat,owner,sequence,...m}=r;return clean(m);};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export class HistoryStore {
 private readonly ns:string;
 constructor(private readonly dir:string,private readonly limit:number){this.ns=namespace(dir);}
 async ready():Promise<void>{await migrate(this.ns,'history',async()=>{
  const archived=(legacyJson(join(this.dir,'history-archive.json'))??{}) as Record<string,StoredMessage[]>;
  const recent=(legacyJson(join(this.dir,'history.json'))??{}) as Record<string,StoredMessage[]>;
  const coll=await collection<Row>('history');let maximum=0;
  for(const key of new Set([...Object.keys(archived),...Object.keys(recent)])){
   // A multiset, not a set. Identical genuine messages in either source survive.
   const identity=(m:StoredMessage)=>JSON.stringify([m.role,m.id,m.senderId,m.at,m.text]);
   const merged=[...(archived[key]??[])];const counts=new Map<string,number>();for(const m of merged)counts.set(identity(m),(counts.get(identity(m))??0)+1);
   const seen=new Map<string,number>();for(const m of recent[key]??[]){const id=identity(m);const n=(seen.get(id)??0)+1;seen.set(id,n);if(n>(counts.get(id)??0))merged.push(m);}
   const ops=merged.map((m,n)=>{if(!Number.isFinite(m.at)||typeof m.text!=='string'||!['user','assistant'].includes(m.role))throw new Error('Invalid legacy history');
    const doc:Row={...clean(m),_id:hash(JSON.stringify([this.ns,key,n,identity(m)])),ns:this.ns,chat:key,owner:m.senderId??(key.startsWith('telegram:')&&!key.startsWith('telegram:-')?key.slice(9):''),sequence:n+1};maximum=Math.max(maximum,n+1);
    return {updateOne:{filter:{_id:doc._id},update:{$setOnInsert:doc},upsert:true}};});
   for(let i=0;i<ops.length;i+=500)await coll.bulkWrite(ops.slice(i,i+500));
  }
  const counters=await collection<{_id:string;value:number}>('counters');await counters.updateOne({_id:`${this.ns}:history`},{$max:{value:maximum}},{upsert:true});
 });}
 async get(key:string):Promise<StoredMessage[]>{await this.ready();return (await (await collection<Row>('history')).find({ns:this.ns,chat:key}).sort({at:-1,sequence:-1}).limit(this.limit).toArray()).reverse().map(message);}
 async add(key:string,m:StoredMessage):Promise<void>{await this.ready();const doc:Row={...clean(m),_id:randomUUID(),ns:this.ns,chat:key,owner:m.senderId??(key.startsWith('telegram:')&&!key.startsWith('telegram:-')?key.slice(9):''),sequence:await nextSequence(this.ns,'history')};await (await collection<Row>('history')).insertOne(doc);}
 async lookup(key:string,owner:string,options:HistoryQuery={}){
  await this.ready();const coll=await collection<Row>('history');const scope={ns:this.ns,chat:key,owner};
  const earliest=await coll.find(scope).sort({at:1,sequence:1}).limit(1).next();const latest=await coll.find(scope).sort({at:-1,sequence:-1}).limit(1).next();
  const clauses:Filter<Row>[]=[scope];let missingAnchor=false;
  for(const [id,after]of [[options.afterId,true],[options.beforeId,false]] as const)if(id){const anchor=await coll.find({...scope,id}).sort({at:1,sequence:1}).limit(1).next();if(!anchor){missingAnchor=true;continue;}clauses.push({$or:[{at:after?{$gt:anchor.at}:{$lt:anchor.at}},{at:anchor.at,sequence:after?{$gt:anchor.sequence}:{$lt:anchor.sequence}}]});}
  if(options.role&&options.role!=='all')clauses.push({role:options.role});
  if(options.from!==undefined||options.to!==undefined)clauses.push({at:{...(options.from!==undefined?{$gte:options.from}:{}),...(options.to!==undefined?{$lte:options.to}:{})}});
  const base:Filter<Row>={$and:clauses};let filter:Filter<Row>=base;
  if(options.query){if(options.exact)filter={$and:[base,{text:options.query}]};else{
   filter={$and:[base,{$text:{$search:options.query,$caseSensitive:false}}]};
   // Substring fallback only when indexed token search finds nothing (e.g. partial words).
   if(!missingAnchor&&!(await coll.countDocuments(filter)))filter={$and:[base,...options.query.split(/\s+/).filter(Boolean).map(word=>({text:{$regex:escape(word),$options:'i'}}))]};
  }}
  const direction=options.order==='earliest'?1:-1;
  const matched=missingAnchor?0:await coll.countDocuments(filter);
  const selected=missingAnchor?[]:await coll.find(filter).sort({at:direction,sequence:direction}).limit(Math.min(20,Math.max(1,options.limit??8))).toArray();
  const contextCount=config.historyContextMessages;
  const contextRows=new Map<string,Row>();
  for(const hit of selected){contextRows.set(hit._id,hit);if(contextCount){
   const before=await coll.find({$and:[scope,{$or:[{at:{$lt:hit.at}},{at:hit.at,sequence:{$lt:hit.sequence}}]}]}).sort({at:-1,sequence:-1}).limit(contextCount).toArray();
   const after=await coll.find({$and:[scope,{$or:[{at:{$gt:hit.at}},{at:hit.at,sequence:{$gt:hit.sequence}}]}]}).sort({at:1,sequence:1}).limit(contextCount).toArray();
   for(const row of [...before,...after])contextRows.set(row._id,row);
  }}
  const hitIds=new Set(selected.map(row=>row._id));const timestamp=(row:Row)=>({...message(row),timestamp:new Date(row.at).toISOString()});
  const context=[...contextRows.values()].sort((a,b)=>a.at-b.at||a.sequence-b.sequence).map(row=>({...timestamp(row),matched:hitIds.has(row._id)}));
  return {messages:selected.map(timestamp),context,matched,missingAnchor,earliestAvailable:earliest?.at??null,latestAvailable:latest?.at??null,coverage:'Retained messages only. Legacy recent-window caps may have discarded older messages. Earliest available is not proof of first-ever. Text is exact except credential redaction; never infer missing messages.'};
 }
 async search(key:string,owner:string,query:string,limit=8):Promise<StoredMessage[]>{return (await this.lookup(key,owner,{query,limit})).messages;}
}
