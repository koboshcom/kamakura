import { DurableBuffer } from './storage-buffer.js';
import { embedText, embeddingConfig, validatedVector, cosine, EmbeddingUnavailable, type StoredEmbedding } from './embeddings.js';
import { config } from './config.js';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { captureCredentials, redactStoredCredentials as redactCredentials } from './credentials.js';
import { collection, hash, namespace, isMongoUnavailable } from './mongo.js';
export interface StoredMessage {sourceChat?:string;role:'user'|'assistant';sender?:string;senderId?:string;id?:string;credentialEligible?:boolean;text:string;at:number;}
export interface HistoryQuery {query?:string;limit?:number;order?:'earliest'|'latest';role?:'user'|'assistant'|'all';afterId?:string;beforeId?:string;from?:number;to?:number;exact?:boolean;}
import {contextOwner} from './owner-context.js';
import {chatKey,type IncomingMessage} from './types.js';
interface Row extends StoredMessage {_id:string;ns:string;chat:string;owner:string;sequence:number;embedding?:StoredEmbedding;}
const clean=(m:StoredMessage):StoredMessage=>{captureCredentials(m.text);return {...m,text:redactCredentials(m.text),credentialEligible:false};};
const message=(r:Row):StoredMessage=>{const {_id,ns,chat,owner,sequence,embedding,...m}=r;return clean({...m,sourceChat:chat});};
/** Exactly one active store owns each DATA_DIR journal. Stop it before constructing its recovery replacement. */
export class HistoryStore {
 private readonly ns:string; private readonly buffer:DurableBuffer<Row>;private recent=new Map<string,StoredMessage[]>();private sequence=0;
 constructor(private readonly dir:string,private readonly limit:number){this.ns=namespace(dir);this.buffer=new DurableBuffer<Row>(dir);this.sequence=this.buffer.pending().reduce((max,r)=>Math.max(max,r.sequence),0);}
 async recover():Promise<void>{await this.ready();await this.buffer.flush(async doc=>{
  const config=embeddingConfig();
  const embedding=await embedText(doc.text,config);
  // The row and its vector commit together in one insert-only Mongo document.
  const coll=await collection<Row>('history');
  await coll.updateOne({_id:doc._id},{$setOnInsert:{...doc,embedding}},{upsert:true});
  const stored=await coll.findOne({_id:doc._id});
  if(!stored||stored.ns!==doc.ns||stored.chat!==doc.chat||stored.owner!==doc.owner||stored.text!==doc.text||stored.role!==doc.role||stored.id!==doc.id)throw new Error('History idempotency conflict');
  validatedVector(stored.embedding,stored.text,config);
 });}
 private snapshot(key:string):StoredMessage[]{const pending=this.buffer.pending().filter(r=>r.chat===key&&r.ns===this.ns).map(message);return [...(this.recent.get(key)??[]),...pending].slice(-this.limit);}
 // No history migration or backfill. Existing unvectorized history requires the approved beta-only wipe.
 async ready():Promise<void>{await collection<Row>('history');}
 async get(key:string):Promise<StoredMessage[]>{try{await this.recover();const rows=(await(await collection<Row>('history')).find({ns:this.ns,chat:key}).sort({at:-1,sequence:-1}).limit(this.limit).toArray()).reverse().map(message);this.recent.set(key,rows);while(this.recent.size>64)this.recent.delete(this.recent.keys().next().value!);return rows;}catch(error){if(!isMongoUnavailable(error))throw error;return this.snapshot(key);}}
 async add(key:string,m:StoredMessage):Promise<void>{const owner=m.senderId??(key.startsWith('telegram:')&&!key.startsWith('telegram:-')?key.slice(9):'');const doc:Row={...clean(m),_id:m.role==='user'&&m.id?hash(JSON.stringify([this.ns,key,owner,m.role,m.id])):randomUUID(),ns:this.ns,chat:key,owner,sequence:this.sequence=Math.max(this.sequence+1,Date.now()*1000)};this.buffer.append(doc);try{await this.recover();}catch(error){if(!isMongoUnavailable(error))throw error;/* Accepted only after durable journal fsync; background recovery retries. */}}
 async ownerLookup(incoming:IncomingMessage,options:HistoryQuery={}) {
  const owner=contextOwner(incoming);if(!owner)throw new Error("Authenticated private owner context required");
  return this.lookup(chatKey(incoming),owner,options,true);
 }
 async ownerRecent(incoming:IncomingMessage):Promise<StoredMessage[]> {
  const result=await this.ownerLookup(incoming,{limit:Math.min(20,this.limit),role:"all"});return [...result.messages].reverse();
 }
 async lookup(key:string,owner:string,options:HistoryQuery={},_shared=false){
  try{return await this.lookupOnline(key,owner,options);}catch(error){
   if(!isMongoUnavailable(error)&&!(error instanceof EmbeddingUnavailable))throw error;
   return {messages:[] as (StoredMessage&{timestamp:string})[],context:[] as (StoredMessage&{timestamp:string;matched:boolean})[],matched:0,missingAnchor:false,earliestAvailable:null,latestAvailable:null,degraded:true,retrieval:'unavailable',coverage:'History search is unavailable; no lexical, cached, journal or bounded-window fallback. Do not infer absence.'};
  }
 }
 private async lookupOnline(key:string,owner:string,options:HistoryQuery={}){
  if(options.query&&options.exact)throw new Error('Exact lexical search is unsupported; query search uses embeddings only');
  await this.recover();const coll=await collection<Row>('history');const scope:Filter<Row>={ns:this.ns,chat:key,owner};
  const earliest=await coll.find(scope).sort({at:1,sequence:1}).limit(1).next();const latest=await coll.find(scope).sort({at:-1,sequence:-1}).limit(1).next();
  const clauses:Filter<Row>[]=[scope];let missingAnchor=false;
  for(const [id,after]of [[options.afterId,true],[options.beforeId,false]] as const)if(id){const anchor=await coll.find({...scope,chat:key,id}).sort({at:1,sequence:1}).limit(1).next();if(!anchor){missingAnchor=true;continue;}clauses.push({$or:[{at:after?{$gt:anchor.at}:{$lt:anchor.at}},{at:anchor.at,sequence:after?{$gt:anchor.sequence}:{$lt:anchor.sequence}}]});}
  if(options.role&&options.role!=='all')clauses.push({role:options.role});
  if(options.from!==undefined||options.to!==undefined)clauses.push({at:{...(options.from!==undefined?{$gte:options.from}:{}),...(options.to!==undefined?{$lte:options.to}:{})}});
  const base:Filter<Row>={$and:clauses};
  const direction=options.order==='earliest'?1:-1;
  const limit=Math.min(20,Math.max(1,options.limit??8));
  let matched=0,selected:Row[]=[],retrieval=options.query?'semantic':'chronological';
  let semanticCoverage:unknown;
  if(options.query&&!missingAnchor){
   const config=embeddingConfig(),q=await embedText(options.query,config),ranked:{row:Row;score:number}[]=[];
   // Immutable rows, server-enforced scope, stable ordering and a fixed sequence high-water mark.
   // Saves concurrent with this cursor may appear on the next query; this is not a transactional snapshot.
   const high=await coll.find(base).sort({sequence:-1,_id:-1}).limit(1).next();let scanned=0;
   const cursor=coll.find({$and:[base,{sequence:{$lte:high?.sequence??0}}]}).sort({sequence:1,_id:1}).batchSize(256);
   try{for await(const row of cursor){
    const score=cosine(q.vector,validatedVector(row.embedding,row.text,config));scanned++;
    if(score<config.minScore)continue;matched++;ranked.push({row,score});
    ranked.sort((a,b)=>b.score-a.score||a.row.sequence-b.row.sequence||a.row._id.localeCompare(b.row._id));if(ranked.length>limit)ranked.pop();
   }}finally{await cursor.close();}
   selected=ranked.map(hit=>hit.row);
   if(options.order)selected.sort((a,b)=>direction*(a.at-b.at||a.sequence-b.sequence||a._id.localeCompare(b._id)));
   semanticCoverage={scanned,scope:'All retained eligible rows in authenticated transport/chat/owner scope; no candidate cap',highWaterSequence:high?.sequence??0};
  }else if(!missingAnchor){
   matched=await coll.countDocuments(base);selected=await coll.find(base).sort({at:direction,sequence:direction,_id:direction}).limit(limit).toArray();
  }

  const contextCount=config.historyContextMessages;
  const contextRows=new Map<string,Row>();
  for(const hit of selected){contextRows.set(hit._id,hit);if(contextCount){
   const before=await coll.find({$and:[scope,{$or:[{at:{$lt:hit.at}},{at:hit.at,sequence:{$lt:hit.sequence}}]}]}).sort({at:-1,sequence:-1}).limit(contextCount).toArray();
   const after=await coll.find({$and:[scope,{$or:[{at:{$gt:hit.at}},{at:hit.at,sequence:{$gt:hit.sequence}}]}]}).sort({at:1,sequence:1}).limit(contextCount).toArray();
   for(const row of [...before,...after])contextRows.set(row._id,row);
  }}
  const hitIds=new Set(selected.map(row=>row._id));const timestamp=(row:Row)=>({...message(row),timestamp:new Date(row.at).toISOString()});
  const context=[...contextRows.values()].sort((a,b)=>a.at-b.at||a.sequence-b.sequence).map(row=>({...timestamp(row),matched:hitIds.has(row._id)}));
  return {messages:selected.map(timestamp),context,matched,retrieval,semanticCoverage,degraded:false,missingAnchor,earliestAvailable:earliest?.at??null,latestAvailable:latest?.at??null,coverage:'Retained messages only. Legacy recent-window caps may have discarded older messages. Earliest available is not proof of first-ever. Text is exact except credential redaction; never infer missing messages.'};
 }
 async search(key:string,owner:string,query:string,limit=8):Promise<StoredMessage[]>{return (await this.lookup(key,owner,{query,limit})).messages;}
}
