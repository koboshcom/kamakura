import test from 'node:test';
import assert from 'node:assert/strict';
import {generateText,streamText,tool,jsonSchema,stepCountIs} from 'ai';
import {parse} from 'dotenv';
import {builderModel} from '../src/builder-model.js';
import {config} from '../src/config.js';
import {generationParts,readGenerationProfiles,validateBuilder,type GenerationProfile} from '../src/generation-config.js';
import {modelFor,toolsFor,validateBuilderFeatures,generationSettings} from '../src/model-provider.js';
import {validateStartupProviders} from '../src/provider-startup.js';
const profile:GenerationProfile={provider:'builder',apiKey:'synthetic-public',userId:'synthetic-user',privateKey:'synthetic-private',model:'builder-model'};
const wire=(...events:object[])=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
const final=wire({type:'text',content:'five'},{type:'done',stopReason:'end_turn'});
function setup(responses:string[]){
 const calls:Record<string,any>[]=[];
 const send:typeof fetch=async(input,init)=>{
  assert.equal(String(input).startsWith('https://'),true);
  const body=JSON.parse(String(init?.body));calls.push(body);
  const headers=new Headers(init?.headers);assert.equal(headers.get('Authorization'),'Bearer '+profile.privateKey);
  assert.equal(init?.redirect,undefined); // Redirect denial lives in the app's providerFetch wrapper.
  return new Response(responses.shift(),{status:200});
 };
 return {model:builderModel('chat',profile,send),calls};
}
const tools={add:tool({inputSchema:jsonSchema<{a:number}>({type:'object',properties:{a:{type:'number'}},required:['a']}),execute:async({a})=>({sum:a+1})})};
const first=wire({type:'tool',id:'a1',filePath:'mcp__ai-sdk__add',content:''},{type:'delta',content:'{"a":'},{type:'delta',content:'4}'},{type:'done',stopReason:'tool_use'});
test('selectors default to OpenAI and never inherit Builder configuration between roles',()=>{
 const defaults=readGenerationProfiles({});for(const part of generationParts)assert.equal(defaults[part].provider,'openai');
 const selected=readGenerationProfiles({LLM_PROVIDER:'builder',BUILDER_API_KEY:profile.apiKey,BUILDER_USER_ID:profile.userId,BUILDER_PRIVATE_KEY:profile.privateKey,BUILDER_MODEL:profile.model});
 assert.equal(selected.chat.provider,'builder');for(const part of generationParts.filter(p=>p!=='chat'))assert.equal(selected[part].apiKey,'');
 assert.throws(()=>readGenerationProfiles({LLM_PROVIDER:'secret-value'}),e=>e instanceof Error&&e.message==='LLM_PROVIDER');
 assert.throws(()=>readGenerationProfiles({WORKER_LLM_PROVIDER:'builder',BUILDER_API_KEY:'never-fallback'}),/BUILDER_WORKER_API_KEY/);
 for(const key of ['apiKey','userId','privateKey','model'] as const)assert.throws(()=>validateBuilder('worker',{...profile,[key]:''}),e=>e instanceof Error&&e.message.startsWith('BUILDER_WORKER_'));
 assert.throws(()=>validateBuilder('chat',{...profile,model:'unsupported-sensitive-name'}),e=>e instanceof Error&&!e.message.includes('sensitive'));
});
test('dotenv quoted credentials are parsed, newline bearer tokens fail with field-only errors',()=>{
 const env=parse('LLM_PROVIDER=builder\nBUILDER_API_KEY="synthetic-public"\nBUILDER_USER_ID=synthetic-user\nBUILDER_PRIVATE_KEY="synthetic-private"\nBUILDER_MODEL=builder-model');
 assert.equal(readGenerationProfiles(env).chat.privateKey,profile.privateKey);
 for(const privateKey of ['sensitive\nvalue','sensitive\rvalue','sensitive\x00value',' sensitive']){
  assert.throws(()=>readGenerationProfiles({...env,BUILDER_PRIVATE_KEY:privateKey}),e=>e instanceof Error&&e.message==='BUILDER_PRIVATE_KEY');
 }
});
test('installed v3 provider works through app AI SDK generateText and function-tool continuation',async()=>{
 const {model,calls}=setup([first,final]);
 const result=await generateText({model,tools,prompt:'compute',instructions:'trusted system',stopWhen:stepCountIs(3),maxRetries:0});
 assert.equal(result.text,'five');assert.equal(result.steps.length,2);
 assert.equal(calls[0]!.localMCPTools.length,1);assert.equal(calls[1]!.sessionId,calls[0]!.sessionId);
 assert.equal(calls[1]!.toolResults[0].content,'{"sum":5}');
 assert.ok(calls[0]!.systemReminders.includes('trusted system'));
 assert.equal(result.usage.inputTokens,undefined);assert.equal(result.usage.outputTokens,undefined);
 assert.equal(calls[0]!.prompt_cache_key,undefined);
});
test('streamText exposes incremental function calls and completed tool execution',async()=>{
 const {model,calls}=setup([first,final]);const stream=streamText({model,tools,prompt:'compute',stopWhen:stepCountIs(3),maxRetries:0});
 const parts:any[]=[];for await(const part of stream.fullStream)parts.push(part);
 assert.equal(await stream.text,'five');assert.equal(parts.filter(p=>p.type==='tool-result').length,1);
 assert.equal(parts.filter(p=>p.type==='tool-input-delta').map(p=>p.delta).join(''),'{"a":4}');
 assert.equal(calls.length,2);
});
test('text and reasoning stream separately; full completed tool calls map correctly',async()=>{
 const {model}=setup([wire({type:'thinking',content:'consider'},{type:'text',content:'answer'},{type:'done',stopReason:'end_turn'})]);
 const result=await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'hi'}]}]});
 assert.ok(result.content.some(p=>p.type==='text'&&p.text==='answer'));
 assert.ok(result.content.some(p=>p.type==='reasoning'&&p.text==='consider'));
 const complete=setup([wire({type:'tool',id:'c1',filePath:'mcp__ai-sdk__add',content:'{"a":2}'},{type:'done',stopReason:'tool_use'})]);
 const response=await complete.model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'hi'}]}],tools:[{type:'function',name:'add',inputSchema:{type:'object'}}]});
 assert.ok(response.content.some(p=>p.type==='tool-call'&&p.toolName==='add'));
});
test('HTTP failure and account/stream errors are surfaced without app fallback',async()=>{
 const failing=builderModel('chat',profile,async()=>new Response('failure',{status:401}));
 await assert.rejects(generateText({model:failing,prompt:'hi',maxRetries:0}));
 const {model}=setup([wire({type:'error',code:'credits-limit-daily',message:'limit'},{type:'done',stopReason:'end_turn'})]);
 await assert.rejects(generateText({model,prompt:'hi',maxRetries:0}));
});
test('abort signal is passed to SDK fetch',async()=>{
 const controller=new AbortController();controller.abort();
 const model=builderModel('chat',profile,async(_input,init)=>{assert.equal(init?.signal?.aborted,true);throw new DOMException('aborted','AbortError');});
 await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'hi'}]}],abortSignal:controller.signal}),{name:'AbortError'});
});
test('images/files and media tool outputs reject before any provider request',async()=>{
 let calls=0;const model=builderModel('chat',profile,async()=>{calls++;return new Response(final);});
 await assert.rejects(model.doGenerate({prompt:[{role:'user',content:[{type:'file',data:new Uint8Array([1]),mediaType:'image/png'}]}]}),/text-only/);
 await assert.rejects(model.doGenerate({prompt:[{role:'tool',content:[{type:'tool-result',toolCallId:'x',toolName:'x',output:{type:'content',value:[{type:'image-data',data:'AQ==',mediaType:'image/png'}]}}]}]}),/text-only/);
 assert.equal(calls,0);
});
test('fresh model instances isolate owners and role selectors; other services unchanged',async()=>{
 const saved={...config.generation},webSearch=config.webSearch,oldFetch=globalThis.fetch;
 const sessions:string[]=[];const keys:string[]=[];
 try{
  config.webSearch=false;
  globalThis.fetch=async(_input,init)=>{assert.equal(init?.redirect,'error');const body=JSON.parse(String(init?.body));sessions.push(body.sessionId);keys.push(new Headers(init?.headers).get('Authorization')!);return new Response(final);};
  for(const part of generationParts){
   config.generation[part]={...profile,privateKey:'synthetic-'+part};
   assert.equal(modelFor(part).provider,'builder');assert.throws(()=>toolsFor(part),/hosted tools/);
   assert.throws(()=>generationSettings(part),/Responses/);
   await generateText({model:modelFor(part),prompt:'owner one',maxRetries:0});
   await generateText({model:modelFor(part),prompt:'owner two',maxRetries:0});
  }
  assert.equal(new Set(sessions).size,generationParts.length*2);
  assert.deepEqual(keys,generationParts.flatMap(part=>['Bearer synthetic-'+part,'Bearer synthetic-'+part]));
  validateBuilderFeatures();validateStartupProviders();
  config.webSearch=true;assert.throws(validateBuilderFeatures,/ENABLE_WEB_SEARCH/);
  config.webSearch=false;config.generation.worker={...profile,apiKey:''};assert.throws(validateBuilderFeatures,/BUILDER_WORKER_API_KEY/);
 }finally{Object.assign(config.generation,saved);config.webSearch=webSearch;globalThis.fetch=oldFetch;}
});
