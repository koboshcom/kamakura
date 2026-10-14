import {storageBackend,atomic,row,rows,remove,insert} from './sqlite.js';
import {collection,hash,namespace} from './mongo.js';
import {config} from './config.js';
export interface DiscordClaims {claim(chat:string,id:string):Promise<boolean>}
export class MongoDiscordClaims implements DiscordClaims {
 private indexed?:Promise<unknown>;
 async claim(chat:string,id:string):Promise<boolean>{
  if(storageBackend()==='sqlite')return atomic(()=>{
   const ns=namespace(config.dataDir),now=Date.now(),key=hash(ns+':'+chat+':'+id);
   for(const old of rows<{_id:string;at:number}>('discord_claims',ns))if(old.at+600000<=now)remove('discord_claims',old._id);
   return insert('discord_claims',key,ns,{_id:key,at:now});
  });
  const coll=await collection<{_id:string;at:Date}>('discord_claims');
  await(this.indexed??=coll.createIndex({at:1},{expireAfterSeconds:600}));
  try{await coll.insertOne({_id:hash(namespace(config.dataDir)+':'+chat+':'+id),at:new Date()});return true;}
  catch(error){if((error as {code?:number}).code===11000)return false;throw error;}
 }
}
