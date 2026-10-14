import {bindLocalDM} from '../local-dm-context.js';
import {sttConfig} from '../voice-note.js';
import {createServer,type Server,type Socket} from 'node:net';
import {mkdir,chmod,unlink,rmdir,lstat} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {config} from '../config.js';
import {snowflake,type DiscordConfig} from '../discord-config.js';
import {downloadAttachment} from '../attachment-download.js';
import {outgoingText} from '../outgoing-text.js';
import {bindDiscordDM} from '../discord-dm-context.js';
import {MongoDiscordClaims,type DiscordClaims} from '../discord-claims.js';
import {logger} from '../logger.js';
import type {IncomingMessage,MediaInput,Transport} from '../types.js';
export class DiscordSelfTransport implements Transport {
 readonly name='discord' as const;
 private server?:Server;private peer?:Socket;private authenticated=false;private stopped=true;private generation=0;
 private token=randomBytes(32).toString('hex');private directory=(process.env.DISCORD_VOICE_IPC_DIR??'/tmp/kamakura-discord-voice')+'-text';
 private self=process.env.DISCORD_VOICE_SELF_ID??'';private callback?:(message:IncomingMessage)=>void;
 private destinations=new Map<string,{account:string;owner:string;channel:string}>();
 private accepted=new Map<string,number>();private pending=new Map<string,{resolve:()=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>();private queue=Promise.resolve();private queued=0;private abort=new AbortController();
 constructor(private cfg:DiscordConfig,private download=downloadAttachment,private claims:DiscordClaims=new MongoDiscordClaims()){}
 sidecarEnv():NodeJS.ProcessEnv{return {DISCORD_SELF_DM_ENABLED:'true',DISCORD_TEXT_IPC_PATH:join(this.directory,'text.sock'),DISCORD_TEXT_IPC_TOKEN:this.token};}
 async start(callback:(message:IncomingMessage)=>void){
  if(!this.cfg.enabled)return;if(!this.stopped||!this.cfg.self||!snowflake(this.self))throw new Error('Invalid DM startup');
  await mkdir(this.directory,{mode:0o700});const st=await lstat(this.directory);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw new Error('Unsafe text IPC directory');
  this.stopped=false;this.generation++;this.callback=callback;this.abort=new AbortController();
  this.server=createServer(socket=>{
   if(this.peer||this.stopped){socket.destroy();return;}this.peer=socket;let buffer=Buffer.alloc(0);const timer=setTimeout(()=>socket.destroy(),3000);
   socket.on('error',()=>socket.destroy());socket.on('close',()=>{clearTimeout(timer);this.authenticated=false;this.generation++;this.peer=undefined;this.destinations.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject();}this.pending.clear();});
   socket.on('data',chunk=>{
    try{
     buffer=Buffer.concat([buffer,chunk]);if(buffer.length>65536)throw new Error('IPC bound');
     let i:number;while((i=buffer.indexOf(10))>=0){const line=buffer.subarray(0,i);buffer=buffer.subarray(i+1);if(line.length>49152)throw new Error('IPC bound');
      const m=JSON.parse(line.toString());
      if(!this.authenticated){if(m.type!=='hello'||m.self!==this.self||typeof m.token!=='string'||m.token.length!==64||!timingSafeEqual(Buffer.from(m.token),Buffer.from(this.token)))throw new Error('IPC auth');this.authenticated=true;clearTimeout(timer);this.write({type:'hello'});continue;}
      if(m.type==='ready'){if(m.self!==this.self)throw new Error('Identity');logger.info({event:'discord_text_ready'},'Discord self DM listener ready');continue;}
      if(m.type==='result'){const p=this.pending.get(m.request);if(p){clearTimeout(p.timer);this.pending.delete(m.request);if(m.ok===true)p.resolve();else p.reject();}continue;}
      if(m.type!=='message'||this.queued>=32)throw new Error('IPC type/budget');
      const generation=this.generation;this.queued++;this.queue=this.queue.then(()=>this.receive(m,generation)).catch(()=>logger.warn('Discord DM unavailable')).finally(()=>this.queued--);
     }
    }catch{socket.destroy();}
   });
  });
  await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(join(this.directory,'text.sock'),resolve);});await chmod(join(this.directory,'text.sock'),0o600);
 }
 private write(m:unknown){if(!this.authenticated||!this.peer||this.peer.destroyed||this.peer.writableLength>65536)throw new Error('Text IPC unavailable');this.peer.write(JSON.stringify(m)+'\n');}
 async receive(m:Record<string,unknown>,generation=this.generation){
  const current=()=>!this.stopped&&this.authenticated&&this.generation===generation;
  if(!current()||!snowflake(m.account)||m.account===this.self||!snowflake(m.channel)||!snowflake(m.id)||m.self!==this.self||typeof m.text!=='string'||m.text.length>8000||typeof m.at!=='number'||!Number.isFinite(m.at)||Date.now()-m.at>this.cfg.maxAgeMs||m.at>Date.now()+30000||m.dm!==true||m.recipient!==m.account||m.guild!==false||m.group!==false||m.bot!==false||m.webhook!==false||m.system!==false)return;
  const owner=this.cfg.owners.get(m.account);if(!owner||m.owner!==owner||!config.sandbox.allowed.has(owner))return;
  const account=m.account,channel=m.channel,id=m.id;const active=()=>current()&&this.cfg.owners.get(account)===owner&&config.sandbox.allowed.has(owner);
  if(!await this.claims.claim(channel,id)||!active())return;
  const media:MediaInput[]=[];let suffix='';const attachments=Array.isArray(m.attachments)?m.attachments:[];
  if(!m.text&&!attachments.length)return;
  if(attachments.length>4)suffix+=' [Only the first four attachments can be inspected.]';
  for(const raw of attachments.slice(0,4)){
   try{
    const a=raw as {url?:unknown;mime?:unknown;size?:unknown};
    if(typeof a.url!=='string'||typeof a.mime!=='string'||typeof a.size!=='number'||!Number.isSafeInteger(a.size)||a.size<0||a.size>config.maxMediaBytes)throw new Error('Attachment');
    const kind=a.mime.startsWith('image/')?'image':a.mime.startsWith('video/')?'video':a.mime.startsWith('audio/')&&sttConfig().enabled?'audio':undefined;if(!kind)throw new Error('Attachment type');
    const data=await this.download(a.url,'discord',config.maxMediaBytes,AbortSignal.any([this.abort.signal,AbortSignal.timeout(config.mediaTimeoutMs)]));
    if(!active())return;media.push({kind,mime:a.mime,data});
   }catch{suffix+=' [Attachment unavailable or unsupported. Do not pretend to have seen it.]';}
  }
  if(!active())return;
  const chat='dm:'+account,old=this.destinations.get(chat);if(old&&old.channel!==channel)return;
  this.destinations.set(chat,{account,owner,channel});
  for(const [k,t]of this.accepted)if(t<=Date.now())this.accepted.delete(k);
  if(this.accepted.size>=4096)return;this.accepted.set(chat+':'+id,Date.now()+300000);
  const direct=!!m.text&&!attachments.length&&m.reference===false&&m.embeds===false&&!/^\s*>/m.test(m.text);
  const message:IncomingMessage={transport:'discord',chatId:chat,id,sender:owner,senderId:owner,authenticatedOwner:true,authenticatedAccountId:account,isGroup:false,addressed:true,text:(m.text||'[media attachment]')+suffix,media,timestamp:m.at,learningEligible:direct,credentialEligible:direct};
  bindDiscordDM(message,account,owner,active);
  if(direct&&m.snapshots===false)bindLocalDM(message,active,async text=>{if(!active())throw new Error("DM unavailable");await this.send(chat,text);});
  this.callback?.(message);
 }
 preflight(chat:string,kind:'send'|'react'|'voice',id?:string){
  const d=this.destinations.get(chat);if(this.stopped||!this.authenticated||!d||this.cfg.owners.get(d.account)!==d.owner||!config.sandbox.allowed.has(d.owner))throw new Error('DM destination unavailable');
  if(kind==='voice')throw new Error('DM voice notes unsupported');
  if((kind==='react'||id)&&(!id||(this.accepted.get(chat+':'+id)??0)<=Date.now()))throw new Error('DM target unavailable');
 }
 private async command(chat:string,type:string,data:Record<string,unknown>){
  const d=this.destinations.get(chat)!;const request=randomBytes(16).toString('hex');
  await new Promise<void>((resolve,reject)=>{
   const fail=()=>reject(new Error('Discord delivery unconfirmed, do not retry'));
   const timer=setTimeout(()=>{this.pending.delete(request);fail();},15000);this.pending.set(request,{resolve,reject:fail,timer});
   try{this.write({type,request,self:this.self,...d,...data});}catch{clearTimeout(timer);this.pending.delete(request);fail();}
  });
 }
 async send(chat:string,text:string,options?:{replyTo?:string}){
  text=outgoingText(text);if(!text)return;if(text.length>2000)throw new Error('Discord text exceeds 2000 characters');this.preflight(chat,'send',options?.replyTo);await this.command(chat,'send',{text,...(options?.replyTo?{replyTo:options.replyTo}:{})});
 }
 async react(message:IncomingMessage,emoji:string){if(message.transport!=='discord'||emoji.length>16)throw new Error('Reaction unavailable');this.preflight(message.chatId,'react',message.id);await this.command(message.chatId,'react',{id:message.id,emoji});}
 async stop(){
  this.stopped=true;this.generation++;this.abort.abort();this.peer?.destroy();await this.queue;this.destinations.clear();this.accepted.clear();
  if(this.server){await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await unlink(join(this.directory,'text.sock')).catch(()=>{});await rmdir(this.directory).catch(()=>{});}
 }
}
