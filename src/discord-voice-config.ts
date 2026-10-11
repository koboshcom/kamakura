import {snowflake} from './discord-config.js';
import {isAbsolute} from 'node:path';
export interface VoiceConfig {enabled:boolean;owners:Map<string,string>;selfId:string;token:string;python:string;directory:string;apiKey:string;model:string;backendModel:string;voice:string;durationMs:number}
export function voiceConfig(env:NodeJS.ProcessEnv=process.env):VoiceConfig {
 if(env.DISCORD_VOICE_ENABLED&&!['true','false'].includes(env.DISCORD_VOICE_ENABLED))throw new Error('Invalid voice flag');
 const cfg:VoiceConfig={enabled:env.DISCORD_VOICE_ENABLED==='true',owners:new Map(),selfId:env.DISCORD_VOICE_SELF_ID??'',token:env.DISCORD_VOICE_USER_TOKEN??'',python:env.DISCORD_VOICE_PYTHON??'/app/voice-venv/bin/python',directory:env.DISCORD_VOICE_IPC_DIR??'/tmp/kamakura-discord-voice',apiKey:env.OPENAI_LIVE_API_KEY??env.OPENAI_API_KEY??'',model:'gpt-live-1',backendModel:env.DISCORD_VOICE_BACKEND_MODEL??env.OPENAI_MODEL??'gpt-6-luna',voice:env.DISCORD_VOICE_VOICE??'marin',durationMs:Number(env.DISCORD_VOICE_MAX_SECONDS??300)*1000};
 if(!cfg.enabled)return cfg;
 const canonical=new Set((env.SANDBOX_ALLOWED_USERS??'').split(',').map(s=>s.trim()));
 const allowed=new Set((env.DISCORD_VOICE_ALLOWED_USERS??'').split(',').map(s=>s.trim()).filter(Boolean));
 const rows:unknown=JSON.parse(env.DISCORD_VOICE_OWNER_IDS??'{}');
 if(!rows||typeof rows!=='object'||Array.isArray(rows)||!allowed.size||canonical.has('*')||!snowflake(cfg.selfId)||!cfg.token||!cfg.apiKey||!isAbsolute(cfg.directory)||!isAbsolute(cfg.python)||!Number.isInteger(cfg.durationMs)||cfg.durationMs<10000||cfg.durationMs>300000)throw new Error('Invalid voice configuration');
 for(const [id,owner]of Object.entries(rows)){
  if(!snowflake(id)||id===cfg.selfId||!allowed.has(id)||typeof owner!=='string'||!/^[1-9][0-9]{0,19}$/.test(owner)||!canonical.has(owner))throw new Error('Invalid voice owner mapping');
  cfg.owners.set(id,owner);
 }
 if(cfg.owners.size!==allowed.size)throw new Error('Missing voice owner mapping');
 return cfg;
}
