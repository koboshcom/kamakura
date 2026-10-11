/** Configuration errors contain operator field names only, never supplied values. */
export class ProviderConfigError extends Error {
 constructor(field:string){super(field);this.name='ProviderConfigError';}
}
export interface ProviderSettings {baseUrl:string;apiKey:string;model:string}
export const providerNames={chat:'OPENAI',fast:'FAST',worker:'OPENAI_WORKER',summary:'OPENAI_SUMMARY',learning:'OPENAI_LEARNING',review:'OPENAI_REVIEW',live:'OPENAI_LIVE',voiceBackend:'DISCORD_VOICE_BACKEND',embedding:'EMBEDDING',transcription:'OPENAI_TRANSCRIBE',speech:'SPEECH_TTS'} as const;
export type ProviderPart=keyof typeof providerNames;
export function readProvider(part:ProviderPart,env:NodeJS.ProcessEnv=process.env):ProviderSettings {
 const prefix=providerNames[part];return {baseUrl:env[prefix+'_BASE_URL']??'',apiKey:env[prefix+'_API_KEY']??'',model:env[prefix+'_MODEL']??''};
}
export function providerUrl(value:string,field:string,websocket=false):string {
 let url:URL;try{url=new URL(value);}catch{throw new ProviderConfigError(field);}
 if(value!==value.trim()||/[\x00-\x20\x7f\\]/.test(value)||!['http:','https:',...(websocket?['ws:','wss:']:[])].includes(url.protocol)||!url.hostname||url.username||url.password||value.includes('?')||value.includes('#'))throw new ProviderConfigError(field);
 if(websocket)url.protocol=['http:','ws:'].includes(url.protocol)?'ws:':'wss:';
 return websocket?url.toString():url.toString().replace(/\/$/,'');
}
export function validateProvider(part:ProviderPart,settings:ProviderSettings):ProviderSettings {
 const prefix=providerNames[part];
 for(const [name,value] of [['BASE_URL',settings.baseUrl],['API_KEY',settings.apiKey],['MODEL',settings.model]])if(!value?.trim())throw new ProviderConfigError(prefix+'_'+name);
 const baseUrl=providerUrl(settings.baseUrl,prefix+'_BASE_URL');
 if(/[\x00-\x1f\x7f]/.test(settings.apiKey)||settings.apiKey!==settings.apiKey.trim())throw new ProviderConfigError(prefix+'_API_KEY');
 if(settings.model.length>200||/[\x00-\x20\x7f]/.test(settings.model))throw new ProviderConfigError(prefix+'_MODEL');
 return {...settings,baseUrl};
}
export function providerConfigured(settings:ProviderSettings):boolean {return Object.values(settings).some(value=>Boolean(value.trim()));}
export function rejectLegacyProviderKey(env:NodeJS.ProcessEnv=process.env):void {if(env.PROVIDER_API_KEY?.trim())throw new ProviderConfigError('PROVIDER_API_KEY');}
/** Never follow redirects carrying a part's credential, including same-origin redirects. */
export const providerFetch:typeof fetch=(input,init)=>globalThis.fetch(input,{...init,redirect:'error'});
