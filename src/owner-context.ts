import {config} from './config.js';
import type {IncomingMessage} from './types.js';
/** Identity comes from the authenticated adapter, never a phone hint in text. */
export function contextOwner(message:IncomingMessage):string|undefined {
 const owner=message.senderId;
 if(!owner||message.isGroup||!config.sandbox.allowed.has(owner))return;
 if(message.transport==='telegram'&&message.chatId===owner&&config.telegramAllowed.has(owner))return owner;
 if((message.transport==='whatsapp'||message.transport==='web')&&message.authenticatedOwner===true)return owner;
}
export function ownerFactKey(message:IncomingMessage):string|undefined {const owner=contextOwner(message);return owner?'owner:'+message.transport+':'+message.chatId+':'+owner:undefined;}
