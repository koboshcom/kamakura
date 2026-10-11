import {spawn,type ChildProcess} from 'node:child_process';
import {createServer,type Socket} from 'node:net';
import {chmod,lstat,mkdir,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import OpenAI from 'openai';
import {LiveWS} from 'openai/resources/live/ws';
import {generateText} from 'ai';
import {openai} from './model-provider.js';
import {personaPrompt} from './persona.js';
import {voiceConfig,type VoiceConfig} from './discord-voice-config.js';
import {VoiceLines} from './discord-voice-protocol.js';
import {VoiceSession} from './discord-voice-session.js';
import {logger} from './logger.js';
import {snowflake} from './discord-config.js';
const secretMatches=(a:unknown,b:string)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Local supervisor only. No listener or subprocess exists when the flag is OFF. */
export async function startDiscordVoice(cfg:VoiceConfig=voiceConfig()):Promise<()=>Promise<void>>{
 if(!cfg.enabled)return async()=>{};
 const token=randomBytes(32).toString('hex'),path=join(cfg.directory,'voice.sock');
 // Refuse pre-existing directories, symlinks and stale endpoints; never unlink arbitrary paths.
 await mkdir(cfg.directory,{mode:0o700});
 const st=await lstat(cfg.directory);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw new Error('Unsafe voice IPC directory');
 let child:ChildProcess|undefined,peer:Socket|undefined,session:VoiceSession|undefined,identity:Record<string,string>|undefined;
 let stopping=false,authenticated=false,unconfirmed=false,callDeadline:ReturnType<typeof setTimeout>|undefined;
 const server=createServer(socket=>{
  if(peer||stopping){socket.destroy();return;}peer=socket;
  const lines=new VoiceLines();let seenCall=false;
  const send=(event:Record<string,unknown>)=>{
   if(socket.destroyed||socket.writableLength>16384)throw new Error('IPC unavailable');
   socket.write(JSON.stringify({...event,...identity})+'\n');
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
     if(session||seenCall||unconfirmed||!snowflake(msg.user)||!snowflake(msg.channel)||typeof msg.call!=='string'||!/^[a-f0-9]{32}$/.test(msg.call)||msg.self!==cfg.selfId||cfg.owners.get(msg.user)!==msg.owner)throw new Error('Unauthorized voice call');
     seenCall=true;identity={call:msg.call,user:msg.user,channel:msg.channel,self:cfg.selfId,owner:msg.owner as string};
     const key=identity;
     // Opening costs only happens after private peer + canonical identity checks.
     const live=new LiveWS(new OpenAI({apiKey:cfg.apiKey,maxRetries:0}),{reconnect:null,maxQueueSize:16384,maxPayload:65536});
     const s=session=new VoiceSession(cfg,{send:e=>live.send(e),close:()=>live.close(),buffered:()=>live.socket.platformSocket.bufferedAmount},send,
      ()=>authenticated&&!stopping&&peer===socket&&cfg.owners.get(key.user!)===key.owner,
      async(prompt,signal)=>(await generateText({model:openai.responses(cfg.backendModel),prompt,maxOutputTokens:128,maxRetries:0,abortSignal:signal})).text,
      personaPrompt()+'\nThis is a private voice conversation. Be brief. You have no tools or access to messages, files, memory, accounts, or external actions here. Do not claim otherwise.',
      ()=>{
       if(!s.finalized){unconfirmed=true;logger.warn({event:'discord_voice_finalization_unknown',observedSeconds:s.seconds},'Voice disconnected; provider billing finalization unconfirmed');}
       session=undefined;identity=undefined;socket.destroy(); // one authenticated process per call, no automatic relogin
      });
     live.socket.on('open',()=>s.start());live.on('event',e=>s.event(e));live.on('error',()=>s.stop());live.on('close',()=>s.disconnected());
     callDeadline=setTimeout(()=>s.stop(),cfg.durationMs);
    }else{
     if(!session||!identity||Object.entries(identity).some(([k,v])=>msg[k]!==v))throw new Error('Voice identity changed');
     session.input(msg);
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
  child=spawn(cfg.python,[fileURLToPath(new URL('../voice/discord_sidecar.py',import.meta.url))],{env,stdio:'ignore',shell:false});
  child.once('error',()=>{void close();});child.once('exit',()=>{void close();});
  const boot=setTimeout(()=>{if(!authenticated)void close();},30000);boot.unref();child.once('exit',()=>clearTimeout(boot));
  return close;
 }catch(error){await close();throw error;}
}
