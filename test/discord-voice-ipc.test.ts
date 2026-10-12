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
async function fixture(backend?: (prompt:string,signal:AbortSignal)=>Promise<string>){
 const parent=await mkdtemp(join(tmpdir(),'voice-offline-')),directory=join(parent,'ipc');
 const cfg=voiceConfig({DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_USER_TOKEN:'fake-discord',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',DISCORD_VOICE_BACKEND_BASE_URL:'https://backend.example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'offline-backend',DISCORD_VOICE_BACKEND_MODEL:'backend-model',OPENAI_LIVE_API_KEY:'fake-model',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'1'}),DISCORD_VOICE_IPC_DIR:directory});
 let env:NodeJS.ProcessEnv={},creates=0,kills=0;
 const child=new EventEmitter() as ChildProcess;child.exitCode=null;child.kill=()=>{kills++;child.exitCode=0;child.emit('exit',0);return true;};
 const providers:Array<{events:EventEmitter;socket:EventEmitter;sent:unknown[]}>=[];
 const makeLive=()=>{
  const events=new EventEmitter(),socket=new EventEmitter(),sent:unknown[]=[];Object.assign(socket,{platformSocket:{bufferedAmount:0}});
  providers.push({events,socket,sent});
  return Object.assign(events,{socket,send:(e:unknown)=>{sent.push(e);},close:()=>{}}) as unknown as LiveWS;
 };
 const stop=await startDiscordVoice(cfg,{instructions:'offline test',spawnChild:(_p,_a,options:SpawnOptions)=>{env=options.env??{};return child;},connect:()=>{creates++;return makeLive();},backend:backend??(async()=> 'offline')});
 const peer=connect(env.DISCORD_VOICE_IPC_PATH!);await once(peer,'connect');peer.on('error',()=>{});
 const identity={call:'a'.repeat(32),user,channel,self,owner:'1'};
 const send=(msg:unknown)=>peer.write(JSON.stringify(msg)+'\n');
 const hello=async()=>{
  const data=once(peer,'data');send({type:'hello',token:env.DISCORD_VOICE_IPC_TOKEN,self});await data;
 };
 const closed=()=>once(peer,'close');
 const cleanup=async()=>{peer.destroy();await stop();await rm(parent,{recursive:true,force:true});};
 return {parent,directory,cfg,env,stop,peer,identity,send,hello,closed,cleanup,providers,counts:()=>({creates,kills})};
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
  f.providers[0]!.socket.emit('open');f.providers[0]!.events.emit('event',{type:'session.started'});
  const close=f.closed();f.send({...f.identity,call:'b'.repeat(32),type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});await close;
 }finally{await f.cleanup();}
});
test('pre-existing directory is refused without mutation',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'voice-path-test-')),directory=join(parent,'ipc');await mkdir(directory,{mode:0o700});
 const cfg={...voiceConfig({}),enabled:true,directory,baseUrl:'https://live.test/v1',apiKey:'live',model:'live',backendBaseUrl:'https://backend.test/v1',backendApiKey:'backend',backendModel:'backend'};
 try{await assert.rejects(startDiscordVoice(cfg,{instructions:'offline'}),{code:'EEXIST'});assert.ok((await lstat(directory)).isDirectory());}finally{await rm(parent,{recursive:true,force:true});}
});

function inbox(peer:Socket){
 const queued:Array<Record<string,unknown>>=[],pending:Array<(e:Record<string,unknown>)=>void>=[];let buffer='';
 peer.on('data',chunk=>{buffer+=chunk.toString();for(;;){const at=buffer.indexOf('\n');if(at<0)break;const msg=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);const resolve=pending.shift();if(resolve)resolve(msg);else queued.push(msg);}});
 return async(type:string):Promise<Record<string,unknown>>=>{
  for(;;){const msg=queued.shift()??await new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('IPC timeout '+type)),1500);pending.push(e=>{clearTimeout(timer);resolve(e);});});if(msg.type===type)return msg;}
 };
}
async function startCall(f:Awaited<ReturnType<typeof fixture>>,call:string,read:ReturnType<typeof inbox>){
 const identity={...f.identity,call};f.send({...identity,type:'begin'});
 // A local round-trip ensures the begin was consumed before injecting provider events.
 f.send({...identity,call:'e'.repeat(32),type:'begin'});await read('declined');
 const provider=f.providers.at(-1)!;provider.socket.emit('open');provider.events.emit('event',{type:'session.started'});await read('ready');return {identity,provider};
}
test('two sequential calls reuse authenticated Unix peer with clean finalization and no context/audio/sequence leakage',async()=>{
 const prompts:string[]=[];const f=await fixture(async p=>{prompts.push(p);return 'answer';});const read=inbox(f.peer);
 try{
  await f.hello();
  const first=await startCall(f,'a'.repeat(32),read);
  first.provider.events.emit('event',{type:'session.input_transcript.delta',event_id:'same-event-id',delta:'FIRST-CALL-SECRET',start_ms:0,end_ms:1});
  first.provider.events.emit('event',{type:'session.delegation.created',offset_ms:1,delegation:{id:'same-delegation-id',target:'client'}});
  await new Promise(r=>setImmediate(r));
  first.provider.events.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(1920,1).toString('base64')});
  f.send({...first.identity,type:'end'});first.provider.events.emit('event',{type:'session.closed'});
  f.send({...first.identity,type:'clean',ok:true});
  assert.equal((await read('complete')).finalized,true);
  const second=await startCall(f,'b'.repeat(32),read);
  assert.equal(f.counts().creates,2);assert.notEqual(first.provider,second.provider);
  // Old callbacks may still fire, but cannot write into the new identity/session.
  first.provider.events.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(960,1).toString('base64')});
  f.send({...second.identity,type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});
  second.provider.events.emit('event',{type:'session.input_transcript.delta',event_id:'same-event-id',delta:'SECOND-CALL-REQUEST',start_ms:0,end_ms:1});
  second.provider.events.emit('event',{type:'session.delegation.created',offset_ms:1,delegation:{id:'same-delegation-id',target:'client'}});
  await new Promise(r=>setImmediate(r));
  assert.equal(prompts.length,2);assert.match(prompts[1]!,/SECOND-CALL-REQUEST/);assert.doesNotMatch(prompts[1]!,/FIRST-CALL-SECRET/);
  second.provider.events.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(960,2).toString('base64')});
  const audio=await read('audio');assert.equal(audio.call,second.identity.call);assert.equal(audio.pcm,Buffer.alloc(960,2).toString('base64'));
  f.send({...second.identity,type:'end'});f.send({...second.identity,type:'clean',ok:true});second.provider.events.emit('event',{type:'session.closed'});assert.equal((await read('complete')).finalized,true);
  f.send({...first.identity,type:'begin'});assert.equal((await read('declined')).reason,'busy_or_reused_id');assert.equal(f.counts().creates,2);
 }finally{await f.cleanup();}
 await assert.rejects(lstat(f.directory),{code:'ENOENT'});
});
test('overlap is declined without opening a second provider; finalized without clean still cannot reuse',async()=>{
 const f=await fixture(),read=inbox(f.peer);try{
  await f.hello();const first=await startCall(f,'a'.repeat(32),read);
  f.send({...f.identity,call:'b'.repeat(32),type:'begin'});assert.equal((await read('declined')).reason,'busy_or_reused_id');assert.equal(f.counts().creates,1);
  first.provider.events.emit('event',{type:'session.closed'});
  f.send({...f.identity,call:'c'.repeat(32),type:'begin'});await read('declined');assert.equal(f.counts().creates,1);
  f.send({...first.identity,type:'clean',ok:true});assert.equal((await read('complete')).finalized,true);
 }finally{await f.cleanup();}
});
test('uncertain provider close permanently blocks another paid session on same authenticated peer',async()=>{
 const f=await fixture(),read=inbox(f.peer);try{
  await f.hello();const first=await startCall(f,'a'.repeat(32),read);
  first.provider.events.emit('close');f.send({...first.identity,type:'clean',ok:true});assert.equal((await read('complete')).finalized,false);
  // A late finalization event cannot unlock an earlier uncertain close.
  first.provider.events.emit('event',{type:'session.closed'});
  f.send({...f.identity,call:'b'.repeat(32),type:'begin'});assert.equal((await read('declined')).reason,'provider_finalization_unknown');assert.equal(f.counts().creates,1);
 }finally{await f.cleanup();}
});

test('backend that has not acknowledged cancellation blocks reuse even after provider finalization',async()=>{
 let release:(s:string)=>void=()=>{},signal:AbortSignal|undefined;
 const f=await fixture(async(_p,s)=>{signal=s;return new Promise<string>(resolve=>{release=resolve;});}),read=inbox(f.peer);
 try{
  await f.hello();const first=await startCall(f,'a'.repeat(32),read);
  first.provider.events.emit('event',{type:'session.input_transcript.delta',event_id:'id',delta:'request',start_ms:0,end_ms:1});
  first.provider.events.emit('event',{type:'session.delegation.created',offset_ms:1,delegation:{id:'id',target:'client'}});
  first.provider.events.emit('event',{type:'session.closed'});assert.equal(signal?.aborted,true);
  f.send({...first.identity,type:'clean',ok:true});assert.equal((await read('complete')).finalized,false);
  release('late secret');await new Promise(r=>setImmediate(r));
  f.send({...f.identity,call:'b'.repeat(32),type:'begin'});await read('declined');assert.equal(f.counts().creates,1);
  assert.equal(first.provider.sent.some(e=>(e as {type:string}).type==='session.commentary.append'),false);
 }finally{release('cleanup');await f.cleanup();}
});
test('approved voice base fits startup budget without replacing the text persona',async()=>{
 const f=await fixture();try{
  const {readFile}=await import('node:fs/promises');
  const index=await readFile(new URL('../src/index.ts',import.meta.url),'utf8');
  assert.match(index,/instructions:'You are Kama, a sleepy shrine cat\./);
  const before=await readFile(new URL('../persona.md',import.meta.url),'utf8');
  await f.hello();
  f.send({type:'ready',self,username:'offline.cat'});await new Promise(r=>setTimeout(r,10));
  assert.equal(f.counts().creates,0);assert.equal(f.peer.destroyed,false);
  assert.equal(await readFile(new URL('../persona.md',import.meta.url),'utf8'),before);
 }finally{await f.cleanup();}
});

test('sidecar diagnostics retain only fixed stage names and numeric counters, never content or credentials',async()=>{
 const {safeVoiceDiagnostic}=await import('../src/discord-voice-service.js');
 assert.deepEqual(safeVoiceDiagnostic({stage:'call_counters',counters:{rtp_packets:7,pcm_queued:3,token:'SECRET',audio:'RAW',transcript:'WORDS',speech_frames:-1},errorType:'SECRET',token:'SECRET'}),{stage:'call_counters',counters:{rtp_packets:7,pcm_queued:3},errorType:'other'});
 assert.equal(safeVoiceDiagnostic({stage:'SECRET',counters:{rtp_packets:1}}),undefined);
});

 test('stderr emits only allowlisted exception classes and never traceback values',async()=>{
 const {safeVoiceStderrCode}=await import('../src/discord-voice-service.js');
 assert.equal(safeVoiceStderrCode('AttributeError: PRIVATE TOKEN AND CONTENT'),'AttributeError');
 assert.equal(safeVoiceStderrCode('discord.errors.ClientException: PRIVATE'),'ClientException');
 assert.equal(safeVoiceStderrCode('TOKEN SECRET private audio'),undefined);
 assert.equal(safeVoiceStderrCode('  File "/private/path", line 1'),undefined);
 });


test('voice diagnostic stack excludes free-form messages and payloads',async()=>{
 const {safeVoiceDiagnostic}=await import('../src/discord-voice-service.js');
 const result=safeVoiceDiagnostic({stage:'discord_connect',attempt:'0123456789abcdef',errorType:'ValueError',reason:'token=PRIVATE',stack:[{file:'https://secret@host/token',line:228,exception:'ValueError',locals:{key:'SECRET'}}],payload:'PRIVATE'});
 assert.deepEqual(result,{stage:'discord_connect',counters:{},errorType:'ValueError',attempt:'0123456789abcdef',stack:[{file:'redacted',line:228,exception:'ValueError'}]});
});

test('voice event entry retains only authorized diagnostic fields',async()=>{
 const {safeVoiceDiagnostic}=await import('../src/discord-voice-service.js');
 assert.deepEqual(safeVoiceDiagnostic({stage:'accept_entry',callerDiscordId:'811641072526688317',gate:'allowlist_miss',counters:{voice_clients:1},token:'SECRET'}),{stage:'accept_entry',counters:{voice_clients:1},errorType:'other',callerDiscordId:'811641072526688317',gate:'allowlist_miss'});
});

test('handshake trace accepts fixed stages and booleans only',async()=>{
 const {safeVoiceDiagnostic}=await import('../src/discord-voice-service.js');
 assert.deepEqual(safeVoiceDiagnostic({stage:'handshake_trace',attempt:'0123456789abcdef',eventId:'fedcba9876543210',step:'ready',status:'start',counters:{aes_offered:1,xchacha_offered:1,endpoint:'private',secret_key:'SECRET'},payload:{token:'SECRET'}}),{stage:'handshake_trace',counters:{aes_offered:1,xchacha_offered:1},errorType:'other',eventId:'fedcba9876543210',step:'ready',status:'start',attempt:'0123456789abcdef'});
});
