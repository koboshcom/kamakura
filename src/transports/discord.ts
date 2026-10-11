import { Client, GatewayIntentBits, Partials, Events, ChannelType, type Message, type DMChannel } from 'discord.js';
import { discordConfig, snowflake, type DiscordConfig } from '../discord-config.js';
import { config } from '../config.js';
import { outgoingText } from '../outgoing-text.js';
import { downloadAttachment } from '../attachment-download.js';
import { TypingActivity } from '../typing.js';
import {collection,hash,namespace} from '../mongo.js';
import { logger } from '../logger.js';
import type { IncomingMessage, MediaInput, Transport } from '../types.js';

export interface DiscordClaims {claim(chat:string,id:string):Promise<boolean>}
export class MongoDiscordClaims implements DiscordClaims {
 private indexed?:Promise<unknown>;
 async claim(chat:string,id:string):Promise<boolean>{
  const coll=await collection<{_id:string;at:Date}>('discord_claims');
  await(this.indexed??=coll.createIndex({at:1},{expireAfterSeconds:600}));
  try{await coll.insertOne({_id:hash(namespace(config.dataDir)+':'+chat+':'+id),at:new Date()});return true;}
  catch(error){if((error as {code?:number}).code===11000)return false;throw error;}
 }
}
export class DiscordTransport implements Transport {
 readonly name='discord' as const;
 private stopped=true;
 private generation=0;
 private abort=new AbortController();
 private destinations=new Map<string,{user:string;owner:string;channel:DMChannel}>();
 private accepted=new Map<string,{message:Message;expires:number}>();
 private seen=new Map<string,number>();
 private pending=0;
 private queue=Promise.resolve();
 private readonly typing:TypingActivity;
 constructor(private cfg:DiscordConfig=discordConfig(),readonly client=new Client({intents:[GatewayIntentBits.DirectMessages],partials:[Partials.Channel],allowedMentions:{parse:[],repliedUser:false},rest:{retries:0,timeout:15000}}),private download=downloadAttachment,private claims:DiscordClaims=new MongoDiscordClaims()){
  this.typing=new TypingActivity(async(chat,signal)=>{signal.throwIfAborted();await this.destination(chat).sendTyping();});
 }
 async start(onMessage:(message:IncomingMessage)=>void):Promise<void>{
  if(!this.cfg.enabled)return;
  if(!this.stopped)throw new Error('Discord already started');
  this.stopped=false;this.generation++;this.abort=new AbortController();
  this.client.on(Events.Error,()=>logger.error('Discord connection unavailable'));
  this.client.on(Events.MessageCreate,message=>{
   if(this.stopped||this.pending>=32)return;
   const generation=this.generation;this.pending++;
   this.queue=this.queue.then(()=>this.receive(message,onMessage,generation)).catch(()=>logger.warn('Discord inbound unavailable')).finally(()=>{this.pending--;});
  });
  try{await this.client.login(this.cfg.token);}catch{await this.stop();throw new Error('Discord login unavailable');}
 }
 async receive(message:Message,onMessage:(message:IncomingMessage)=>void,generation=this.generation):Promise<void>{
  const current=()=>!this.stopped&&this.generation===generation;
  if(!current()||message.partial||message.guildId||message.channel.type!==ChannelType.DM||message.author.bot||message.webhookId||message.system||!snowflake(message.author.id)||!snowflake(message.id)||!snowflake(message.channelId))return;
  const owner=this.cfg.owners.get(message.author.id);
  if(!owner||!config.sandbox.allowed.has(owner)||message.channel.recipientId!==message.author.id)return;
  if(!Number.isFinite(message.createdTimestamp)||Date.now()-message.createdTimestamp>this.cfg.maxAgeMs||message.createdTimestamp>Date.now()+30000||message.content.length>8000)return;
  for(const [id,expires]of this.seen)if(expires<=Date.now())this.seen.delete(id);
  if(this.seen.has(message.id))return;
  // Fail closed rather than evicting dedup claims inside the accepted age window.
  if(this.seen.size>=4096)return;
  this.seen.set(message.id,Date.now()+this.cfg.maxAgeMs+30000);
  if(!await this.claims.claim(message.channelId,message.id)||!current()||this.cfg.owners.get(message.author.id)!==owner||!config.sandbox.allowed.has(owner))return;
  const media:MediaInput[]=[];let suffix='';
  const attachments=[...message.attachments.values()];
  if(!message.content&&!attachments.length)return;
  if(attachments.length>4)suffix=' [Only the first four images can be inspected.]';
  for(const attachment of attachments.slice(0,4)){
   try{
    if(attachment.size>config.maxMediaBytes||!attachment.contentType?.startsWith('image/'))throw new Error('Unsupported attachment');
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(config.mediaTimeoutMs)]);
    const data=await this.download(attachment.url,'discord',config.maxMediaBytes,signal);
    if(!current()||!this.cfg.owners.has(message.author.id)||!config.sandbox.allowed.has(owner))return;
    media.push({kind:'image',mime:attachment.contentType,data});
   }catch{suffix+=' [Attachment unavailable or unsupported. Do not pretend to have seen it.]';}
  }
  if(!current()||this.cfg.owners.get(message.author.id)!==owner||!config.sandbox.allowed.has(owner))return;
  this.destinations.set(message.channelId,{user:message.author.id,owner,channel:message.channel as DMChannel});
  for(const [key,entry]of this.accepted)if(entry.expires<=Date.now())this.accepted.delete(key);
  this.accepted.set(message.channelId+':'+message.id,{message,expires:Date.now()+300000});
  while(this.accepted.size>256)this.accepted.delete(this.accepted.keys().next().value!);
  const direct=Boolean(message.content&&!attachments.length&&!message.reference&&!message.embeds.length&&!/^\s*>/m.test(message.content));
  onMessage({transport:'discord',chatId:message.channelId,id:message.id,sender:owner,senderId:owner,authenticatedOwner:true,authenticatedAccountId:message.author.id,isGroup:false,addressed:true,text:(message.content||'[image attachment]')+suffix,media,timestamp:message.createdTimestamp,learningEligible:direct,credentialEligible:direct});
 }
 private destination(chat:string):DMChannel{
  const entry=this.destinations.get(chat),owner=entry&&this.cfg.owners.get(entry.user);
  if(this.stopped||!entry||!owner||owner!==entry.owner||!config.sandbox.allowed.has(owner)||entry.channel.type!==ChannelType.DM||entry.channel.recipientId!==entry.user)throw new Error('Discord destination unavailable');
  return entry.channel;
 }
 preflight(chat:string,kind:'send'|'react'|'voice',id?:string):void{
  this.destination(chat);
  if(kind==='voice')throw new Error('Discord voice disabled');
  if((kind==='react'||id)&&(!id||!this.accepted.has(chat+':'+id)||this.accepted.get(chat+':'+id)!.expires<=Date.now()))throw new Error('Discord message target unavailable');
 }
 async send(chat:string,text:string,options?:{replyTo?:string}):Promise<void>{
  text=outgoingText(text);if(!text)return;
  if(text.length>2000)throw new Error('Discord message exceeds 2000 characters');
  this.preflight(chat,'send',options?.replyTo);
  await this.destination(chat).send({content:text,allowedMentions:{parse:[],repliedUser:false},...(options?.replyTo?{reply:{messageReference:options.replyTo,failIfNotExists:true}}:{})});
 }
 async react(message:IncomingMessage,emoji:string):Promise<void>{
  if(message.transport!=='discord'||emoji.length>16)throw new Error('Discord reaction unavailable');
  this.preflight(message.chatId,'react',message.id);
  await this.accepted.get(message.chatId+':'+message.id)!.message.react(emoji);
 }
 startTyping(chat:string):()=>void{return this.typing.start(chat);}
 async stop():Promise<void>{
  this.stopped=true;this.generation++;this.abort.abort();this.typing.stop();
  this.client.removeAllListeners(Events.MessageCreate);await this.client.destroy();await this.queue;
  this.destinations.clear();this.accepted.clear();this.seen.clear();
 }
}
