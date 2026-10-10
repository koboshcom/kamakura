import {outgoingText} from './outgoing-text.js';
import {DeliveryPreflightError} from './delivery-preflight.js';
import type {IncomingMessage,Transport} from './types.js';
import type {ChatDelivery} from './chat-tools.js';
export function chatDelivery(transport:Transport,message:IncomingMessage,hooks:{current():boolean;deliveryStarted():void;pace(text:string):Promise<void>;delivered(text?:string):Promise<void>;voice?:{synthesize(text:string):Promise<Buffer>}}):ChatDelivery {
 const preflight=(kind:'send'|'react'|'voice',id?:string)=>{try{if(!hooks.current())throw new Error('Turn superseded');transport.preflight?.(message.chatId,kind,id);}catch(error){throw new DeliveryPreflightError(error);}};
 return {
  current:hooks.current,preflight,
  send:async(text,replyTo)=>{text=outgoingText(text);if(!text)return;preflight('send',replyTo);await hooks.pace(text);preflight('send',replyTo);hooks.deliveryStarted();await transport.send(message.chatId,text,{replyTo});await hooks.delivered(text);},
  react:async(emoji,id)=>{preflight('react',id??message.id);if(!transport.react)throw new Error('Reactions unavailable');hooks.deliveryStarted();await transport.react({...message,id:id??message.id},emoji);await hooks.delivered();},
  ...(message.transport==='telegram'&&hooks.voice&&transport.sendVoice?{voice:async(text:string,replyTo?:string)=>{text=outgoingText(text);if(!text)return;preflight('voice',replyTo);const audio=await hooks.voice!.synthesize(text);await hooks.pace(text);preflight('voice',replyTo);hooks.deliveryStarted();await transport.sendVoice!(message.chatId,audio,{replyTo});await hooks.delivered(text);}}:{}),
 };
}
