import {createHash} from 'node:crypto';
import {config} from './config.js';
import {logger} from './logger.js';
import {namespace} from './mongo.js';
import {chatKey,type IncomingMessage} from './types.js';
export const contentHash=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,32);
export function turnFields(m:IncomingMessage){
 const scope=namespace(config.dataDir).slice(0,32);
 return {namespace:scope,chatHash:contentHash(chatKey(m)),turnId:contentHash(JSON.stringify([scope,chatKey(m),m.id,m.timestamp])),inboundIdHash:contentHash(m.id),transport:m.transport};
}
/** Content-free correlation only, no text, credentials, URLs, media or raw IDs. */
export function traceTurn(m:IncomingMessage,event:string,fields:Record<string,unknown>={}){
 if(m.transport==='discord')logger.info({...turnFields(m),event,...fields},'Discord turn diagnostic');
}
