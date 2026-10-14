import type {IncomingMessage} from './types.js';
import type {LocalDevices,ApprovalNotice} from './local-devices.js';
import {consumeLocalCommand,localDMScope} from './local-dm-context.js';
import {outgoingText} from './outgoing-text.js';
import {config} from './config.js';

export class LocalDMControl {
 private routes=new Map<string,{owner:string;chat:string;transport:string;account?:string;current:()=>boolean;expires:number;scope:object}>();
 private prune(){for(const [id,r] of this.routes)if(r.expires<=Date.now()||!r.current())this.routes.delete(id);}
 approvalContext(message:IncomingMessage){
  const s=localDMScope(message);if(!s)throw new Error('Private owner DM required');
  const scope={};
  return {message,scope,dm:{owner:s.owner,transport:s.transport,chat:s.chat,account:s.account},current:()=>!!localDMScope(message),notify:async(owner:string,n:ApprovalNotice)=>{
   this.prune();if(owner!==s.owner||!localDMScope(message)||this.routes.size>=4096)throw new Error('Approval unavailable');
   this.routes.set(n.approvalId,{owner,chat:s.chat,transport:s.transport,account:s.account,current:()=>!!localDMScope(message),expires:Date.now()+60000,scope});
   // Exact bytes must fit one message. Never split or truncate approvals.
   const text=['Local device action approval','Device '+n.deviceId,'Action '+n.action,n.preview,'Request '+n.digest,'Approve only if this exact action is yours.','/approve '+n.approvalId,'/deny '+n.approvalId].join('\n');
   if(outgoingText(text)!==text||Buffer.byteLength(text)>1900){this.routes.delete(n.approvalId);throw new Error('Approval too long');}
   try{await s.send(text);}catch{this.routes.delete(n.approvalId);throw new Error('Approval delivery failed');}
  }};
 }
 async handle(message:IncomingMessage,devices:LocalDevices|undefined):Promise<boolean>{
  if(!['telegram','discord','whatsapp'].includes(message.transport))return false;
  const command=/^\/(pair|devices|revoke|approve|deny)(?:\s+(.*))?$/i.exec(message.text.trim());
  if(!command)return false;
  const s=consumeLocalCommand(message);if(!s)return true;
  if(!devices){await s.send('Local devices are not enabled.');return true;}
  const kind=command[1]!.toLowerCase(),arg=command[2]?.trim()??'';
  try{
   if(kind==='pair'){
    if(arg)throw new Error('No arguments');
    const pair=await devices.issuePairCode(s.owner);
    if(!localDMScope(message))throw new Error('Session changed');
    await s.send(['One-time local device pairing code',pair.code,'Expires '+new Date(pair.expiresAt).toISOString(),'Run kamakura-cli auth on your own computer. Never share this code.',...(config.localDevices.publicUrl?['KAMAKURA_SERVER='+config.localDevices.publicUrl]:[])].join('\n'));
   }else if(kind==='devices'){
    if(arg)throw new Error('No arguments');
    const list=await devices.list(s.owner);
    if(!localDMScope(message))throw new Error('Session changed');
    const text=list.length?list.map(d=>[d.deviceId,d.name,d.connected?'connected':'offline',d.paused?'paused':'ready'].join(' ')).join('\n'):'No paired local devices.';
    await s.send(text.length>1800?text.slice(0,1800).split('\n').slice(0,-1).join('\n')+'\nMore devices omitted.':text);
   }else{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(arg))throw new Error('Invalid ID');
    if(kind==='revoke'){
     await devices.revoke(s.owner,arg);await s.send('Device revoked. Active connections and pending actions are stopped.');
    }else{
     this.prune();const route=this.routes.get(arg);
     const valid=route&&route.owner===s.owner&&route.chat===s.chat&&route.transport===s.transport&&route.account===s.account&&route.current()&&localDMScope(message);
     const accepted=!!valid&&await devices.approve(s.owner,arg,kind==='approve',route.scope);
     if(valid)this.routes.delete(arg);
     await s.send(accepted?'Recorded for this action only.':'Unavailable, expired or unauthorized.');
    }
   }
  }catch{if(localDMScope(message))await s.send('Local device command unavailable.');}
  return true;
 }
}
export const localDMControl=new LocalDMControl();
