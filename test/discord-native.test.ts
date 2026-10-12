import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {voiceConfig} from '../src/discord-voice-config.js';
import {discordConfig} from '../src/discord-config.js';
import {config} from '../src/config.js';
import {contextOwner,ownerFactKey} from '../src/owner-context.js';
import {canWork} from '../src/work-tools.js';
import {VoiceBridge} from '../src/discord-voice-bridge.js';
import {SandboxManager,sandboxOptions} from '../src/sandbox.js';
import {ownerId} from '../src/owner-id.js';
import {internalVoiceOwner} from '../src/voice-owner-context.js';
import {workerTool} from '../src/worker.js';
import {learningScope,ownerEvidence} from '../src/learning.js';
import {summaryScope} from '../src/context-budget.js';
import type {IncomingMessage} from '../src/types.js';
const user='111111111111111111',self='222222222222222222',foreign='444444444444444444',owner='discord-'+user,other='discord-'+foreign;
const env={DISCORD_ENABLED:'false',DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_USER_TOKEN:'fixture-only',DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:owner}),SANDBOX_ALLOWED_USERS:owner,OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'fixture',OPENAI_LIVE_API_KEY:'fixture',DISCORD_VOICE_BACKEND_BASE_URL:'https://fixture.invalid/v1',DISCORD_VOICE_BACKEND_MODEL:'fixture',DISCORD_VOICE_BACKEND_API_KEY:'fixture',DISCORD_VOICE_CONTEXT_ENABLED:'true',DISCORD_VOICE_MAIN_AGENT_ENABLED:'true',DISCORD_VOICE_TRANSCRIPT_ENABLED:'true',DISCORD_VOICE_MAIN_CHATS:JSON.stringify({[owner]:'voice:'+owner})};
test('calls-only native namespace is explicit, path-safe, and cannot be a fabricated Telegram owner',()=>{
 assert(ownerId(owner));assert(!ownerId('discord-1/../2'));assert(!ownerId('discord-18446744073709551616'));
 assert.equal(discordConfig(env).enabled,false);assert.equal(voiceConfig(env).bridge!.chats.get(owner),'voice:'+owner);
 for(const patch of [{DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:other})},{DISCORD_VOICE_MAIN_CHATS:JSON.stringify({[owner]:'telegram:'+owner}),TELEGRAM_ALLOWED_CHATS:owner},{DISCORD_VOICE_MAIN_CHATS:JSON.stringify({[owner]:'voice:'+other})},{DISCORD_VOICE_MAIN_CHATS:JSON.stringify({[owner]:'discord:dm'})}])assert.throws(()=>voiceConfig({...env,...patch}));
 const legacy=voiceConfig({...env,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'7853500388'}),SANDBOX_ALLOWED_USERS:'7853500388',TELEGRAM_ALLOWED_CHATS:'7853500388',DISCORD_VOICE_MAIN_CHATS:JSON.stringify({'7853500388':'telegram:7853500388'})});
 assert.equal(legacy.bridge!.chats.get('7853500388'),'telegram:7853500388');
});
test('private internal history/context/tools and call-only reply, no cross-owner reads or serialized capability',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'voice-native-'));const previous=config.discord;config.discord=discordConfig(env);config.sandbox.allowed.add(owner);config.sandbox.allowed.add(other);
 const writes:any[]=[];const reads:string[]=[];let request:IncomingMessage|undefined;let active=true;
 try{
  const history:any={ownerRecent:async(m:IncomingMessage)=>{assert.equal(contextOwner(m),owner);assert.equal(m.chatId,'voice:'+owner);reads.push(m.chatId);return [];},add:async(k:string,m:any)=>writes.push({k,m})};
  const facts:any={read:async(k:string)=>{assert.equal(k,'discord:voice:'+owner);return [];},readUser:async(m:IncomingMessage)=>{assert.equal(ownerFactKey(m),'owner:'+owner);return [];}};
  const run:any=async(_:any,m:IncomingMessage,_m:any,_a:any,conversation:any)=>{
   request=m;assert(canWork(m,id=>id===owner));assert.equal(internalVoiceOwner(m),owner);
   assert.equal(learningScope(m),JSON.stringify(['owner',owner]));
   assert.equal(ownerEvidence(m,new Set([owner])),undefined);
   assert.deepEqual(Object.keys(workerTool(m)),[]);
   assert.notEqual(summaryScope('chat','discord:voice:'+owner,owner),summaryScope('chat','telegram:7853500388','7853500388'));
   for(const forged of [{...m},{...m,senderId:other},{...m,chatId:'voice:'+other},{...m,transport:'telegram' as const,chatId:owner},{...m,isGroup:true}]){assert(!contextOwner(forged));assert(!canWork(forged,()=>true));}
   assert.equal(conversation.delivery.voice,undefined);await assert.rejects(conversation.delivery.react(m,'👍'));
   await conversation.delivery.send('test result');
  };
  const cfg=voiceConfig(env);const bridge=new VoiceBridge(cfg,history,facts,join(dir,'history'),run);
  for(const identity of [{call:'b'.repeat(32),user:foreign,owner},{call:'b'.repeat(32),user,owner:other},{call:'b'.repeat(32),user,owner:'7853500388'}])assert.throws(()=>bridge.hooks(identity,()=>active));
  assert.equal(reads.length,0);
  const hooks=bridge.hooks({call:'a'.repeat(32),user,owner},()=>active);
  const digest=await hooks.context!();assert.match(digest,/"recent":\[\]/);assert.match(digest,/"facts":\[\]/);
  const fragment={id:'f',role:'user' as const,text:'find something',start:1,end:2};
  assert.equal(await hooks.delegate!([fragment],'d',2,new AbortController().signal),'test result');
  hooks.capture!(fragment);bridge.end('a'.repeat(32));await bridge.recover();await bridge.recover();
  assert.equal(writes.length,1);assert.equal(writes[0].k,'discord:voice:'+owner);assert.equal(writes[0].m.senderId,owner);assert.equal(reads.length,2);
  active=false;assert(!contextOwner(request!));assert(!canWork(request!,()=>true));await assert.rejects(hooks.context!());assert.throws(()=>hooks.capture!(fragment));
  assert.equal(writes.length,1);
 }finally{config.discord=previous;config.sandbox.allowed.delete(owner);config.sandbox.allowed.delete(other);await rm(dir,{recursive:true,force:true});}
});
test('sandbox provisioning and container labels use separate native namespace',()=>{
 const manager=new SandboxManager({...config.sandbox,allowed:new Set([owner])});assert(manager.authorized(owner));assert(!manager.authorized(user));assert(!manager.authorized('7853500388'));
 const options=sandboxOptions(owner,config.sandbox,'/workspaces/'+owner,'f'.repeat(64));assert.equal(options.Labels!['kamakura.owner'],owner);assert.equal(options.HostConfig!.Mounts![0]!.Source,'/workspaces/'+owner);
 const workspace=readFileSync(new URL('../src/workspace.ts',import.meta.url),'utf8');assert.match(workspace,/ownerId\(userId\)/);
 const provision=readFileSync(new URL('../deploy/provision-sandbox-volumes.py',import.meta.url),'utf8');assert.match(provision,/discord-/);
});
