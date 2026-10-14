import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ChannelType,Events} from 'discord.js';
import {config} from '../src/config.js';
import {DiscordTransport} from '../src/transports/discord.js';
import {registerDiscord,registerTelegram} from '../src/transport-registration.js';
import {discordConfig} from '../src/discord-config.js';
import {localDMOwner} from '../src/local-dm-context.js';
import {localDeviceTools} from '../src/local-device-tools.js';
const user='111111111111111111',owner='discord-'+user,channel='222222222222222222';
const env={TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_CHATS:'',WHATSAPP_ENABLED:'false',DISCORD_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic-not-a-real-token',DISCORD_ALLOWED_USERS:user,DISCORD_OWNER_IDS:JSON.stringify({[user]:owner}),SANDBOX_ALLOWED_USERS:owner};
test('Discord-only registration does not construct or require Telegram; native owner mapping unchanged',()=>{
 const map=new Map();registerTelegram(map,'');registerDiscord(map,env);assert.deepEqual([...map.keys()],['discord']);assert.equal(discordConfig(env).owners.get(user),owner);
});
test('actual native adapter grants CLI capability only to fresh unreferenced human DM in current gateway session',async()=>{
 const cfg=discordConfig(env),client:any=new EventEmitter();client.login=async()=>{};client.destroy=async()=>{};const seen:any[]=[],claimed=new Set<string>();config.sandbox.allowed.add(owner);
 const tr=new DiscordTransport(cfg,client,async()=>{throw new Error('no attachment downloads');},{claim:async(c,id)=>{const key=c+id;if(claimed.has(key))return false;claimed.add(key);return true;}});
 const dm:any={type:ChannelType.DM,recipientId:user,send:async()=>{}};
 let id=333333333333333333n;
 const receive=async(extra:any={})=>{await tr.receive({partial:false,guildId:null,system:false,webhookId:null,author:{id:user,bot:false},id:String(id++),channelId:channel,channel:dm,createdTimestamp:Date.now(),content:'/pair',attachments:new Map(),embeds:[],reference:null,messageSnapshots:new Map(),...extra} as any,m=>seen.push(m));};
 try{
 await tr.start(m=>seen.push(m));await receive();const clean=seen[0];assert.equal(localDMOwner(clean),owner);assert.equal(Object.keys(localDeviceTools(clean,{} as any,o=>o===owner)).length,4);
 for(const extra of [{reference:{}},{messageSnapshots:new Map([['x',{}]])},{messageSnapshots:undefined},{embeds:[{}]},{content:'> /pair'}]){await receive(extra);assert.equal(localDMOwner(seen.at(-1)),undefined);}
 for(const extra of [{author:{id:user,bot:true}},{guildId:'x'},{channel:{...dm,type:ChannelType.GroupDM}},{createdTimestamp:Date.now()-120001},{webhookId:'x'},{system:true}]){const count=seen.length;await receive(extra);assert.equal(seen.length,count);}
 client.emit(Events.ShardDisconnect);assert.equal(localDMOwner(clean),undefined);await receive();assert.equal(localDMOwner(seen.at(-1)),owner);
 cfg.owners.delete(user);assert.equal(localDMOwner(seen.at(-1)),undefined);
 }finally{await tr.stop();config.sandbox.allowed.delete(owner);}
});
