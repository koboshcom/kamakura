import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {voiceConfig} from '../src/discord-voice-config.js';
import {VoiceBridge} from '../src/discord-voice-bridge.js';
import {config} from '../src/config.js';
import type {HistoryStore} from '../src/history.js';
import type {FactsStore} from '../src/facts.js';
const owner='1',user='111111111111111111';
const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'test',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',OPENAI_LIVE_API_KEY:'test',DISCORD_VOICE_BACKEND_BASE_URL:'https://example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'test',DISCORD_VOICE_BACKEND_MODEL:'test',SANDBOX_ALLOWED_USERS:owner,DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:owner}),TELEGRAM_ALLOWED_CHATS:owner};
test('bridge flags default off, private destination explicit and owner scoped',()=>{
 assert.equal(voiceConfig(env).bridge?.delegate,false);
 for(const patch of [{DISCORD_VOICE_CONTEXT_ENABLED:'true'},{DISCORD_VOICE_MAIN_AGENT_ENABLED:'maybe'},{DISCORD_VOICE_TRANSCRIPT_ENABLED:'true',DISCORD_VOICE_MAIN_CHATS:'{"1":"telegram:2"}'},{DISCORD_VOICE_CONTEXT_BYTES:'99999'}])assert.throws(()=>voiceConfig({...env,...patch}));
});
test('owner context, real main delegation, cancellation and durable partial transcript recovery',async()=>{
 config.telegramAllowed.add(owner);config.sandbox.allowed.add(owner);
 const dir=mkdtempSync(join(tmpdir(),'voice-bridge-'));
 const cfg=voiceConfig({...env,DISCORD_VOICE_CONTEXT_ENABLED:'true',DISCORD_VOICE_MAIN_AGENT_ENABLED:'true',DISCORD_VOICE_TRANSCRIPT_ENABLED:'true',DISCORD_VOICE_MAIN_CHATS:'{"1":"telegram:1"}'});
 const written:any[]=[];const calls:any[]=[];
 const history={ownerRecent:async(message:any)=>{assert.equal(message.chatId,owner);return [{role:'user',text:'recent owner message',at:1}];},add:async(key:any,message:any)=>{written.push({key,message});}} as unknown as HistoryStore;
 const facts={read:async(key:string)=>{assert.equal(key,'telegram:1');return ['shared'];},readUser:async(message:any)=>{assert.equal(message.senderId,owner);return ['personal'];}} as unknown as FactsStore;
 const run:typeof import('../src/brain.js').think=async(_recent,message,_media,_announce,conversation)=>{calls.push(message);assert.equal(message.credentialEligible,false);await conversation!.delivery.send('real main reply');return '';};
 try{
  const bridge=new VoiceBridge(cfg,history,facts,dir,run);let current=true;
  const hooks=bridge.hooks({call:'a'.repeat(32),user,owner},()=>current);
  assert.match(await hooks.context!(),/recent owner message/);
  assert.throws(()=>bridge.hooks({call:'b'.repeat(32),user,owner:'2'},()=>true));
  const fragment={id:'fragment1',role:'user' as const,text:'search something',start:1,end:2};
  hooks.capture!(fragment);hooks.capture!(fragment);
  await bridge.recover();assert.equal(written.length,0,'no embedding/export midcall');
  assert.equal(await hooks.delegate!([fragment],'delegation1',2,new AbortController().signal),'real main reply');
  assert.match(await hooks.delegate!([fragment],'delegation2',2,new AbortController().signal),/repeat/);assert.equal(calls.length,1,'old spoken request not re-executed');
  current=false;
  await assert.rejects(hooks.delegate!([{...fragment,end:3}],'delegation3',3,new AbortController().signal));
  const recovered=new VoiceBridge(cfg,history,facts,dir,run);await recovered.recover();await recovered.recover();
  assert.equal(written.length,1);assert.equal(written[0].key,'telegram:1');assert.equal(written[0].message.voiceCall,'a'.repeat(32));assert.match(written[0].message.voiceCoverage,/no final transcript/);
  assert.equal(JSON.parse(readFileSync(join(dir,'voice-transcripts/history-pending.json'),'utf8')).length,0);
 }finally{config.telegramAllowed.delete(owner);config.sandbox.allowed.delete(owner);rmSync(dir,{recursive:true,force:true});}
});
