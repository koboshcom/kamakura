import 'dotenv/config';
import { MongoClient, type Db, type Document, type Collection } from 'mongodb';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function isMongoUnavailable(error:unknown):boolean {return error instanceof Error&&(/^Mongo(?:ServerSelection|Network|NetworkTimeout|TopologyClosed|NotConnected|PoolClosed|ServerClosed|OperationTimeout|WaitQueueTimeout)/.test(error.name)||(error.name==='MongoServerError'&&[6,7,89,91,189,9001].includes(Number((error as Error&{code?:number}).code))));}
export const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export const namespace = (dir:string) => hash(resolve(dir));
let client:MongoClient|undefined; let connected:Promise<Db>|undefined;
export async function mongo():Promise<Db> {
 if(!connected){
  const uri=process.env.MONGODB_URI||'mongodb://mongo:27017';
  const database=process.env.MONGODB_DATABASE||'kamakura';
  if(!/^[a-zA-Z0-9_-]{1,60}$/.test(database))throw new Error('Invalid Mongo database name');
  client=new MongoClient(uri,{serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,maxPoolSize:20,retryWrites:false,writeConcern:{w:1,j:true}});
  connected=(async()=>{await client!.connect();const db=client!.db(database);await db.command({ping:1});
   await db.collection('history').createIndex({ns:1,chat:1,owner:1,at:1,sequence:1});
   await db.collection('history').createIndex({ns:1,chat:1,owner:1,id:1});
   await db.collection('history').createIndex({ns:1,chat:1,owner:1,text:'text'},{default_language:'none'});
   await db.collection('reminders').createIndex({ns:1,'items.state':1,'items.due':1});
   await db.collection('reminders').createIndex({ns:1,chat:1});
   return db;})().catch(async error=>{const failed=client;connected=undefined;client=undefined;await failed?.close().catch(()=>undefined);throw error;});
 }
 return connected;
}
export async function closeMongo():Promise<void>{await client?.close();client=undefined;connected=undefined;migrations.clear();}
export async function collection<T extends Document>(name:string):Promise<Collection<T>>{return (await mongo()).collection<T>(name);}
export function legacyJson(path:string):unknown|undefined {
 if(!existsSync(path))return;
 if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error('Unsafe legacy storage file');
 return JSON.parse(readFileSync(path,'utf8'));
}
export function legacyFiles(dir:string):string[]{
 if(!existsSync(dir))return [];
 if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw new Error('Unsafe legacy storage directory');
 return readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort().map(name=>join(dir,name));
}
// Deterministic upserts make a killed migration resumable. Sources remain byte-for-byte backups.
const migrations=new Map<string,Promise<void>>();
export async function migrate(ns:string,kind:string,run:()=>Promise<void>):Promise<void>{
 const id=`${ns}:${kind}:v1`;let active=migrations.get(id);
 if(!active){active=(async()=>{const marks=await collection<{_id:string;complete?:boolean}>('migrations');if((await marks.findOne({_id:id}))?.complete)return;await run();await marks.updateOne({_id:id},{$set:{complete:true}},{upsert:true});})();migrations.set(id,active);}
 try{await active;}catch(error){migrations.delete(id);throw error;}
}
export async function nextSequence(ns:string,key:string):Promise<number>{
 const coll=await collection<{_id:string;value:number}>('counters');
 const row=await coll.findOneAndUpdate({_id:`${ns}:${key}`},{$inc:{value:1}},{upsert:true,returnDocument:'after'});
 return row!.value;
}
