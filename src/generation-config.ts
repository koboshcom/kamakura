import {ProviderConfigError} from './provider-settings.js';
export const generationParts=['chat','fast','worker','summary','learning','review'] as const;
export type GenerationPart=typeof generationParts[number];
export interface GenerationProfile {provider:'openai'|'builder';apiKey:string;userId:string;privateKey:string;model:string}
export const builderPrefix=(part:GenerationPart)=>part==='chat'?'BUILDER':'BUILDER_'+part.toUpperCase();
export const selectorName=(part:GenerationPart)=>part==='chat'?'LLM_PROVIDER':part.toUpperCase()+'_LLM_PROVIDER';
/** No per-role credential fallback, no implicit OpenAI model selection. */
export function readGenerationProfiles(env:NodeJS.ProcessEnv=process.env):Record<GenerationPart,GenerationProfile>{
 return Object.fromEntries(generationParts.map(part=>{
  const selector=env[selectorName(part)]??'openai';
  if(selector!=='openai'&&selector!=='builder')throw new ProviderConfigError(selectorName(part));
  const prefix=builderPrefix(part);
  const profile:GenerationProfile={provider:selector,apiKey:env[prefix+'_API_KEY']??'',userId:env[prefix+'_USER_ID']??'',privateKey:env[prefix+'_PRIVATE_KEY']??'',model:env[prefix+'_MODEL']||'builder-model'};
  if(selector==='builder')validateBuilder(part,profile);
  return [part,profile];
 })) as Record<GenerationPart,GenerationProfile>;
}
export function validateBuilder(part:GenerationPart,p:GenerationProfile):GenerationProfile{
 const prefix=builderPrefix(part);
 for(const [name,value]of [['API_KEY',p.apiKey],['USER_ID',p.userId],['PRIVATE_KEY',p.privateKey],['MODEL',p.model]]){
  if(!value?.trim())throw new ProviderConfigError(prefix+'_'+name);
  if(name!=='PRIVATE_KEY'&&(/[\x00-\x20\x7f]/.test(value!)))throw new ProviderConfigError(prefix+'_'+name);
 }
 // Builder privateKey is an HTTP bearer token, not a PEM key; never echo values.
 if(/[\x00-\x20\x7f]/.test(p.privateKey))throw new ProviderConfigError(prefix+'_PRIVATE_KEY');
 if(p.model!=='builder-model')throw new ProviderConfigError(prefix+'_MODEL must be builder-model');
 return p;
}

export const builderMetadata=Object.freeze({id:'builder-model',name:'Builder (quality-v4)',contextWindow:200000,maxOutputTokens:65536});
export function builderOutputLimit(value:number):number{
 if(!Number.isSafeInteger(value)||value<1||value>builderMetadata.maxOutputTokens)throw new ProviderConfigError('Builder maxOutputTokens must be an integer from 1 to 65536');
 return value;
}
/** Provider-only metadata ceiling; no changes to OpenAI limits or model names. */
export function generationContext(profile:GenerationProfile,configured:number):number{
 return profile.provider==='builder'?Math.min(configured,builderMetadata.contextWindow):configured;
}
export function generationOutputConfig(provider:'openai'|'builder',raw:string|undefined,fallback:number,min:number,openaiMax:number,field:string):number{
 const value=Number(raw??(provider==='builder'?builderMetadata.maxOutputTokens:fallback));
 const max=provider==='builder'?builderMetadata.maxOutputTokens:openaiMax;
 if(!Number.isSafeInteger(value)||value<min||value>max)throw new ProviderConfigError(field);
 return value;
}
