import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DiscordSelfTransport} from '../src/transports/discord-self.js';
import {discordConfig} from '../src/discord-config.js';
import {bindDiscordDM,copyDiscordDM,discordDMOwner,isDiscordVoiceDM} from '../src/discord-dm-context.js';
import {contextOwner,ownerFactKey} from '../src/owner-context.js';
import {config} from '../src/config.js';
import {VoiceBridge} from '../src/discord-voice-bridge.js';
import {voiceConfig} from '../src/discord-voice-config.js';
import {BackgroundJobs} from '../src/jobs.js';
const a='111111111111111111',b='222222222222222222',self='333333333333333333',owner='91',other='92',channel='444444444444444444';
const env={DISCORD_ENABLED:'false',DISCORD_SELF_DM_ENABLED:'true',DISCORD_VOICE_ENABLED:'true',DISCORD_ALLOWED_USERS:a+','+b,DISCORD_OWNER_IDS:JSON.stringify({[a]:owner,[b]:other}),DISCORD_VOICE_OWNER_IDS:JSON.stringify({[a]:owner,[b]:other}),SANDBOX_ALLOWED_USERS:owner+','+other};
test('self config rejects bot mode and mismatched owners, no bot token needed',()=>{
 const cfg=discordConfig(env);assert.equal(cfg.self,true);assert.equal(cfg.token,'');assert.equal(cfg.owners.get(a),owner);
 for(const patch of [{DISCORD_ENABLED:'true'},{DISCORD_VOICE_ENABLED:'false'},{DISCORD_VOICE_OWNER_IDS:'{}'},{DISCORD_OWNER_IDS:JSON.stringify({[a]:other,[b]:owner})}])assert.throws(()=>discordConfig({...env,...patch}));
});
test('private DM capability cannot be forged/cloned or cross-routed; worker completion stays private',async()=>{
 config.sandbox.allowed.add(owner);let active=true;
 const msg:any={transport:'discord',chatId:'dm:'+a,senderId:owner,authenticatedOwner:true,authenticatedAccountId:a,isGroup:false,id:'555555555555555555',text:'do it',timestamp:Date.now(),sender:'owner'};
 try{
 bindDiscordDM(msg,a,owner,()=>active);assert.equal(contextOwner(msg),owner);assert.equal(ownerFactKey(msg),'owner:'+owner);
 assert.equal(discordDMOwner({...msg}),undefined);
 const clone=copyDiscordDM(msg,{...msg});assert.equal(discordDMOwner(clone),owner);
 assert.throws(()=>copyDiscordDM(msg,{...msg,chatId:'dm:'+b}));
 const sent:string[]=[];const jobs=new BackgroundJobs(async job=>{assert.equal(discordDMOwner(job.incoming),owner);await job.sendMessage!('explicit');return 'private final prose';},async(_job,text)=>{sent.push(text)},m=>!!discordDMOwner(m));
 jobs.start(msg,'task');await jobs.drain();assert.deepEqual(sent,['explicit']);
 active=false;assert.equal(discordDMOwner(clone),undefined);assert.equal(contextOwner(msg),undefined);
 }finally{config.sandbox.allowed.delete(owner);}
});
test('authenticated Unix adapter, duplicates, owner denial, attachments, ACK/error/replies and disconnect revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'discord-text-test-'));const ipc=join(dir,'voice');
 process.env.DISCORD_VOICE_IPC_DIR=ipc;process.env.DISCORD_VOICE_SELF_ID=self;config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);
 const seen:any[]=[];const claimed=new Set<string>();let downloads=0;
 const transport=new DiscordSelfTransport(discordConfig(env),async(_url,platform,_max,signal)=>{assert.equal(platform,'discord');assert.equal(signal.aborted,false);downloads++;return Buffer.from('fixture');},{claim:async(c,id)=>{const k=c+id;if(claimed.has(k))return false;claimed.add(k);return true}});
 let peer:ReturnType<typeof connect>|undefined;const commands:any[]=[];
 try{
 await transport.start(m=>seen.push(m));const e=transport.sidecarEnv();
 peer=connect(e.DISCORD_TEXT_IPC_PATH!);await new Promise<void>(r=>peer!.once('connect',r));
 let buf='';peer.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\n'))>=0){const row=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(row.type==='send'||row.type==='react'){commands.push(row);peer!.write(JSON.stringify({type:'result',request:row.request,ok:row.text!=='error'})+'\n');}}});
 const write=(m:any)=>peer!.write(JSON.stringify(m)+'\n');
 write({type:'hello',self,token:e.DISCORD_TEXT_IPC_TOKEN});await delay(15);
 const incoming:any={type:'message',self,account:a,owner,channel,id:'555555555555555555',text:'hello',at:Date.now(),recipient:a,dm:true,guild:false,group:false,bot:false,webhook:false,system:false,reference:false,embeds:false,attachments:[]};
 write({...incoming,owner:other});write({...incoming,group:true});write({...incoming,account:self});await delay(15);assert.equal(seen.length,0);
 write(incoming);write(incoming);await delay(30);assert.equal(seen.length,1);assert.equal(discordDMOwner(seen[0]),owner);assert.equal(commands.length,0,'no auto-send');
 write({...incoming,id:'555555555555555556',text:'video',attachments:[{url:'https://cdn.discordapp.com/attachments/1/2/a.mp4',mime:'video/mp4',size:6}]});await delay(30);
 assert.equal(downloads,1);assert.equal(seen[1].media[0].kind,'video');assert.equal(seen[1].credentialEligible,false);
 await transport.send('dm:'+a,'first');await transport.send('dm:'+a,'second',{replyTo:incoming.id});await transport.react(seen[0],'⭐');
 assert.equal(commands.length,3);assert.ok(commands.every(c=>c.account===a&&c.owner===owner&&c.channel===channel));
 await assert.rejects(transport.send('dm:'+b,'foreign'));await assert.rejects(transport.send('dm:'+a,'quote',{replyTo:'999999999999999999'}));await assert.rejects(transport.send('dm:'+a,'error'),/unconfirmed/);
 peer.destroy();await delay(20);assert.equal(discordDMOwner(seen[0]),undefined);await assert.rejects(transport.send('dm:'+a,'late'));
 }finally{peer?.destroy();await transport.stop();config.sandbox.allowed.delete(owner);config.sandbox.allowed.delete(other);delete process.env.DISCORD_VOICE_IPC_DIR;delete process.env.DISCORD_VOICE_SELF_ID;rmSync(dir,{recursive:true,force:true});}
});
test('voice uses own Discord history and call-only capability, legacy destination preserved',async()=>{
 config.sandbox.allowed.add(owner);const old={self:config.discord.self,enabled:config.discord.enabled,owners:config.discord.owners};
 config.discord.self=true;config.discord.enabled=true;config.discord.owners=new Map([[a,owner]]);
 const dir=mkdtempSync(join(tmpdir(),'discord-dm-voice-'));
 try{
 const cfg=voiceConfig({...env,DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_USER_TOKEN:'fixture',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',OPENAI_LIVE_API_KEY:'fixture',DISCORD_VOICE_BACKEND_BASE_URL:'https://example.test/v1',DISCORD_VOICE_BACKEND_MODEL:'fixture',DISCORD_VOICE_BACKEND_API_KEY:'fixture',DISCORD_VOICE_ALLOWED_USERS:a+','+b,DISCORD_VOICE_CONTEXT_ENABLED:'true',DISCORD_VOICE_MAIN_AGENT_ENABLED:'true',DISCORD_VOICE_TRANSCRIPT_ENABLED:'true',DISCORD_VOICE_MAIN_CHATS:JSON.stringify({[owner]:'discord:dm:'+a,[other]:'discord:dm:'+b})});
 const written:any[]=[];
 const history:any={ownerRecent:async(m:any)=>{assert.equal(m.chatId,'dm:'+a);assert.equal(contextOwner(m),owner);assert.equal(isDiscordVoiceDM(m),true);return [{role:'user',text:'own DM only',at:1}];},add:async(key:any,m:any)=>written.push({key,m})};
 const facts:any={read:async(k:string)=>{assert.equal(k,'discord:dm:'+a);return [];},readUser:async(m:any)=>{assert.equal(ownerFactKey(m),'owner:'+owner);return ['shared owner fact'];}};
 const run:any=async(_r:any,m:any,_media:any,_announce:any,c:any)=>{assert.equal(isDiscordVoiceDM(m),true);await c.delivery.send('spoken only');return 'unused private prose';};
 const bridge=new VoiceBridge(cfg,history,facts,dir,run),call='a'.repeat(32),hooks=bridge.hooks({call,user:a,owner},()=>true);
 assert.match(await hooks.context!(),/own DM only/);assert.throws(()=>bridge.hooks({call:'b'.repeat(32),user:b,owner},()=>true));
 const fragment={id:'1',role:'user' as const,text:'do something',start:1,end:2};assert.equal(await hooks.delegate!([fragment],'d1',2,new AbortController().signal),'spoken only');
 hooks.capture!(fragment);bridge.end(call);await bridge.recover();assert.equal(written[0].key,'discord:dm:'+a);
 }finally{Object.assign(config.discord,old);config.sandbox.allowed.delete(owner);rmSync(dir,{recursive:true,force:true});}
});
