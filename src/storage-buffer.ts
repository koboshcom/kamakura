import { mkdirSync, existsSync, lstatSync, readFileSync, openSync, constants, fchmodSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { captureCredentials, redactCredentials } from './credentials.js';
export class StorageBackpressure extends Error {constructor(){super('Storage outage buffer full; message not accepted');}}
/** A bounded recovery journal, never an alternate database. One process owns each DATA_DIR. */
export class DurableBuffer<T extends {_id:string}> {
 private rows:T[]; private running?:Promise<void>;
 readonly path:string;
 constructor(dir:string,private readonly maxBytes=Number(process.env.STORAGE_BUFFER_MAX_BYTES??16777216)){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1024)throw new Error('Invalid storage buffer quota');
  mkdirSync(dir,{recursive:true,mode:0o700});this.path=join(dir,'history-pending.json');
  if(existsSync(this.path)&&(!lstatSync(this.path).isFile()||lstatSync(this.path).isSymbolicLink()))throw new Error('Unsafe recovery journal');
  this.rows=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):[];
  if(!Array.isArray(this.rows)||this.rows.some(r=>typeof r._id!=='string'))throw new Error('Invalid recovery journal');
  if(this.rows.length)this.save(this.rows);
 }
 private save(rows:T[]){
  const scrub=(value:unknown):unknown=>{if(typeof value==='string'){captureCredentials(value);return redactCredentials(value);}if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v)]));return value;};
  const sanitized=scrub(rows) as T[];const data=JSON.stringify(sanitized);
  if(Buffer.byteLength(data)>this.maxBytes)throw new StorageBackpressure();
  const tmp=this.path+'.tmp';const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{fchmodSync(fd,0o600);writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,this.path);
  const directory=openSync(join(this.path,'..'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}this.rows=sanitized;
 }
 pending():T[]{return structuredClone(this.rows);}
 append(row:T){if(!this.rows.some(r=>r._id===row._id))this.save([...this.rows,row]);}
 flush(write:(row:T)=>Promise<void>):Promise<void>{
  if(this.running)return this.running;
  this.running=(async()=>{while(this.rows.length){const row=this.rows[0]!;await write(row);this.save(this.rows.filter(r=>r._id!==row._id));}})().finally(()=>{this.running=undefined;});return this.running;
 }
}
