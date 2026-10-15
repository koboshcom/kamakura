import {cachedGenerationFetch} from './cost-cache.js';
import {createOpenAI} from '@ai-sdk/openai';
import {config} from './config.js';
import {providerFetch,validateProvider,rejectLegacyProviderKey,type ProviderSettings} from './provider-settings.js';
import {builderModel} from './builder-model.js';
import {validateBuilder,generationParts,type GenerationPart} from './generation-config.js';
export type {GenerationPart} from './generation-config.js';
export const usesBuilder=(part:GenerationPart)=>config.generation[part].provider==='builder';
export function validateGeneration(part:GenerationPart){if(usesBuilder(part))return validateBuilder(part,config.generation[part]);return generationSettings(part);}
export function validateBuilderFeatures(){for(const part of generationParts)if(usesBuilder(part)){validateGeneration(part);if(config.webSearch&&['chat','fast','worker'].includes(part))throw new Error('Builder does not support ENABLE_WEB_SEARCH; set it to false');}}
export function generationSettings(part:GenerationPart):ProviderSettings {
 if(usesBuilder(part))throw new Error('Builder does not expose an OpenAI Responses provider');
 if(part==='chat'){rejectLegacyProviderKey();return validateProvider(part,{...config.provider,model:config.model});}
 return validateProvider(part,{...config[`${part}Provider`],model:config[`${part}Model`]});
}
export function isolatedProvider(settings:ProviderSettings,part?:GenerationPart){
 return createOpenAI({baseURL:settings.baseUrl,apiKey:settings.apiKey,fetch:cachedGenerationFetch(settings,part,providerFetch)});
}
export function modelFor(part:GenerationPart){if(usesBuilder(part))return builderModel(part,config.generation[part]);const settings=generationSettings(part);return isolatedProvider(settings,part).responses(settings.model);}
export function toolsFor(part:GenerationPart){if(usesBuilder(part))throw new Error('Builder does not support OpenAI hosted tools');return isolatedProvider(generationSettings(part),part).tools;}
