import {collection} from '../src/mongo.js';
import {storageBackend,rows,sqlite,row,put,remove,type SqliteTable} from '../src/sqlite.js';
// Test-only inspection and corruption fixtures. No runtime query emulation.
export async function storedRows(domain:SqliteTable,scope:Record<string,unknown>={}):Promise<any[]> {
 if(storageBackend()==='mongo')return (await collection(domain)).find(scope).toArray();
 const all=scope.ns===undefined?(sqlite().prepare(`SELECT payload FROM ${domain}`).all() as {payload:string}[]).map(r=>JSON.parse(r.payload)):rows<any>(domain,String(scope.ns));
 return all.filter(r=>Object.entries(scope).every(([k,v])=>k.split('.').reduce((o,key)=>o?.[key],r)===v));
}
export async function storedCount(domain:SqliteTable,scope:Record<string,unknown>={}){return (await storedRows(domain,scope)).length;}
export async function seedRecord(domain:SqliteTable,record:any){if(storageBackend()==='mongo')await (await collection(domain)).replaceOne({_id:record._id},record,{upsert:true});else put(domain,record._id,record.ns??record._id,record);}
export async function changeRecord(domain:SqliteTable,id:string,change:(r:any)=>void){
 const r=storageBackend()==='mongo'?await (await collection(domain)).findOne({_id:id}):row<any>(domain,id);
 if(!r)throw new Error('Missing fixture record');change(r);await seedRecord(domain,r);
}
export async function deleteRecord(domain:SqliteTable,id:string){if(storageBackend()==='mongo')await (await collection(domain)).deleteOne({_id:id});else remove(domain,id);}
