import {createBuilder} from 'ai-sdk-provider-builder';
import {ProviderConfigError,providerFetch} from './provider-settings.js';
import {validateBuilder,builderMetadata,builderOutputLimit,type GenerationPart,type GenerationProfile} from './generation-config.js';
/** Fresh instance per generation, not a global session shared by roles or owners. */
export function builderModel(part:GenerationPart,profile:GenerationProfile,send:typeof fetch=providerFetch){
 const p=validateBuilder(part,profile);
 const model=createBuilder({apiKey:p.apiKey,userId:p.userId,privateKey:p.privateKey,fetch:send})(p.model);
 // SDK currently omits media. Refuse rather than silently losing screenshots/files.
 const check=(options:Parameters<typeof model.doGenerate>[0])=>{
  if(options.responseFormat&&options.responseFormat.type!=='text')throw new ProviderConfigError('Builder structured responseFormat is unsupported');
  if(options.providerOptions?.builder?.modelOverride!==undefined)throw new ProviderConfigError('Builder modelOverride is unsupported');
  options.maxOutputTokens=builderOutputLimit(options.maxOutputTokens??builderMetadata.maxOutputTokens);
  for(const message of options.prompt)if(message.role!=='system')for(const content of message.content){
   if(content.type==='file'||content.type==='tool-result'&&content.output.type==='content'&&content.output.value.some(v=>v.type!=='text'))throw new ProviderConfigError('Builder supports text-only input and text/JSON tool results');
  }
 };
 const safeError=(error:unknown)=>{
  if(error instanceof Error&&error.name==='AbortError')return new DOMException('Builder request aborted','AbortError');
  const status=error&&typeof error==='object'&&'statusCode'in error?error.statusCode:undefined;
  const clean=new Error('Builder request failed');clean.name='BuilderProviderError';
  return Object.assign(clean,typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?{statusCode:status}:{});
 };
 const generate=model.doGenerate.bind(model),stream=model.doStream.bind(model);
 model.doGenerate=async options=>{check(options);try{return await generate(options);}catch(error){throw safeError(error);}};
 model.doStream=async options=>{check(options);try{const result=await stream(options);return {...result,stream:result.stream.pipeThrough(new TransformStream({transform(value,controller){controller.enqueue(value.type==='error'?{...value,error:safeError(value.error)}:value);}}))};}catch(error){throw safeError(error);}};
 return model;
}
