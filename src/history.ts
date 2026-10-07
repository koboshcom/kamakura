import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCredentials, redactCredentials } from './credentials.js';
export interface StoredMessage {
 role:'user'|'assistant';sender?:string;senderId?:string;id?:string;
 /** Authenticated transport provenance, volatile only. */
 credentialEligible?:boolean;text:string;at:number;
}
export class HistoryStore {
 private readonly path:string;private readonly archivePath:string;
 private data:Record<string,StoredMessage[]>={};private archive:Record<string,StoredMessage[]>={};
 constructor(dir:string,private readonly limit:number,private readonly archiveLimit=5000){
  mkdirSync(dir,{recursive:true,mode:0o700});this.path=join(dir,'history.json');this.archivePath=join(dir,'history-archive.json');
  this.data=this.load(this.path);this.archive=this.load(this.archivePath);
  for(const [chat,messages] of Object.entries(this.data))if(!this.archive[chat])this.archive[chat]=messages.map(m=>({...m}));
  this.persist();
 }
 private load(path:string):Record<string,StoredMessage[]>{
  try{const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,StoredMessage[]>;for(const messages of Object.values(data))for(const item of messages){captureCredentials(item.text);item.text=redactCredentials(item.text);item.credentialEligible=false;}return data;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {};}
 }
 get(key:string):StoredMessage[]{return (this.data[key]??[]).map(m=>({...m}));}
 add(key:string,message:StoredMessage):void{
  captureCredentials(message.text);this.data[key]=[...(this.data[key]??[]),{...message}].slice(-this.limit);
  this.archive[key]=[...(this.archive[key]??[]),{...message,credentialEligible:false,text:redactCredentials(message.text)}].slice(-this.archiveLimit);this.persist();
 }
 search(key:string,owner:string,query:string,limit=8):StoredMessage[]{
  const words=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);if(!words.length)return [];
  const dm=key===`telegram:${owner}`;
  return (this.archive[key]??[]).filter(m=>(m.senderId===owner||(dm&&!m.senderId))&&words.every(word=>m.text.toLocaleLowerCase().includes(word))).slice(-Math.min(20,Math.max(1,limit))).reverse().map(m=>({...m,credentialEligible:false,text:redactCredentials(m.text).slice(0,2000)}));
 }
 private persist():void{for(const [path,data] of [[this.path,this.data],[this.archivePath,this.archive]] as const){const tmp=`${path}.${process.pid}.tmp`;const persisted=Object.fromEntries(Object.entries(data).map(([chat,messages])=>[chat,messages.map(m=>({...m,credentialEligible:false,text:redactCredentials(m.text)}))]));writeFileSync(tmp,JSON.stringify(persisted),{mode:0o600});renameSync(tmp,path);}}
}
