import {spawn,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {createServer,type Socket} from 'node:net';
import {chmod,lstat,mkdir,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createVoiceLive} from './discord-voice-provider.js';
import type {LiveWS} from 'openai/resources/live/ws';
import {generateText} from 'ai';
import {isolatedProvider} from './model-provider.js';
import {personaPrompt} from './persona.js';
import {voiceConfig,validateVoiceProviders,voiceBackendSettings,type VoiceConfig} from './discord-voice-config.js';
import {VoiceLines} from './discord-voice-protocol.js';
import {VoiceSession,type Backend} from './discord-voice-session.js';
import {logger} from './logger.js';
import {snowflake} from './discord-config.js';
const secretMatches=(a:unknown,b:string)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Local supervisor only. No listener or subprocess exists when the flag is OFF. */
export interface VoiceDependencies {spawnChild?:(python:string,args:string[],opts:SpawnOptions)=>ChildProcess;connect?:(cfg:VoiceConfig)=>LiveWS;backend?:Backend;instructions?:string}
export async function startDiscordVoice(cfg:VoiceConfig=voiceConfig(),dependencies:VoiceDependencies={}):Promise<()=>Promise<void>>{
 if(!cfg.enabled)return async()=>{};
 validateVoiceProviders(cfg);
 const backendModel=isolatedProvider(voiceBackendSettings(cfg)).responses(cfg.backendModel);
 const instructions=(dependencies.instructions??personaPrompt())+'\nThis is a private voice conversation. Be brief. You have no tools or access to messages, files, memory, accounts, or external actions here. Do not claim otherwise.';
 if(Buffer.byteLength(instructions)>8000)throw new Error('Voice prompt exceeds budget');
 const token=randomBytes(32).toString('hex'),path=join(cfg.directory,'voice.sock');
 // Refuse pre-existing directories, symlinks and stale endpoints; never unlink arbitrary paths.
 await mkdir(cfg.directory,{mode:0o700});
 const st=await lstat(cfg.directory);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw new Error('Unsafe voice IPC directory');
 let child:ChildProcess|undefined,peer:Socket|undefined,session:VoiceSession|undefined,identity:Record<string,string>|undefined;
 let stopping=false,authenticated=false,unconfirmed=false,callDeadline:ReturnType<typeof setTimeout>|undefined;
 const server=createServer(socket=>{
  if(peer||stopping){socket.destroy();return;}peer=socket;
  const lines=new VoiceLines();const usedCalls=new Set<string>();let clean=false,finished=false,confirmed=false;
  const send=(event:Record<string,unknown>,key=identity)=>{
   if(socket.destroyed||socket.writableLength>16384)throw new Error('IPC unavailable');
   socket.write(JSON.stringify({...event,...key})+'\n');
  };
  const complete=()=>{
   if(!finished||!clean||!identity)return;
   clearTimeout(callDeadline);
   send({type:'complete',finalized:confirmed});
   session=undefined;identity=undefined;
  };
  const authTimer=setTimeout(()=>socket.destroy(),3000);
  socket.on('error',()=>socket.destroy());
  socket.on('close',()=>{clearTimeout(authTimer);clearTimeout(callDeadline);session?.disconnected();void close();});
  socket.on('data',chunk=>{
   try{for(const raw of lines.feed(chunk)){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('IPC object required');
    const msg=raw as Record<string,unknown>;
    if(!authenticated){
     if(msg.type!=='hello'||!secretMatches(msg.token,token)||msg.self!==cfg.selfId)throw new Error('IPC authentication rejected');
     authenticated=true;clearTimeout(authTimer);send({type:'hello'});continue;
    }
    if(msg.type==='begin'){
     if(!snowflake(msg.user)||!snowflake(msg.channel)||typeof msg.call!=='string'||!/^[a-f0-9]{32}$/.test(msg.call)||msg.self!==cfg.selfId||cfg.owners.get(msg.user)!==msg.owner)throw new Error('Unauthorized voice call');
     if(identity||session||unconfirmed||usedCalls.has(msg.call)||usedCalls.size>=4096){
      send({type:'declined',reason:unconfirmed?'provider_finalization_unknown':'busy_or_reused_id'},{call:msg.call,user:msg.user,channel:msg.channel,self:cfg.selfId,owner:msg.owner as string});continue;
     }
     usedCalls.add(msg.call);clean=false;finished=false;confirmed=false;identity={call:msg.call,user:msg.user,channel:msg.channel,self:cfg.selfId,owner:msg.owner as string};
     const key=identity;
     // Opening costs only happens after private peer + canonical identity checks.
     const live=dependencies.connect?dependencies.connect(cfg):createVoiceLive(cfg);
     const s=session=new VoiceSession(cfg,{send:e=>live.send(e),close:()=>live.close(),buffered:()=>live.socket.platformSocket.bufferedAmount},e=>{if(identity===key)send(e,key);},
      ()=>authenticated&&!stopping&&peer===socket&&cfg.owners.get(key.user!)===key.owner,
      dependencies.backend??(async(prompt,signal)=>(await generateText({model:backendModel,prompt,maxOutputTokens:128,maxRetries:0,abortSignal:signal})).text),
      instructions,
      ()=>{
       if(!s.finalized){unconfirmed=true;logger.warn({event:'discord_voice_finalization_unknown',observedSeconds:s.seconds},'Voice disconnected; provider billing finalization unconfirmed');}
       if(identity!==key)return;
       if(!s.backendClean){unconfirmed=true;logger.warn({event:'discord_voice_backend_cleanup_unknown'},'Voice backend cleanup unconfirmed; further paid calls blocked');}
       finished=true;confirmed=s.finalized&&!unconfirmed;session=undefined;complete();
      });
     live.socket.on('open',()=>s.start());live.on('event',e=>s.event(e));live.on('error',()=>s.stop());live.on('close',()=>s.disconnected());
     callDeadline=setTimeout(()=>s.stop(),cfg.durationMs);
    }else{
     if(!identity||Object.entries(identity).some(([k,v])=>msg[k]!==v))throw new Error('Voice identity changed');
     if(msg.type==='clean'){if(session?.state==='active'||session?.state==='starting')throw new Error('Premature cleanup');if(msg.ok!==true){unconfirmed=true;confirmed=false;}clean=true;complete();}
     else if(session)session.input(msg);
     else if(msg.type!=='end')throw new Error('Call already finished');
    }
   }}catch{session?.stop();socket.destroy();}
  });
 });
 server.on('error',()=>{void close();});
 async function close(){
  if(stopping)return;stopping=true;clearTimeout(callDeadline);session?.stop();peer?.destroy();child?.kill('SIGTERM');
  const c=child;if(c&&!c.killed)c.kill('SIGTERM');
  if(c){const kill=setTimeout(()=>{if(c.exitCode===null)c.kill('SIGKILL');},2500);kill.unref();c.once('exit',()=>clearTimeout(kill));}
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await unlink(path).catch(()=>{});await rmdir(cfg.directory).catch(()=>{});
 }
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});await chmod(path,0o600);
  // No model keys, general bot credentials, or operator environment reach Python.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:cfg.directory,PYTHONDONTWRITEBYTECODE:'1',DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_IPC_PATH:path,DISCORD_VOICE_IPC_TOKEN:token,DISCORD_VOICE_USER_TOKEN:cfg.token,DISCORD_VOICE_SELF_ID:cfg.selfId,DISCORD_VOICE_OWNER_IDS:JSON.stringify(Object.fromEntries(cfg.owners)),DISCORD_VOICE_ALLOWED_USERS:[...cfg.owners.keys()].join(','),SANDBOX_ALLOWED_USERS:[...new Set(cfg.owners.values())].join(','),DISCORD_VOICE_MAX_SECONDS:String(cfg.durationMs/1000)};
  child=(dependencies.spawnChild??((python,args,opts)=>spawn(python,args,opts)))(cfg.python,[fileURLToPath(new URL('../voice/discord_sidecar.py',import.meta.url))],{env,stdio:'ignore',shell:false});
  child.once('error',()=>{void close();});child.once('exit',()=>{void close();});
  const boot=setTimeout(()=>{if(!authenticated)void close();},30000);boot.unref();child.once('exit',()=>clearTimeout(boot));
  return close;
 }catch(error){await close();throw error;}
}
