import OpenAI from 'openai';
import { collection,hash } from './mongo.js';
import { redactStoredCredentials as redactCredentials } from './credentials.js';
interface Candidate {_id:string;ns:string;chat:string;owner:string;text:string;}
interface Vector {_id:string;ns:string;chat:string;owner:string;model:string;vector:number[];}
export async function semanticSelect<T extends Candidate>(query:string,rows:T[],limit:number):Promise<{rows:T[];status:string;coverage?:unknown}>{
 const baseURL=process.env.EMBEDDING_BASE_URL,apiKey=process.env.EMBEDDING_API_KEY,model=process.env.EMBEDDING_MODEL;
 if(!baseURL||!apiKey||!model)return {rows:[],status:'keyword-embedding-disabled'};
 const dimension=Number(process.env.EMBEDDING_DIMENSIONS??768);if(!Number.isSafeInteger(dimension)||dimension<1||dimension>8192)return {rows:[],status:'keyword-embedding-invalid-config'};
 try{
  const client=new OpenAI({baseURL,apiKey,maxRetries:1,timeout:Math.min(10000,Number(process.env.EMBEDDING_TIMEOUT_MS??5000))});
  const embed=async(input:string[])=>{const result=await client.embeddings.create({model,input:input.map(redactCredentials),encoding_format:'float'});const ordered=[...result.data].sort((a,b)=>a.index-b.index);if(ordered.length!==input.length||ordered.some((r,i)=>r.index!==i||r.embedding.length!==dimension||r.embedding.some(v=>!Number.isFinite(v))))throw new Error('Invalid embedding response');return ordered.map(r=>r.embedding);};
  if(!rows.length)return {rows:[],status:'keyword',coverage:{candidates:0,indexed:0}};
  const scope={ns:rows[0]!.ns,chat:rows[0]!.chat,owner:rows[0]!.owner};
  if(rows.some(r=>r.ns!==scope.ns||r.chat!==scope.chat||r.owner!==scope.owner))throw new Error('Mixed embedding scopes');
  const coll=await collection<Vector>('history_vectors');const prefix=hash(JSON.stringify([baseURL,model,dimension]));const id=(r:T)=>hash(JSON.stringify([prefix,r._id,hash(r.text)]));
  const existing=await coll.find({...scope,_id:{$in:rows.map(id)}}).toArray();const vectors=new Map(existing.filter(v=>v.vector.length===dimension&&v.vector.every(Number.isFinite)).map(v=>[v._id,v.vector]));
  // Incremental bounded indexing, never a full-history backfill on the request path.
  const missing=rows.filter(r=>!vectors.has(id(r))).slice(0,16);
  if(missing.length){const batch=await embed(missing.map(r=>r.text.slice(0,8000)));for(const [i,row]of missing.entries()){const vector=batch[i]!;await coll.updateOne({_id:id(row)},{$setOnInsert:{...scope,model,vector}},{upsert:true});vectors.set(id(row),vector);}}
  const [q]=await embed([query.slice(0,2000)]);const norm=(v:number[])=>Math.sqrt(v.reduce((s,x)=>s+x*x,0));const qnorm=norm(q!);if(!qnorm)throw new Error('Zero embedding');
  const scored=rows.flatMap(row=>{const v=vectors.get(id(row));if(!v)return [];const denom=qnorm*norm(v);const score=denom?q!.reduce((s,x,i)=>s+x*v[i]!,0)/denom:0;return score>=Number(process.env.EMBEDDING_MIN_SCORE??0.3)?[{row,score}]:[];}).sort((a,b)=>b.score-a.score).slice(0,limit);
  return {rows:scored.map(s=>s.row),status:'semantic',coverage:{candidates:rows.length,indexed:vectors.size,scope:'At most 64 recent scoped candidates; at most 16 new embeddings per lookup. Not complete history.'}};
 }catch{return {rows:[],status:'keyword-embedding-unavailable'};}
}
