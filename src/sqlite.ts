import Database from 'better-sqlite3';
import {mkdirSync,lstatSync,existsSync,openSync,closeSync,constants,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import './env.js';

export function storageBackend():'mongo'|'sqlite' {
 const value=process.env.STORAGE??'mongo';
 if(value!=='mongo'&&value!=='sqlite')throw new Error('STORAGE must be mongo or sqlite');
 return value;
}
let db:Database.Database|undefined,lock:Database.Database|undefined,root:string|undefined;
const tables=['history','facts','lessons','reminders','counters','context_summaries','discord_claims','local_device_pairs','local_devices','local_device_audit'] as const;
export type SqliteTable=typeof tables[number];
function privateFile(path:string) {
 if(existsSync(path)){
  const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1)throw new Error('Unsafe SQLite file');
 }else{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);closeSync(fd);}
 chmodSync(path,0o600);
}
export function sqlite():Database.Database {
 const dir=join(resolve(process.env.DATA_DIR??'./data'),'storage-sqlite');
 if(db){if(root!==dir)throw new Error('SQLite DATA_DIR changed while open');return db;}
 const parent=resolve(process.env.DATA_DIR??'./data');
 if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('Unsafe SQLite DATA_DIR');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const s=lstatSync(dir);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('Unsafe SQLite directory');
 chmodSync(dir,0o700);
 const file=join(dir,'store.sqlite'),lockfile=join(dir,'owner.sqlite');
 for(const path of [file,file+'-wal',file+'-shm',lockfile,lockfile+'-journal'])if(existsSync(path))privateFile(path);
 privateFile(lockfile);privateFile(file);
 try{
  // Native SQLite locking survives PID namespaces and releases on process death.
  // Never unlink a lock file, steal a stale lock, or run two writers.
  lock=new Database(lockfile,{timeout:0});lock.pragma('locking_mode = EXCLUSIVE');lock.exec('BEGIN EXCLUSIVE');
  db=new Database(file,{timeout:5000});root=dir;
  const version=db.pragma('user_version',{simple:true});
  const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  if(version!==0&&version!==1)throw new Error('Unsupported SQLite schema version');
  if(version===0&&existing.length)throw new Error('Unversioned SQLite schema');
  db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('synchronous = FULL');db.pragma('trusted_schema = OFF');
  if(version===0)db.transaction(()=>{
   for(const name of tables)db!.exec(`CREATE TABLE ${name} (key TEXT PRIMARY KEY, ns TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), revision INTEGER NOT NULL DEFAULT 0) STRICT; CREATE INDEX ${name}_namespace ON ${name}(ns)`);
   db!.pragma('user_version = 1');
  }).immediate();
  const actual=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
  if(JSON.stringify(actual.map(r=>r.name))!==JSON.stringify([...tables].sort()))throw new Error('Incompatible SQLite schema');
  for(const name of tables){
   const cols=db.prepare(`PRAGMA table_info(${name})`).all() as {name:string;type:string}[];
   if(JSON.stringify(cols.map(c=>[c.name,c.type]))!==JSON.stringify([['key','TEXT'],['ns','TEXT'],['payload','TEXT'],['revision','INTEGER']]))throw new Error('Incompatible SQLite schema');
  }
  const check=db.pragma('quick_check',{simple:true});if(check!=='ok')throw new Error('Corrupt SQLite storage');
  for(const suffix of ['','-wal','-shm'])if(existsSync(file+suffix))privateFile(file+suffix);
  return db;
 }catch(error){closeSqlite();throw error;}
}
export function closeSqlite(){db?.close();db=undefined;root=undefined;lock?.close();lock=undefined;}
export function json(value:unknown):string {const text=JSON.stringify(value);if(text===undefined||Buffer.byteLength(text)>16*1024*1024)throw new Error('Invalid or oversized storage record');return text;}
/** Private parameter-bound primitives used only by domain repositories, not a Mongo query interpreter. */
export function row<T>(table:SqliteTable,key:string):T|null {
 const value=sqlite().prepare(`SELECT payload FROM ${table} WHERE key=?`).get(key) as {payload:string}|undefined;
 return value?JSON.parse(value.payload) as T:null;
}
export function rows<T>(table:SqliteTable,ns:string):T[] {
 return (sqlite().prepare(`SELECT payload FROM ${table} WHERE ns=? ORDER BY key`).all(ns) as {payload:string}[]).map(r=>JSON.parse(r.payload) as T);
}
export function insert(table:SqliteTable,key:string,ns:string,value:unknown):boolean {
 return sqlite().prepare(`INSERT INTO ${table}(key,ns,payload) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING`).run(key,ns,json(value)).changes===1;
}
export function put(table:SqliteTable,key:string,ns:string,value:unknown):void {
 sqlite().prepare(`INSERT INTO ${table}(key,ns,payload) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,revision=${table}.revision+1`).run(key,ns,json(value));
}
export function atomic<T>(run:()=>T):T{return sqlite().transaction(run).immediate();}
export function remove(table:SqliteTable,key:string):void {sqlite().prepare(`DELETE FROM ${table} WHERE key=?`).run(key);}
process.once('exit',closeSqlite);
