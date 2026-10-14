import {cacheDigest} from './cost-cache.js';
export class ExactEmbeddingCache {
 private rows=new Map<string,{expires:number;promise:Promise<unknown>}>();
 constructor(private max=128,private ttl=300000,private clock:()=>number=Date.now){}
 async get<T>(owner:string|undefined,profile:unknown,text:string,load:()=>Promise<T>,validate:(v:T)=>void):Promise<T>{
  if(!owner){const value=await load();validate(value);return value;}
  const key=cacheDigest([owner,profile,text]),now=this.clock();
  for(const [k,row]of this.rows)if(row.expires<=now)this.rows.delete(k);
  let row=this.rows.get(key);
  if(row){this.rows.delete(key);this.rows.set(key,row);}
  else{
   if(this.rows.size>=this.max)this.rows.delete(this.rows.keys().next().value!);
   row={expires:now+this.ttl,promise:Promise.resolve().then(load)};this.rows.set(key,row);
   const created=row;
   row.promise=row.promise.then(value=>{validate(value as T);return structuredClone(value);}).catch(error=>{if(this.rows.get(key)===created)this.rows.delete(key);throw error;});
  }
  const value=structuredClone(await row.promise) as T;
  try{validate(value);}catch(error){if(this.rows.get(key)===row)this.rows.delete(key);throw error;}
  return value;
 }
}
export const embeddingReuse=new ExactEmbeddingCache();
