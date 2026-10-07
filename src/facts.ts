import { basename } from 'node:path';
import { preventCredentialStorage } from './credentials.js';
import { collection,hash,namespace,legacyFiles,legacyJson,migrate } from './mongo.js';
interface Facts {_id:string;ns:string;scope:string;facts:string[];revision:number;}
export class FactsStore {
 private readonly ns:string;private cache=new Map<string,string[]>();
 constructor(private readonly dir:string){this.ns=namespace(dir);}
 async ready():Promise<void>{await migrate(this.ns,'facts',async()=>{const coll=await collection<Facts>('facts');for(const path of legacyFiles(this.dir)){const value=legacyJson(path) as {facts:string[]};if(!Array.isArray(value.facts))throw new Error('Invalid legacy facts');for(const fact of value.facts)preventCredentialStorage(fact);const scope=basename(path,'.json');await coll.updateOne({_id:`${this.ns}:${scope}`},{$setOnInsert:{ns:this.ns,scope,facts:value.facts,revision:0}},{upsert:true});}});}
 private scope(chat:string,user?:string):string{return hash(JSON.stringify([chat,user??null]));}
 async read(chat:string,user?:string):Promise<string[]>{const key=this.scope(chat,user);try{await this.ready();const facts=(await(await collection<Facts>('facts')).findOne({_id:`${this.ns}:${key}`}))?.facts??[];this.cache.set(key,facts);while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);return [...facts];}catch{return [...(this.cache.get(key)??[])];}}
 async update(chat:string,user:string|undefined,fact:string,remove=false):Promise<string[]>{
  if(!fact.trim()||fact.length>500)throw new Error('Fact must be 1-500 characters');preventCredentialStorage(fact);await this.ready();const coll=await collection<Facts>('facts');const scope=this.scope(chat,user);const _id=`${this.ns}:${scope}`;
  await coll.updateOne({_id},{$setOnInsert:{ns:this.ns,scope,facts:[],revision:0}},{upsert:true});
  for(let attempt=0;attempt<100;attempt++){const old=(await coll.findOne({_id}))!;const facts=old.facts.filter(x=>x!==fact);if(!remove)facts.push(fact);if(facts.length>100)throw new Error('Fact limit reached; remove outdated facts first');if((await coll.updateOne({_id,revision:old.revision},{$set:{facts},$inc:{revision:1}})).modifiedCount)return facts;}
  throw new Error('Facts update contention');
 }
}
