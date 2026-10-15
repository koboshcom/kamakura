import {createBuilder} from 'ai-sdk-provider-builder';
import {ProviderConfigError,providerFetch} from './provider-settings.js';
import {validateBuilder,type GenerationPart,type GenerationProfile} from './generation-config.js';
/** Fresh instance per generation, not a global session shared by roles or owners. */
export function builderModel(part:GenerationPart,profile:GenerationProfile,send:typeof fetch=providerFetch){
 const p=validateBuilder(part,profile);
 const model=createBuilder({apiKey:p.apiKey,userId:p.userId,privateKey:p.privateKey,fetch:send})(p.model);
 // SDK currently omits media. Refuse rather than silently losing screenshots/files.
 const check=(options:Parameters<typeof model.doGenerate>[0])=>{
  for(const message of options.prompt)if(message.role!=='system')for(const content of message.content){
   if(content.type==='file'||content.type==='tool-result'&&content.output.type==='content'&&content.output.value.some(v=>v.type!=='text'))throw new ProviderConfigError('Builder supports text-only input and text/JSON tool results');
  }
 };
 const generate=model.doGenerate.bind(model),stream=model.doStream.bind(model);
 model.doGenerate=async options=>{check(options);return generate(options);};
 model.doStream=async options=>{check(options);return stream(options);};
 return model;
}
