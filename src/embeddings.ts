import {embeddingReuse} from './embedding-cache.js';
import {cacheDigest} from './cost-cache.js';
import OpenAI from 'openai';
import {readProvider,validateProvider,providerFetch} from './provider-settings.js';
import { hash } from './mongo.js';
import { redactStoredCredentials } from './credentials.js';
export class EmbeddingUnavailable extends Error {
 constructor(message='Embedding search unavailable'){super(message);this.name='EmbeddingUnavailable';}
}
export interface EmbeddingConfig {baseURL:string;apiKey:string;model:string;dimensions:number;timeout:number;minScore:number;profile:string;}
export interface StoredEmbedding {profile:string;model:string;dimensions:number;textHash:string;vector:number[];}
export function embeddingConfig():EmbeddingConfig {
 const {baseUrl:baseURL,apiKey,model}=validateProvider('embedding',readProvider('embedding'));
 const dimensions=Number(process.env.EMBEDDING_DIMENSIONS??768),timeout=Number(process.env.EMBEDDING_TIMEOUT_MS??5000),minScore=Number(process.env.EMBEDDING_MIN_SCORE??0.3);
 if(!Number.isSafeInteger(dimensions)||dimensions<1||dimensions>8192||!Number.isSafeInteger(timeout)||timeout<1||timeout>60000||!Number.isFinite(minScore)||minScore < -1||minScore>1)throw new EmbeddingUnavailable('Invalid embedding configuration');
 // Credentials never enter metadata. Version includes full-text chunking/normalization policy.
 return {baseURL,apiKey,model,dimensions,timeout,minScore,profile:hash(JSON.stringify(['full-text-mean-unit-v1',baseURL,model,dimensions]))};
}
export function unitVector(vector:unknown,dimensions:number):number[] {
 if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new EmbeddingUnavailable('Invalid embedding dimensions or values');
 const scale=Math.max(...vector.map(Math.abs));if(!scale)throw new EmbeddingUnavailable('Zero embedding');
 const scaled=vector.map(x=>x/scale),norm=Math.sqrt(scaled.reduce((s,x)=>s+x*x,0));return scaled.map(x=>x/norm);
}
export function validatedVector(embedding:StoredEmbedding|undefined,text:string,config:EmbeddingConfig):number[] {
 if(!embedding||embedding.profile!==config.profile||embedding.model!==config.model||embedding.dimensions!==config.dimensions||embedding.textHash!==hash(text))throw new EmbeddingUnavailable('History vectors are incomplete or incompatible; no backfill or fallback');
 return unitVector(embedding.vector,config.dimensions);
}
export function cosine(a:number[],b:number[]):number {return Math.max(-1,Math.min(1,a.reduce((s,x,i)=>s+x*b[i]!,0)));}
/** All redacted text is embedded, not a prefix. Empty messages have a fixed sentinel. */
async function embedTextUncached(text:string,config=embeddingConfig()):Promise<StoredEmbedding> {
 validateProvider('embedding',{baseUrl:config.baseURL,apiKey:config.apiKey,model:config.model});
 try {
  const input=redactStoredCredentials(text),chars=Array.from(input||'[empty message]'),chunks:string[]=[];
  for(let i=0;i<chars.length;i+=1500)chunks.push(chars.slice(i,i+1500).join(''));
  const client=new OpenAI({baseURL:config.baseURL,apiKey:config.apiKey,adminAPIKey:null,webhookSecret:null,organization:null,project:null,logLevel:'off',fetch:providerFetch,maxRetries:0,timeout:config.timeout});
  const sum=Array<number>(config.dimensions).fill(0);let weight=0;
  for(let offset=0;offset<chunks.length;offset+=16){
   const batch=chunks.slice(offset,offset+16);
   const result=await client.embeddings.create({model:config.model,input:batch,encoding_format:'float'});
   if(result.model!==config.model||!Array.isArray(result.data)||result.data.length!==batch.length)throw new EmbeddingUnavailable('Invalid embedding response metadata');
   const ordered=[...result.data].sort((a,b)=>a.index-b.index);
   for(const [i,row]of ordered.entries()){
    if(row.index!==i)throw new EmbeddingUnavailable('Invalid embedding response indices');
    const vector=unitVector(row.embedding,config.dimensions),w=Array.from(batch[i]!).length;
    for(let j=0;j<sum.length;j++)sum[j]!+=vector[j]!*w;weight+=w;
   }
  }
  return {profile:config.profile,model:config.model,dimensions:config.dimensions,textHash:hash(text),vector:unitVector(sum.map(v=>v/weight),config.dimensions)};
 }catch(error){if(error instanceof EmbeddingUnavailable)throw error;throw new EmbeddingUnavailable('Embedding service request failed');}
}

export function embedText(text:string,config=embeddingConfig(),owner?:string):Promise<StoredEmbedding>{
 const validated=validateProvider('embedding',{baseUrl:config.baseURL,apiKey:config.apiKey,model:config.model});
 return embeddingReuse.get(owner,[config.profile,validated.baseUrl,cacheDigest(validated.apiKey),config.model,config.dimensions,'full-text-mean-unit-v1'],text,()=>embedTextUncached(text,config),v=>{validatedVector(v,text,config);});
}
