import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {logger} from './logger.js';
import {config,allowed} from './config.js';
import {contextOwner} from './owner-context.js';
import {chatKey,type IncomingMessage} from './types.js';
import {providerUrl,type ProviderSettings} from './provider-settings.js';
export type CacheRole='chat'|'fast'|'worker'|'summary'|'learning'|'review';
export interface CacheScope {owner:string;chat:string;role:CacheRole}
const scopes=new AsyncLocalStorage<CacheScope>();
export function cacheScope<T>(scope:CacheScope|undefined,fn:()=>T):T {return scopes.run(scope as CacheScope,fn);}
export function cacheIncoming<T>(m:IncomingMessage,role:CacheRole,fn:()=>T):T {
 const existing=scopes.getStore();
 const groupOwner=m.transport==='telegram'&&m.isGroup&&m.senderId&&config.sandbox.allowed.has(m.senderId)&&allowed(config.telegramAllowed,m.chatId)?m.senderId:undefined;
 const owner=contextOwner(m)??groupOwner??(existing&&existing.owner===m.senderId&&existing.chat===chatKey(m)?existing.owner:undefined);return cacheScope(owner?{owner,chat:chatKey(m),role}:undefined,fn);
}
export function cacheRole<T>(role:CacheRole,fn:()=>T):T {const s=scopes.getStore();return cacheScope(s?{...s,role}:undefined,fn);}
export const cacheDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function promptCacheKey(scope:CacheScope|undefined,settings:ProviderSettings,role:CacheRole,model:string):string|undefined {
 if(!scope?.owner||!scope.chat||!model)return;
 return cacheDigest(['responses-prefix-v1',scope.owner,scope.chat,role,model,providerUrl(settings.baseUrl,'BASE_URL'),cacheDigest(settings.apiKey)]);
}
export function cacheUsage(usage:unknown) {
 const u=usage&&typeof usage==='object'?usage as Record<string,unknown>:{};
 const details=u.input_tokens_details as Record<string,unknown>|undefined;
 const good=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 const input=good(u.input_tokens)?u.input_tokens:null,cached=good(details?.cached_tokens)?details!.cached_tokens as number:null;
 return {inputTokens:input,cachedInputTokens:cached,cachedInputPercent:input!==null&&input>0&&cached!==null&&cached<=input?cached/input*100:null};
}
/** Responses protocol only. No retention, trust, tools or generation settings changed. */
export function cachedGenerationFetch(settings:ProviderSettings,part?:CacheRole,send:typeof fetch=(...args)=>globalThis.fetch(...args)):typeof fetch {
 return async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);
  const expected=providerUrl(settings.baseUrl,'BASE_URL')+'/responses';
  if(url.toString()!==expected||typeof init?.body!=='string')return send(input,init);
  let body:Record<string,unknown>;try{body=JSON.parse(init.body);}catch{return send(input,init);}
  const scope=scopes.getStore(),role=part??scope?.role??'chat';
  // OpenAI-compatible is not a capability declaration. Unknown gateways omit keys.
  const supported=providerUrl(settings.baseUrl,'BASE_URL')==='https://api.openai.com/v1';
  const key=supported?promptCacheKey(scope,settings,role,typeof body.model==='string'?body.model:''):undefined;
  const response=await send(input,{...init,...(key?{body:JSON.stringify({...body,prompt_cache_key:key})}:{})});
  if(body.stream===true)logger.info({role,...cacheUsage(undefined)},'provider cache usage');
  else {
   try {const result=await response.clone().json() as {usage?:unknown};logger.info({role,...cacheUsage(result.usage)},'provider cache usage');}
   catch {logger.info({role,...cacheUsage(undefined)},'provider cache usage');}
  }
  return response;
 };
}
