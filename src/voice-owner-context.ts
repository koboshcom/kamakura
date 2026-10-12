import type {IncomingMessage} from './types.js';
import {discordOwner} from './owner-id.js';
import {snowflake} from './discord-config.js';
/** Process-private authenticated call capability, never reconstructed from JSON or caller text. */
const scopes=new WeakMap<IncomingMessage,{owner:string;account:string;current:()=>boolean}>();
export function bindInternalVoice(message:IncomingMessage,account:string,owner:string,current:()=>boolean):void {
 if(!snowflake(account)||owner!==discordOwner(account)||message.transport!=='discord'||message.senderId!==owner||message.chatId!=='voice:'+owner||message.authenticatedAccountId!==account||message.isGroup||!current())throw new Error('Invalid internal voice owner');
 scopes.set(message,{owner,account,current});
}
export function internalVoiceOwner(message:IncomingMessage):string|undefined {
 const scope=scopes.get(message);
 return scope?.current()&&message.transport==='discord'&&!message.isGroup&&message.senderId===scope.owner&&message.authenticatedAccountId===scope.account&&message.authenticatedOwner===true&&message.chatId==='voice:'+scope.owner?scope.owner:undefined;
}
