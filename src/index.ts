import {startLocalDevices,stopLocalDevices} from './local-device-service.js';
import {desktopAccess,startDesktopAccess} from './desktop-service.js';
import pLimit from 'p-limit';
import {think,reminders,facts} from './brain.js';
import {prepareMedia} from './media.js';
import {config} from './config.js';
import {HistoryStore} from './history.js';
import {errorType,logger} from './logger.js';
import {chatKey,type Transport} from './types.js';
import {TelegramTransport} from './transports/telegram.js';
import {sandboxes} from './sandbox.js';
import {startWorkers,stopWorkers} from './worker.js';
import {ReplyBatches} from './batching.js';
import {stopLearning,lessons} from './learning-runtime.js';
import {speechAvailable,synthesizeVoice} from './speech.js';
import {closeMongo,isMongoUnavailable} from './mongo.js';
if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is required');
const history=new HistoryStore(config.dataDir,config.historyLimit);const limit=pLimit(config.concurrency);const transports=new Map<string,Transport>();
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
// Mongo remains canonical. Durable pending history permits degraded chat while claims stay fail closed.
const recoverStorage=async()=>{try{await Promise.all([history.recover(),facts.ready(),lessons.ready(),reminders.ready()]);}catch(error){if(!isMongoUnavailable(error))throw error;logger.warn({err:errorType(error)},'Mongo unavailable; bounded pending history only, reminders paused');}};
await recoverStorage();const storageRetry=setInterval(()=>void recoverStorage().catch(error=>logger.error({err:errorType(error)},'Storage recovery blocked; operator intervention required')),15000);storageRetry.unref();
const voiceEnabled=await speechAvailable();
const batches=new ReplyBatches(config.debounceMs,config.maxInputChars,async(message,current,markDelivered)=>{
 const key=chatKey(message),transport=transports.get(message.transport)!;const stopTyping=transport.startTyping?.(message.chatId);let sent=0;
 const pace=async(text:string)=>{if(sent++)await pause(Math.min(2000,config.messageDelayMs+text.length*12));if(!current())throw new Error('Turn superseded before delivery');};
 try{await limit(async()=>{
  if(!current())return;const media=message.media?.length?await prepareMedia(message.media):undefined;if(!current())return;
  await think(await history.get(key),message,media,undefined,{history,delivery:{current,
   send:async(text,replyTo)=>{await pace(text);await transport.send(message.chatId,text,{replyTo});markDelivered?.();await history.add(key,{role:'assistant',senderId:message.senderId,text,at:Date.now()});},
   react:async(emoji,messageId)=>{if(!current())throw new Error('Turn superseded');if(!transport.react)throw new Error('Reactions unavailable');await transport.react({...message,id:messageId??message.id},emoji);markDelivered?.();},
   ...(voiceEnabled&&transport.sendVoice?{voice:async(text:string,replyTo?:string)=>{const audio=await synthesizeVoice(text);await pace(text);await transport.sendVoice!(message.chatId,audio,{replyTo});markDelivered?.();await history.add(key,{role:'assistant',senderId:message.senderId,text,at:Date.now()});}}:{}),
  }});
 });}finally{stopTyping?.();}
},message=>history.add(chatKey(message),{role:'user',sender:message.sender,senderId:message.senderId,id:message.id,credentialEligible:message.credentialEligible===true,text:message.text,at:message.timestamp}),error=>logger.error({err:errorType(error)},'reply failed'));
transports.set('telegram',new TelegramTransport());
startWorkers(async(job,text)=>{
 const transport=transports.get(job.incoming.transport);if(!transport)throw new Error('Worker transport unavailable');
 const cleaned=text.replace(/<react:[^>\n]*>|<skip>/gi,'').trim();const size=Math.max(config.maxReplyChars,1200);const messages=[];for(let i=0;i<cleaned.length;i+=size)messages.push(cleaned.slice(i,i+size));if(!messages.length)messages.push('the worker finished without a written result.');
 for(const [index,text]of messages.entries()){if(index)await pause(Math.min(2000,config.messageDelayMs+text.length*12));await transport.send(job.incoming.chatId,text);await history.add(chatKey(job.incoming),{role:'assistant',senderId:job.incoming.senderId,text,at:Date.now()});}
},incoming=>transports.get(incoming.transport)?.startTyping?.(incoming.chatId)??(()=>{}));
for(const transport of transports.values())await transport.start(message=>batches.receive(message));sandboxes.start();await startDesktopAccess();await startLocalDevices();
reminders.start(async item=>{const transport=transports.get(item.transport);if(!transport)throw new Error('transport unavailable');await transport.send(item.chat,item.text);await history.add(`${item.transport}:${item.chat}`,{role:'assistant',senderId:item.owner,text:item.text,at:Date.now()});});
const shutdown=async()=>{clearInterval(storageRetry);batches.stop();stopWorkers();stopLearning();reminders.stop();sandboxes.stop();desktopAccess?.close();stopLocalDevices();for(const transport of transports.values())await transport.stop().catch(()=>undefined);await reminders.close();await closeMongo();process.exit(0);};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);logger.info({transports:[...transports.keys()],model:config.model,voiceEnabled},'kamakura awake');
