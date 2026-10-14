import type {IncomingMessage} from './types.js';
import {config} from './config.js';
type Scope={owner:string;chat:string;transport:string;account?:string;current:()=>boolean;send:(text:string)=>Promise<void>;original:string;id:string;at:number};
const scopes=new WeakMap<IncomingMessage,Scope>();
const consumed=new WeakSet<Scope>();
// Only authenticated adapters mint capabilities. JSON identity flags grant nothing.
export function bindLocalDM(message:IncomingMessage,current:()=>boolean,send:(text:string)=>Promise<void>){
 if(!['discord','whatsapp'].includes(message.transport)||message.isGroup||!message.senderId||!message.authenticatedOwner||!current()||!config.sandbox.allowed.has(message.senderId))throw new Error('Invalid local DM');
 scopes.set(message,{owner:message.senderId,chat:message.chatId,transport:message.transport,account:message.authenticatedAccountId,current,send,original:message.text,id:message.id,at:message.timestamp});
}
export function localDMScope(message:IncomingMessage){
 const s=scopes.get(message);
 return s&&s.current()&&config.sandbox.allowed.has(s.owner)&&!message.isGroup&&message.senderId===s.owner&&message.chatId===s.chat&&message.transport===s.transport&&message.authenticatedAccountId===s.account&&message.authenticatedOwner===true?s:undefined;
}
export function localDMOwner(message:IncomingMessage){return localDMScope(message)?.owner;}
export function copyLocalDM(source:IncomingMessage,copy:IncomingMessage){
 const s=localDMScope(source);if(s){scopes.set(copy,s);if(!localDMScope(copy))scopes.delete(copy);}return copy;
}
export function removeLocalDM(message:IncomingMessage){scopes.delete(message);}
export function consumeLocalCommand(message:IncomingMessage){
 const s=localDMScope(message);
 if(!s||consumed.has(s)||message.id!==s.id||message.text!==s.original||!Number.isFinite(s.at)||Date.now()-s.at>120000||s.at>Date.now()+30000)return;
 consumed.add(s);return s;
}
