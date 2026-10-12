import {validateProvider,providerUrl,type ProviderSettings} from './provider-settings.js';
import {snowflake} from './discord-config.js';
export interface VoiceBridgeConfig {context:boolean;delegate:boolean;transcript:boolean;chats:Map<string,string>;contextBytes:number;transcriptBytes:number}
import {isAbsolute} from 'node:path';
export interface VoiceConfig {bridge?:VoiceBridgeConfig;enabled:boolean;owners:Map<string,string>;selfId:string;token:string;python:string;directory:string;apiKey:string;baseUrl:string;endpoint:string;model:string;backendModel:string;backendBaseUrl:string;backendApiKey:string;voice:string;durationMs:number}
export function voiceConfig(env:NodeJS.ProcessEnv=process.env):VoiceConfig {
 if(env.DISCORD_VOICE_ENABLED&&!['true','false'].includes(env.DISCORD_VOICE_ENABLED))throw new Error('Invalid voice flag');
 const cfg:VoiceConfig={enabled:env.DISCORD_VOICE_ENABLED==='true',owners:new Map(),selfId:env.DISCORD_VOICE_SELF_ID??'',token:env.DISCORD_VOICE_USER_TOKEN??'',python:env.DISCORD_VOICE_PYTHON??'/app/voice-venv/bin/python',directory:env.DISCORD_VOICE_IPC_DIR??'/tmp/kamakura-discord-voice',apiKey:env.OPENAI_LIVE_API_KEY??'',baseUrl:env.OPENAI_LIVE_BASE_URL??'',endpoint:env.OPENAI_LIVE_ENDPOINT??'',model:env.OPENAI_LIVE_MODEL??'',backendModel:env.DISCORD_VOICE_BACKEND_MODEL??'',backendBaseUrl:env.DISCORD_VOICE_BACKEND_BASE_URL??'',backendApiKey:env.DISCORD_VOICE_BACKEND_API_KEY??'',voice:env.DISCORD_VOICE_VOICE??'marin',durationMs:Number(env.DISCORD_VOICE_MAX_SECONDS??300)*1000};
 if(!cfg.enabled)return cfg;
 validateVoiceProviders(cfg);
 const canonical=new Set((env.SANDBOX_ALLOWED_USERS??'').split(',').map(s=>s.trim()));
 const allowed=new Set((env.DISCORD_VOICE_ALLOWED_USERS??'').split(',').map(s=>s.trim()).filter(Boolean));
 const rows:unknown=JSON.parse(env.DISCORD_VOICE_OWNER_IDS??'{}');
 if(!rows||typeof rows!=='object'||Array.isArray(rows)||!allowed.size||canonical.has('*')||!snowflake(cfg.selfId)||!cfg.token||!cfg.apiKey||!isAbsolute(cfg.directory)||!isAbsolute(cfg.python)||!Number.isInteger(cfg.durationMs)||cfg.durationMs<10000||cfg.durationMs>300000)throw new Error('Invalid voice configuration');
 for(const [id,owner]of Object.entries(rows)){
  if(!snowflake(id)||id===cfg.selfId||!allowed.has(id)||typeof owner!=='string'||!/^[1-9][0-9]{0,19}$/.test(owner)||!canonical.has(owner))throw new Error('Invalid voice owner mapping');
  cfg.owners.set(id,owner);
 }
 if(cfg.owners.size!==allowed.size)throw new Error('Missing voice owner mapping');
 const flag=(name:string)=>{const v=env[name];if(v!==undefined&&!['true','false'].includes(v))throw new Error('Invalid voice bridge flag');return v==='true';};
 const context=flag('DISCORD_VOICE_CONTEXT_ENABLED'),delegate=flag('DISCORD_VOICE_MAIN_AGENT_ENABLED'),transcript=flag('DISCORD_VOICE_TRANSCRIPT_ENABLED');
 const chats=new Map<string,string>();
 if(context||delegate||transcript){
  const rows:unknown=JSON.parse(env.DISCORD_VOICE_MAIN_CHATS??'{}');
  if(!rows||typeof rows!=='object'||Array.isArray(rows))throw new Error('Invalid voice main chats');
  const telegram=new Set((env.TELEGRAM_ALLOWED_CHATS??'').split(',').map(x=>x.trim()));
  for(const owner of new Set(cfg.owners.values())){
   const key=(rows as Record<string,unknown>)[owner];
   if(key!=='telegram:'+owner||!telegram.has(owner))throw new Error('Voice bridge needs explicitly authorized private owner Telegram chat');
   chats.set(owner,key);
  }
 }
 const contextBytes=Number(env.DISCORD_VOICE_CONTEXT_BYTES??4000),transcriptBytes=Number(env.DISCORD_VOICE_TRANSCRIPT_BYTES??1048576);
 if(!Number.isInteger(contextBytes)||contextBytes<256||contextBytes>5000||!Number.isInteger(transcriptBytes)||transcriptBytes<12000||transcriptBytes>4194304)throw new Error('Invalid voice bridge budget');
 cfg.bridge={context,delegate,transcript,chats,contextBytes,transcriptBytes};
 return cfg;
}

/** Validate both parts before IPC, login or any provider request, even with endpoint override. */
export function validateVoiceProviders(cfg:VoiceConfig):void {
 if(!cfg.enabled)return;
 cfg.baseUrl=validateProvider('live',{baseUrl:cfg.baseUrl,apiKey:cfg.apiKey,model:cfg.model}).baseUrl;
 cfg.endpoint=providerUrl(cfg.endpoint||cfg.baseUrl+'/live/sessions','OPENAI_LIVE_ENDPOINT',true);
 validateProvider('voiceBackend',voiceBackendSettings(cfg));
}
export function voiceBackendSettings(cfg:VoiceConfig):ProviderSettings {return {baseUrl:cfg.backendBaseUrl,apiKey:cfg.backendApiKey,model:cfg.backendModel};}
