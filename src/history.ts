import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCredentials, redactCredentials } from './credentials.js';
export interface StoredMessage {
 role:'user'|'assistant';sender?:string;senderId?:string;id?:string;
 /** Historical credentials never retain transport authorization. */
 credentialEligible?:boolean;text:string;at:number;
}
export interface HistoryQuery {
 query?:string;limit?:number;order?:'earliest'|'latest';role?:'user'|'assistant'|'all';
 afterId?:string;beforeId?:string;from?:number;to?:number;exact?:boolean;
}
export class HistoryStore {
 private readonly path:string;private readonly archivePath:string;
 private data:Record<string,StoredMessage[]>={};private archive:Record<string,StoredMessage[]>={};
 constructor(dir:string,private readonly limit:number){
  mkdirSync(dir,{recursive:true,mode:0o700});this.path=join(dir,'history.json');this.archivePath=join(dir,'history-archive.json');
  this.data=this.load(this.path);this.archive=this.load(this.archivePath);
  for(const [chat,messages] of Object.entries(this.data)){
   const saved=this.archive[chat]??[];
   const identity=(m:StoredMessage)=>JSON.stringify([m.role,m.id,m.senderId,m.at,m.text]);
   const known=new Set(saved.map(identity));
   this.archive[chat]=[...saved,...messages.filter(m=>!known.has(identity(m)))];
  }
  this.persist();
 }
 private load(path:string):Record<string,StoredMessage[]>{
  try{const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,StoredMessage[]>;for(const messages of Object.values(data))for(const item of messages){captureCredentials(item.text);item.text=redactCredentials(item.text);item.credentialEligible=false;}return data;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {};}
 }
 get(key:string):StoredMessage[]{return (this.data[key]??[]).map(m=>({...m}));}
 add(key:string,message:StoredMessage):void{
  captureCredentials(message.text);const clean={...message,credentialEligible:false,text:redactCredentials(message.text)};
  this.data[key]=[...(this.data[key]??[]),clean].slice(-this.limit);
  this.archive[key]=[...(this.archive[key]??[]),clean];this.persist();
 }
 lookup(key:string,owner:string,options:HistoryQuery={}){
  const dm=key===`telegram:${owner}`;
  const scoped=(this.archive[key]??[]).map((message,index)=>({message,index})).filter(({message:m})=>m.senderId===owner||(dm&&!m.senderId));
  const ordered=scoped.sort((a,b)=>a.message.at-b.message.at||a.index-b.index).map(({message})=>message);
  const after=options.afterId?ordered.findIndex(m=>m.id===options.afterId):-1;
  const before=options.beforeId?ordered.findIndex(m=>m.id===options.beforeId):-1;
  const missingAnchor=Boolean((options.afterId&&after<0)||(options.beforeId&&before<0));
  const query=options.query??'';const words=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matched=missingAnchor?[]:ordered.filter((m,index)=>(!options.afterId||index>after)&&(!options.beforeId||index<before)
   &&(!options.role||options.role==='all'||m.role===options.role)
   &&(options.from===undefined||m.at>=options.from)&&(options.to===undefined||m.at<=options.to)
   &&(!query||(options.exact?m.text===query:words.every(word=>m.text.toLocaleLowerCase().includes(word)))));
  const limit=Math.min(20,Math.max(1,options.limit??8));
  const selected=options.order==='earliest'?matched.slice(0,limit):matched.slice(-limit).reverse();
  return {messages:selected.map(m=>({...m,credentialEligible:false,text:redactCredentials(m.text)})),matched:matched.length,missingAnchor,
   earliestAvailable:ordered[0]?.at??null,latestAvailable:ordered.at(-1)?.at??null,
   coverage:'Retained messages only. Legacy history used a recent-window cap, so older discarded messages may be unavailable. Earliest available is not proof of the first-ever message. Text is exact except credential redaction; never infer missing messages.'};
 }
 search(key:string,owner:string,query:string,limit=8):StoredMessage[]{return this.lookup(key,owner,{query,limit}).messages;}
 private persist():void{for(const [path,data] of [[this.path,this.data],[this.archivePath,this.archive]] as const){const tmp=`${path}.${process.pid}.tmp`;const persisted=Object.fromEntries(Object.entries(data).map(([chat,messages])=>[chat,messages.map(m=>({...m,credentialEligible:false,text:redactCredentials(m.text)}))]));writeFileSync(tmp,JSON.stringify(persisted),{mode:0o600});renameSync(tmp,path);}}
}
