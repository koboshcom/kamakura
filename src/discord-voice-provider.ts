import OpenAI from 'openai';
import {LiveWS} from 'openai/resources/live/ws';
import {validateVoiceProviders,type VoiceConfig} from './discord-voice-config.js';

/** Preserve the GPT-Live wire protocol, including at an operator-configured endpoint. */
export function createVoiceLive(cfg:VoiceConfig):LiveWS {
 validateVoiceProviders(cfg);
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
  organization:null,project:null,
 }),{reconnect:null,maxQueueSize:16384,maxPayload:65536,followRedirects:false});
}
