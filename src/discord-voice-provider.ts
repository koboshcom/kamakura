import {GrokVoiceLive} from './discord-voice-xai.js';
import type {ServerEvent,ClientEvent} from 'openai/resources/live/live';
import OpenAI from 'openai';
import {LiveWS} from 'openai/resources/live/ws';
import {validateVoiceProviders,type VoiceConfig} from './discord-voice-config.js';

export interface VoiceLive {
 on(event:'event',listener:(event:ServerEvent)=>void):unknown;
 on(event:'error',listener:(error:unknown)=>void):unknown;
 on(event:'close',listener:()=>void):unknown;
 socket: {on(event:string,listener:(...args:any[])=>void):unknown;platformSocket:{bufferedAmount:number}};
 send(event:ClientEvent):void;close():void;readonly locallyClosed?:boolean;
}
/** Preserve the GPT-Live wire protocol, including at an operator-configured endpoint. */
export function createVoiceLive(cfg:VoiceConfig):VoiceLive {
 validateVoiceProviders(cfg);
 if(cfg.provider==='xai')return new GrokVoiceLive(cfg);
 // LiveWS normally appends /live/sessions to baseURL. Override only the outbound
 // socket target to support an exact operator endpoint without protocol translation.
 class ConfiguredLive extends LiveWS {
  protected override _createSocket(_url:URL,headers:Record<string,string>){
   return super._createSocket(new URL(cfg.endpoint),headers);
  }
 }
 return new ConfiguredLive(new OpenAI({
  apiKey:cfg.apiKey,baseURL:cfg.baseUrl,maxRetries:0,logLevel:'off',
  // Do not forward unrelated organization/project credentials to a custom host.
  adminAPIKey:null,webhookSecret:null,organization:null,project:null,
 }),{reconnect:null,maxQueueSize:16384,maxPayload:65536,followRedirects:false});
}
