import {randomUUID,createHash} from 'node:crypto';
import {scopeRepository} from './scope-storage.js';
import {namespace,hash} from './mongo.js';
import {join} from 'node:path';
import {config} from './config.js';
type Data={known:Array<{target:string;enrollment:string;box:string;at:number}>;claims:Array<{key:string;at:number}>};
type Row={_id:string;ns:string;scope:string;envelope:{current:{revision:string;data:Data}}};
export class TransferStore {
 private repo=scopeRepository<Row>('lessons');private ns:string;
 constructor(dir:string){this.ns=namespace(dir);}
 private id(owner:string){return this.ns+':'+hash(owner);}
 private async mutate<T>(owner:string,fn:(d:Data)=>T){const id=this.id(owner);
  await this.repo.initialize({_id:id,ns:this.ns,scope:hash(owner),envelope:{current:{revision:randomUUID(),data:{known:[],claims:[]}}}});
  for(let i=0;i<20;i++){const row=await this.repo.get(id);if(!row)throw new Error('Transfer state unavailable');const d=row.envelope.current.data;
   if(!Array.isArray(d.known)||!Array.isArray(d.claims)||d.known.length>32||d.claims.length>64)throw new Error('Invalid transfer state');
   const result=fn(d);if(await this.repo.replace(id,row.envelope.current.revision,{...row,envelope:{current:{revision:randomUUID(),data:d}}}))return result;
  }throw new Error('Transfer contention');
 }
 async known(owner:string,box:string,enrollment:string,target:string){const row=await this.repo.get(this.id(owner));return !!row?.envelope.current.data.known.some(k=>k.box===box&&k.enrollment===enrollment&&k.target===target);}
 async remember(owner:string,box:string,enrollment:string,target:string){return this.mutate(owner,d=>{if(d.known.some(k=>k.box===box&&k.enrollment===enrollment&&k.target===target))return;if(d.known.length>=32)throw new Error('Known destination cap');d.known.push({box,enrollment,target,at:Date.now()});});}
 async claim(owner:string,identity:unknown){const key=createHash('sha256').update(JSON.stringify(identity)).digest('hex');return this.mutate(owner,d=>{const now=Date.now();d.claims=d.claims.filter(c=>now-c.at<10*60000);if(d.claims.some(c=>c.key===key)||d.claims.length>=64)return false;d.claims.push({key,at:now});return true;});}
}
export const transferStore=new TransferStore(join(config.dataDir,'file-transfer-receipts'));
