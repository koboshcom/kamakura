import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,lstat,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter,once} from 'node:events';
import {connect,type Socket} from 'node:net';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import type {LiveWS} from 'openai/resources/live/ws';
import {voiceConfig} from '../src/discord-voice-config.js';
import {startDiscordVoice} from '../src/discord-voice-service.js';
const self='222222222222222222',user='111111111111111111',channel='333333333333333333';
async function fixture(){
 const parent=await mkdtemp(join(tmpdir(),'voice-offline-')),directory=join(parent,'ipc');
 const cfg=voiceConfig({DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_USER_TOKEN:'fake-discord',OPENAI_LIVE_API_KEY:'fake-model',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'1'}),DISCORD_VOICE_IPC_DIR:directory});
 let env:NodeJS.ProcessEnv={},creates=0,kills=0;
 const child=new EventEmitter() as ChildProcess;child.exitCode=null;child.kill=()=>{kills++;child.exitCode=0;child.emit('exit',0);return true;};
 const events=new EventEmitter(),socket=new EventEmitter();Object.assign(socket,{platformSocket:{bufferedAmount:0}});
 const live=Object.assign(events,{socket,send:()=>{},close:()=>{}}) as unknown as LiveWS;
 const stop=await startDiscordVoice(cfg,{instructions:'offline test',spawnChild:(_p,_a,options:SpawnOptions)=>{env=options.env??{};return child;},connect:()=>{creates++;return live;},backend:async()=> 'offline'});
 const peer=connect(env.DISCORD_VOICE_IPC_PATH!);await once(peer,'connect');peer.on('error',()=>{});
 const identity={call:'a'.repeat(32),user,channel,self,owner:'1'};
 const send=(msg:unknown)=>peer.write(JSON.stringify(msg)+'\n');
 const hello=async()=>{
  const data=once(peer,'data');send({type:'hello',token:env.DISCORD_VOICE_IPC_TOKEN,self});await data;
 };
 const closed=()=>once(peer,'close');
 const cleanup=async()=>{peer.destroy();await stop();await rm(parent,{recursive:true,force:true});};
 return {parent,directory,cfg,env,stop,peer,identity,send,hello,closed,cleanup,socket,events,counts:()=>({creates,kills})};
}
test('OFF creates neither Unix listener nor Python child',async()=>{
 let touched=false;
 const stop=await startDiscordVoice(voiceConfig({}),{spawnChild:()=>{touched=true;throw new Error('must not spawn');},connect:()=>{touched=true;throw new Error('must not connect');}});
 await stop();assert.equal(touched,false);
});
test('private Unix endpoint, sanitized Python environment and child cleanup',async()=>{
 const f=await fixture();try{
  assert.equal((await lstat(f.directory)).mode&0o777,0o700);
  assert.equal((await lstat(f.env.DISCORD_VOICE_IPC_PATH!)).mode&0o777,0o600);
  assert.equal(f.env.DISCORD_VOICE_USER_TOKEN,'fake-discord');assert.equal(f.env.OPENAI_API_KEY,undefined);assert.equal(f.env.OPENAI_LIVE_API_KEY,undefined);assert.equal(f.env.TELEGRAM_BOT_TOKEN,undefined);
  await f.hello();assert.equal(f.counts().creates,0);
 }finally{await f.cleanup();}
 assert.ok(f.counts().kills>=1);
});
test('bad peer secret rejects before any provider connection',async()=>{
 const f=await fixture();try{const close=f.closed();f.send({type:'hello',token:'0'.repeat(64),self});await close;assert.equal(f.counts().creates,0);}finally{await f.cleanup();}
});
test('canonical mapping and self checks precede provider connection',async()=>{
 for(const patch of [{owner:'2'},{self:user},{user:'444444444444444444'},{channel:'bad'}]){
  const f=await fixture();try{await f.hello();const close=f.closed();f.send({...f.identity,...patch,type:'begin'});await close;assert.equal(f.counts().creates,0);}finally{await f.cleanup();}
 }
});
test('valid authenticated identity opens only injected offline Live; changed call id ends',async()=>{
 const f=await fixture();try{
  await f.hello();f.send({...f.identity,type:'begin'});
  await new Promise(r=>setTimeout(r,30));assert.equal(f.counts().creates,1);
  f.socket.emit('open');f.events.emit('event',{type:'session.started'});
  const close=f.closed();f.send({...f.identity,call:'b'.repeat(32),type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});await close;
 }finally{await f.cleanup();}
});
test('pre-existing directory is refused without mutation',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'voice-path-test-')),directory=join(parent,'ipc');await mkdir(directory,{mode:0o700});
 const cfg={...voiceConfig({}),enabled:true,directory};
 try{await assert.rejects(startDiscordVoice(cfg,{instructions:'offline'}),{code:'EEXIST'});assert.ok((await lstat(directory)).isDirectory());}finally{await rm(parent,{recursive:true,force:true});}
});
