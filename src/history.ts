import { DurableBuffer } from './storage-buffer.js';
import { semanticSelect } from './embeddings.js';
import { config } from './config.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { captureCredentials, redactStoredCredentials as redactCredentials } from './credentials.js';
import { collection, hash, namespace, legacyJson, migrate, nextSequence, isMongoUnavailable } from './mongo.js';
export interface StoredMessage {sourceChat?:string;role:'user'|'assistant';sender?:string;senderId?:string;id?:string;credentialEligible?:boolean;text:string;at:number;}
export interface HistoryQuery {query?:string;limit?:number;order?:'earliest'|'latest';role?:'user'|'assistant'|'all';afterId?:string;beforeId?:string;from?:number;to?:number;exact?:boolean;}
import {contextOwner} from './owner-context.js';
import {chatKey,type IncomingMessage} from './types.js';
interface Row extends StoredMessage {_id:string;ns:string;chat:string;owner:string;sequence:number;}
const clean=(m:StoredMessage):StoredMessage=>{captureCredentials(m.text);return {...m,text:redactCredentials(m.text),credentialEligible:false};};
const message=(r:Row):StoredMessage=>{const {_id,ns,chat,owner,sequence,...m}=r;return clean({...m,sourceChat:chat});};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export class HistoryStore {
 private readonly ns:string; private readonly buffer:DurableBuffer<Row>;private recent=new Map<string,StoredMessage[]>();private sequence=0;
 constructor(private readonly dir:string,private readonly limit:number){this.ns=namespace(dir);this.buffer=new DurableBuffer<Row>(dir);this.sequence=this.buffer.pending().reduce((max,r)=>Math.max(max,r.sequence),0);}
 async recover():Promise<void>{await this.ready();await this.buffer.flush(async doc=>{await(await collection<Row>('history')).updateOne({_id:doc._id},{$setOnInsert:doc},{upsert:true});});}
 private snapshot(key:string):StoredMessage[]{const pending=this.buffer.pending().filter(r=>r.chat===key&&r.ns===this.ns).map(message);return [...(this.recent.get(key)??[]),...pending].slice(-this.limit);}
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
 async get(key:string):Promise<StoredMessage[]>{try{await this.recover();const rows=(await(await collection<Row>('history')).find({ns:this.ns,chat:key}).sort({at:-1,sequence:-1}).limit(this.limit).toArray()).reverse().map(message);this.recent.set(key,rows);while(this.recent.size>64)this.recent.delete(this.recent.keys().next().value!);return rows;}catch(error){if(!isMongoUnavailable(error))throw error;return this.snapshot(key);}}
 async add(key:string,m:StoredMessage):Promise<void>{const owner=m.senderId??(key.startsWith('telegram:')&&!key.startsWith('telegram:-')?key.slice(9):'');const doc:Row={...clean(m),_id:m.role==='user'&&m.id?hash(JSON.stringify([this.ns,key,owner,m.role,m.id])):randomUUID(),ns:this.ns,chat:key,owner,sequence:this.sequence=Math.max(this.sequence+1,Date.now()*1000)};this.buffer.append(doc);try{await this.recover();}catch(error){if(!isMongoUnavailable(error))throw error;/* Accepted only after durable journal fsync; background recovery retries. */}}
 async ownerLookup(incoming:IncomingMessage,options:HistoryQuery={}) {
  const owner=contextOwner(incoming);if(!owner)throw new Error("Authenticated private owner context required");
  return this.lookup(chatKey(incoming),owner,options,true);
 }
 async ownerRecent(incoming:IncomingMessage):Promise<StoredMessage[]> {
  const result=await this.ownerLookup(incoming,{limit:Math.min(20,this.limit),role:"all"});return [...result.messages].reverse();
 }
 async lookup(key:string,owner:string,options:HistoryQuery={},shared=false){
  try{return await this.lookupOnline(key,owner,options,shared);}catch(error){if(!isMongoUnavailable(error))throw error;const anchors=Boolean(options.afterId||options.beforeId);const limit=Math.min(20,Math.max(1,options.limit??8));const candidates=this.snapshot(key).map((m,index)=>({m,index})).filter(({m})=>m.senderId===owner&&(!options.query||(options.exact?m.text===options.query:options.query.split(/\s+/).filter(Boolean).every(word=>m.text.toLocaleLowerCase().includes(word.toLocaleLowerCase()))))&&(!options.role||options.role==='all'||m.role===options.role)&&(options.from===undefined||m.at>=options.from)&&(options.to===undefined||m.at<=options.to)).sort((a,b)=>options.order==='earliest'?a.m.at-b.m.at||a.index-b.index:b.m.at-a.m.at||b.index-a.index);const messages=(anchors?[]:candidates.slice(0,limit)).map(({m})=>({...m,timestamp:new Date(m.at).toISOString()}));return {messages:options.afterId||options.beforeId?[]:messages,context:[],matched:anchors?0:candidates.length,missingAnchor:anchors,earliestAvailable:null,latestAvailable:null,degraded:true,retrieval:'outage-snapshot',coverage:'Mongo unavailable. Only bounded cached and pending messages are visible; no complete history or absent-message conclusions are available.'};}
 }
 private async lookupOnline(key:string,owner:string,options:HistoryQuery={},shared=false){
  await this.recover();const coll=await collection<Row>('history');const scope:Filter<Row>={ns:this.ns,chat:key,owner};
  const earliest=await coll.find(scope).sort({at:1,sequence:1}).limit(1).next();const latest=await coll.find(scope).sort({at:-1,sequence:-1}).limit(1).next();
  const clauses:Filter<Row>[]=[scope];let missingAnchor=false;
  for(const [id,after]of [[options.afterId,true],[options.beforeId,false]] as const)if(id){const anchor=await coll.find({...scope,chat:key,id}).sort({at:1,sequence:1}).limit(1).next();if(!anchor){missingAnchor=true;continue;}clauses.push({$or:[{at:after?{$gt:anchor.at}:{$lt:anchor.at}},{at:anchor.at,sequence:after?{$gt:anchor.sequence}:{$lt:anchor.sequence}}]});}
  if(options.role&&options.role!=='all')clauses.push({role:options.role});
  if(options.from!==undefined||options.to!==undefined)clauses.push({at:{...(options.from!==undefined?{$gte:options.from}:{}),...(options.to!==undefined?{$lte:options.to}:{})}});
  const base:Filter<Row>={$and:clauses};let filter:Filter<Row>=base;
  if(options.query){if(options.exact)filter={$and:[base,{text:options.query}]};else{
   filter=shared?{$and:[base,...options.query.split(/\s+/).filter(Boolean).map(word=>({text:{$regex:escape(word),$options:'i'}}))]}:{$and:[base,{$text:{$search:options.query,$caseSensitive:false}}]};
   // Substring fallback only when indexed token search finds nothing (e.g. partial words).
   if(!missingAnchor&&!(await coll.countDocuments(filter)))filter={$and:[base,...options.query.split(/\s+/).filter(Boolean).map(word=>({text:{$regex:escape(word),$options:'i'}}))]};
  }}
  const direction=options.order==='earliest'?1:-1;
  const matched=missingAnchor?0:await coll.countDocuments(filter);
  let selected=missingAnchor?[]:await coll.find(filter).sort({at:direction,sequence:direction}).limit(Math.min(20,Math.max(1,options.limit??8))).toArray();
  let retrieval='keyword';let semanticCoverage:unknown;
  if(options.query&&!options.exact&&!options.afterId&&!options.beforeId&&!options.order&&!selected.length){const candidates=await coll.find(base).sort({at:-1,sequence:-1}).limit(64).toArray();const semantic=await semanticSelect(options.query,candidates,Math.min(20,options.limit??8));retrieval=semantic.status;semanticCoverage=semantic.coverage;if(semantic.rows.length)selected=semantic.rows;}

  const contextCount=config.historyContextMessages;
  const contextRows=new Map<string,Row>();
  for(const hit of selected){contextRows.set(hit._id,hit);if(contextCount){
   const before=await coll.find({$and:[scope,{$or:[{at:{$lt:hit.at}},{at:hit.at,sequence:{$lt:hit.sequence}}]}]}).sort({at:-1,sequence:-1}).limit(contextCount).toArray();
   const after=await coll.find({$and:[scope,{$or:[{at:{$gt:hit.at}},{at:hit.at,sequence:{$gt:hit.sequence}}]}]}).sort({at:1,sequence:1}).limit(contextCount).toArray();
   for(const row of [...before,...after])contextRows.set(row._id,row);
  }}
  const hitIds=new Set(selected.map(row=>row._id));const timestamp=(row:Row)=>({...message(row),timestamp:new Date(row.at).toISOString()});
  const context=[...contextRows.values()].sort((a,b)=>a.at-b.at||a.sequence-b.sequence).map(row=>({...timestamp(row),matched:hitIds.has(row._id)}));
  return {messages:selected.map(timestamp),context,matched:selected.length&&retrieval==='semantic'?selected.length:matched,retrieval,semanticCoverage,degraded:false,missingAnchor,earliestAvailable:earliest?.at??null,latestAvailable:latest?.at??null,coverage:'Retained messages only. Legacy recent-window caps may have discarded older messages. Earliest available is not proof of first-ever. Text is exact except credential redaction; never infer missing messages.'};
 }
 async search(key:string,owner:string,query:string,limit=8):Promise<StoredMessage[]>{return (await this.lookup(key,owner,{query,limit})).messages;}
}
