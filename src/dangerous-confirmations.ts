import {randomUUID,createHash} from 'node:crypto';
import {localDMScope,consumeLocalCommand} from './local-dm-context.js';
import {outgoingText} from './outgoing-text.js';
import {exactLocalActionPreview} from './local-devices.js';
import type {IncomingMessage} from './types.js';
type Pending={expires:number;owner:string;chat:string;transport:string;account?:string;current:()=>boolean;done:(error?:Error)=>void};
export class DangerousConfirmations {
 private pending=new Map<string,Pending>();
 constructor(private ttlMs=60000){}
 async require(message:IncomingMessage,action:string,args:unknown,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const s=localDMScope(message);if(!s)throw new Error('Dangerous actions require a direct owner DM');
  if(this.pending.size>=128)throw new Error('Too many confirmations');
  const serialized=JSON.stringify(args);
  const preview=exactLocalActionPreview('shell',args),id=randomUUID();
  const digest=createHash('sha256').update(JSON.stringify({owner:s.owner,transport:s.transport,chat:s.chat,action,args})).digest('hex');
  const text=['Dangerous sandbox action confirmation',action,preview,'Request '+digest,'/confirm '+id,'/cancel '+id].join('\n');
  if(outgoingText(text)!==text||Buffer.byteLength(text)>1900)throw new Error('Exact confirmation cannot fit one message');
  await new Promise<void>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>;
   const abort=()=>done(new Error('Confirmation aborted'));
   const done=(error?:Error)=>{if(!this.pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
   this.pending.set(id,{expires:Date.now()+this.ttlMs,owner:s.owner,chat:s.chat,transport:s.transport,account:s.account,current:()=>!!localDMScope(message),done});
   timer=setTimeout(()=>done(new Error('Confirmation expired')),this.ttlMs);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   Promise.resolve().then(()=>s.send(text)).catch(()=>done(new Error('Confirmation delivery failed')));
  });
  if(JSON.stringify(args)!==serialized)throw new Error('Action changed during confirmation');
  signal?.throwIfAborted();if(!localDMScope(message))throw new Error('Owner DM session changed');
 }
 close(){for(const p of [...this.pending.values()])p.done(new Error('Confirmation service closed'));}
 async handle(message:IncomingMessage):Promise<boolean>{
  const match=/^\/(confirm|cancel)\s+([a-f0-9-]{36})$/i.exec(message.text.trim());if(!match)return false;
  const s=consumeLocalCommand(message);if(!s)return true;const p=this.pending.get(match[2]!);
  const valid=p&&p.expires>Date.now()&&p.owner===s.owner&&p.chat===s.chat&&p.transport===s.transport&&p.account===s.account&&p.current();
  if(valid)p.done(match[1]!.toLowerCase()==='confirm'?undefined:new Error('Owner denied'));
  await s.send(valid?'Recorded for this exact action only.':'Unavailable, expired or unauthorized.');return true;
 }
}
export const dangerousConfirmations=new DangerousConfirmations();
