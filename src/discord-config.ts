import {ownerId,discordOwner} from './owner-id.js';
export interface DiscordConfig { self?:boolean; enabled: boolean; token: string; owners: Map<string,string>; maxAgeMs: number }
export const snowflake = (value: unknown): value is string => typeof value==='string' && /^[1-9][0-9]{16,19}$/.test(value) && BigInt(value)<=18446744073709551615n;
export function discordConfig(env:NodeJS.ProcessEnv=process.env):DiscordConfig {
 if(env.DISCORD_ENABLED && !['true','false'].includes(env.DISCORD_ENABLED))throw new Error('Invalid Discord flag');
 if(env.DISCORD_SELF_DM_ENABLED&&!['true','false'].includes(env.DISCORD_SELF_DM_ENABLED))throw new Error('Invalid self DM flag');
 const self=env.DISCORD_SELF_DM_ENABLED==='true';
 if(self&&(env.DISCORD_ENABLED==='true'||env.DISCORD_VOICE_ENABLED!=='true'))throw new Error('Self DM requires voice sidecar, not bot transport');
 const cfg:DiscordConfig={self,enabled:self||env.DISCORD_ENABLED==='true',token:env.DISCORD_BOT_TOKEN??'',owners:new Map(),maxAgeMs:120000};
 if(!cfg.enabled)return cfg;
 if(!self&&!cfg.token.trim())throw new Error('Discord bot token required');
 const allowed=new Set((env.DISCORD_ALLOWED_USERS??'').split(',').map(s=>s.trim()).filter(Boolean));
 const canonical=new Set((env.SANDBOX_ALLOWED_USERS??'').split(',').map(s=>s.trim()));
 const rows:unknown=JSON.parse(env.DISCORD_OWNER_IDS??'{}');
 if(!rows||typeof rows!=='object'||Array.isArray(rows)||!allowed.size||[...allowed].some(id=>!snowflake(id))||canonical.has('*'))throw new Error('Invalid Discord authorization');
 for(const [id,owner] of Object.entries(rows)){
  if(!snowflake(id)||typeof owner!=='string'||!ownerId(owner)||owner.startsWith('discord-')&&owner!==discordOwner(id)||!canonical.has(owner)||!allowed.has(id))throw new Error('Discord owner mapping not explicitly authorized');
  cfg.owners.set(id,owner);
 }
 if(cfg.owners.size!==allowed.size)throw new Error('Every Discord user requires an explicit owner mapping');
 if(self){const voice=JSON.parse(env.DISCORD_VOICE_OWNER_IDS??'{}');if([...cfg.owners].some(([id,owner])=>voice[id]!==owner))throw new Error('DM and voice owner mismatch');}
 return cfg;
}
