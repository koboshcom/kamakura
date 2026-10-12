import type {IncomingMessage} from './types.js';
import {snowflake} from './discord-config.js';
const scopes=new WeakMap<IncomingMessage,{account:string;owner:string;current:()=>boolean;voice:boolean}>();
/** Adapter capability, never restored from JSON or model-supplied identity. */
export function bindDiscordDM(message:IncomingMessage,account:string,owner:string,current:()=>boolean,voice=false){
 if(!snowflake(account)||message.transport!=='discord'||message.isGroup||message.chatId!=='dm:'+account||message.senderId!==owner||message.authenticatedAccountId!==account||message.authenticatedOwner!==true||!current())throw new Error('Invalid DM scope');
 scopes.set(message,{account,owner,current,voice});
}
export function discordDMOwner(message:IncomingMessage){
 const s=scopes.get(message);
 return s?.current()&&message.transport==='discord'&&!message.isGroup&&message.chatId==='dm:'+s.account&&message.senderId===s.owner&&message.authenticatedAccountId===s.account&&message.authenticatedOwner===true?s.owner:undefined;
}
/** Only trusted in-process batching carries a capability to an identity-preserving clone. */
export function copyDiscordDM(source:IncomingMessage,copy:IncomingMessage):IncomingMessage{
 const s=scopes.get(source);
 if(s&&discordDMOwner(source))bindDiscordDM(copy,s.account,s.owner,s.current,s.voice);
 return copy;
}

export function isDiscordVoiceDM(message:IncomingMessage){return !!discordDMOwner(message)&&scopes.get(message)?.voice===true;}
