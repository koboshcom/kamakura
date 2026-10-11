import {createOpenAI} from '@ai-sdk/openai';
import {config} from './config.js';
import {providerFetch,validateProvider,rejectLegacyProviderKey,type ProviderSettings} from './provider-settings.js';
export type GenerationPart='chat'|'fast'|'worker'|'summary'|'learning'|'review';
export function generationSettings(part:GenerationPart):ProviderSettings {
 if(part==='chat'){rejectLegacyProviderKey();return validateProvider(part,{...config.provider,model:config.model});}
 return validateProvider(part,{...config[`${part}Provider`],model:config[`${part}Model`]});
}
export function isolatedProvider(settings:ProviderSettings){
 return createOpenAI({baseURL:settings.baseUrl,apiKey:settings.apiKey,fetch:providerFetch});
}
export function modelFor(part:GenerationPart){const settings=generationSettings(part);return isolatedProvider(settings).responses(settings.model);}
export function toolsFor(part:GenerationPart){return isolatedProvider(generationSettings(part)).tools;}
