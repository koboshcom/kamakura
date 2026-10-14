import {historyProvenance,boundedOwnerMessages,type HistoryProvenance} from './owner-history.js';
import { DurableBuffer } from './storage-buffer.js';
import { embedText, embeddingConfig, validatedVector, cosine, EmbeddingUnavailable, type StoredEmbedding } from './embeddings.js';
import { config } from './config.js';
import { randomUUID } from 'node:crypto';
import {historyRepository,type HistorySelection,type HistoryRow} from './history-storage.js';
import {storageBackend,sqlite} from './sqlite.js';
import { captureCredentials, redactStoredCredentials as redactCredentials } from './credentials.js';
import {isStorageUnavailable} from './storage.js';
import { hash, namespace } from './mongo.js';
export interface StoredMessage {provenance?:HistoryProvenance;voiceCall?:string;voiceCoverage?:string;voiceStartMs?:number;voiceEndMs?:number;sourceChat?:string;role:'user'|'assistant';sender?:string;senderId?:string;id?:string;credentialEligible?:boolean;text:string;at:number;}
export interface HistoryQuery {query?:string;limit?:number;order?:'earliest'|'latest';role?:'user'|'assistant'|'all';afterId?:string;beforeId?:string;from?:number;to?:number;exact?:boolean;}
import {contextOwner} from './owner-context.js';
import {chatKey,type IncomingMessage} from './types.js';
type Row=HistoryRow;
const clean=(m:StoredMessage):StoredMessage=>{captureCredentials(m.text);return {...m,text:redactCredentials(m.text),credentialEligible:false};};
const message=(r:Row):StoredMessage=>{const {_id,ns,chat,owner,sequence,embedding,...m}=r;return clean({...m,sourceChat:chat});};
/** Exactly one active store owns each DATA_DIR journal. Stop it before constructing its recovery replacement. */
export class HistoryStore {
 private readonly repository=historyRepository(); private readonly ns:string; private readonly buffer:DurableBuffer<Row>;private recent=new Map<string,StoredMessage[]>();private sequence=0;
 constructor(private readonly dir:string,private readonly limit:number){if(storageBackend()==='sqlite')sqlite();this.ns=namespace(dir);this.buffer=new DurableBuffer<Row>(dir,undefined,storageBackend()==='sqlite'?'history-pending-sqlite.json':'history-pending.json');this.sequence=this.buffer.pending().reduce((max,r)=>Math.max(max,r.sequence),0);}
 async recover():Promise<void>{await this.ready();await this.buffer.flush(async doc=>{
  const config=embeddingConfig();
  const embedding=await embedText(doc.text,config);
  // The row and its vector commit together in one insert-only storage record.
  const stored=await this.repository.commit({...doc,embedding});
  if(!stored||stored.ns!==doc.ns||stored.chat!==doc.chat||stored.owner!==doc.owner||stored.text!==doc.text||stored.role!==doc.role||stored.id!==doc.id)throw new Error('History idempotency conflict');
  validatedVector(stored.embedding,stored.text,config);
 });}
 private snapshot(key:string):StoredMessage[]{const pending=this.buffer.pending().filter(r=>r.chat===key&&r.ns===this.ns).map(message);return [...(this.recent.get(key)??[]),...pending].slice(-this.limit);}
 // No history migration or backfill. Existing unvectorized history requires the approved beta-only wipe.
 async ready():Promise<void>{await this.repository.ready();}
 async get(key:string):Promise<StoredMessage[]>{try{await this.recover();const rows=(await this.repository.select({ns:this.ns,chat:key},'newest',this.limit)).reverse().map(message);this.recent.set(key,rows);while(this.recent.size>64)this.recent.delete(this.recent.keys().next().value!);return rows;}catch(error){if(!isStorageUnavailable(error))throw error;return this.snapshot(key);}}
 async add(key:string,m:StoredMessage,incoming?:IncomingMessage,captured?:HistoryProvenance):Promise<void>{const provenance=incoming&&chatKey(incoming)===key?historyProvenance(incoming):captured?.version===1&&captured.chat===key&&captured.owner===m.senderId&&captured.channel===key.split(':')[0]?captured:undefined;m={...m,provenance};const owner=provenance?.owner??m.senderId??(key.startsWith('telegram:')&&!key.startsWith('telegram:-')?key.slice(9):'');const doc:Row={...clean(m),_id:(m.role==='user'||m.voiceCall)&&m.id?hash(JSON.stringify([this.ns,key,owner,m.role,m.id])):randomUUID(),ns:this.ns,chat:key,owner,sequence:this.sequence=Math.max(this.sequence+1,Date.now()*1000)};this.buffer.append(doc);try{await this.recover();}catch(error){if(!isStorageUnavailable(error))throw error;/* Accepted only after durable journal fsync; background recovery retries. */}}
 async ownerLookup(incoming:IncomingMessage,options:HistoryQuery={}) {
  const owner=contextOwner(incoming);if(!owner)throw new Error("Authenticated private owner context required");
  return this.lookup(chatKey(incoming),owner,options,true);
 }
 async ownerRecent(incoming:IncomingMessage):Promise<StoredMessage[]> {
  const result=await this.ownerLookup(incoming,{limit:Math.min(20,this.limit),role:"all"});return boundedOwnerMessages(result.messages).reverse();
 }
 async lookup(key:string,owner:string,options:HistoryQuery={},shared=false){
  try{return await this.lookupOnline(key,owner,options,shared);}catch(error){
   if(!isStorageUnavailable(error)&&!(error instanceof EmbeddingUnavailable))throw error;
   return {messages:[] as (StoredMessage&{timestamp:string})[],context:[] as (StoredMessage&{timestamp:string;matched:boolean})[],matched:0,missingAnchor:false,earliestAvailable:null,latestAvailable:null,degraded:true,retrieval:'unavailable',coverage:'History search is unavailable; no lexical, cached, journal or bounded-window fallback. Do not infer absence.'};
  }
 }
 private async lookupOnline(key:string,owner:string,options:HistoryQuery={},shared=false){
  if(options.query&&options.exact)throw new Error('Exact lexical search is unsupported; query search uses embeddings only');
  await this.recover();const repo=this.repository;const scope:HistorySelection={ns:this.ns,...(shared?{verified:true}:{chat:key}),owner};
  const earliest=(await repo.select(scope,'oldest',1))[0],latest=(await repo.select(scope,'newest',1))[0];
  const base:HistorySelection={...scope};let missingAnchor=false;
  for(const [id,after]of [[options.afterId,true],[options.beforeId,false]] as const)if(id){
   const anchor=(await repo.select({...scope,id},'oldest',1))[0];
   if(!anchor){missingAnchor=true;continue;}base[after?'after':'before']={at:anchor.at,sequence:anchor.sequence};
  }
  if(options.role&&options.role!=='all')base.role=options.role;
  if(options.from!==undefined)base.from=options.from;if(options.to!==undefined)base.to=options.to;
  const direction=options.order==='earliest'?1:-1;
  const limit=Math.min(20,Math.max(1,options.limit??8));
  let matched=0,selected:Row[]=[],retrieval=options.query?'semantic':'chronological';
  let semanticCoverage:unknown;
  if(options.query&&!missingAnchor){
   const config=embeddingConfig(),q=await embedText(options.query,config),ranked:{row:Row;score:number}[]=[];
   // Immutable rows, server-enforced scope, stable ordering and a fixed sequence high-water mark.
   // Saves concurrent with this cursor may appear on the next query; this is not a transactional snapshot.
   const high=(await repo.select(base,'sequenceDesc',1))[0];let scanned=0;
   const cursor=repo.scan({...base,highWater:high?.sequence??0});
   for await(const row of cursor){
    const score=cosine(q.vector,validatedVector(row.embedding,row.text,config));scanned++;
    if(score<config.minScore)continue;matched++;ranked.push({row,score});
    ranked.sort((a,b)=>b.score-a.score||a.row.sequence-b.row.sequence||a.row._id.localeCompare(b.row._id));if(ranked.length>limit)ranked.pop();
   }
   selected=ranked.map(hit=>hit.row);
   if(options.order)selected.sort((a,b)=>direction*(a.at-b.at||a.sequence-b.sequence||a._id.localeCompare(b._id)));
   semanticCoverage={scanned,scope:shared?'All retained verified rows in authenticated canonical owner namespace; no candidate cap':'All retained eligible rows in authenticated transport/chat/owner scope; no candidate cap',highWaterSequence:high?.sequence??0};
  }else if(!missingAnchor){
   matched=await repo.count(base);selected=await repo.select(base,direction===1?'oldest':'newest',limit);
  }

  const contextCount=config.historyContextMessages;
  const contextRows=new Map<string,Row>();
  for(const hit of selected){contextRows.set(hit._id,hit);if(contextCount){
   const before=await repo.select({...scope,before:{at:hit.at,sequence:hit.sequence}},'newest',contextCount);
   const after=await repo.select({...scope,after:{at:hit.at,sequence:hit.sequence}},'oldest',contextCount);
   for(const row of [...before,...after])contextRows.set(row._id,row);
  }}
  const hitIds=new Set(selected.map(row=>row._id));const timestamp=(row:Row)=>({...message(row),timestamp:new Date(row.at).toISOString()});
  const context=[...contextRows.values()].sort((a,b)=>a.at-b.at||a.sequence-b.sequence).map(row=>({...timestamp(row),matched:hitIds.has(row._id)}));
  return {messages:shared?boundedOwnerMessages(selected.map(timestamp)):selected.map(timestamp),context:shared?boundedOwnerMessages(context):context,matched,retrieval,semanticCoverage,degraded:false,missingAnchor,earliestAvailable:earliest?.at??null,latestAvailable:latest?.at??null,coverage:'Retained messages only. Legacy recent-window caps may have discarded older messages. Earliest available is not proof of first-ever. Text is exact except credential redaction; never infer missing messages.'};
 }
 async search(key:string,owner:string,query:string,limit=8):Promise<StoredMessage[]>{return (await this.lookup(key,owner,{query,limit})).messages;}
}
