import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createOpenAI} from '@ai-sdk/openai';
import {generateText} from 'ai';
import {cacheScope,cacheRole,promptCacheKey,cacheUsage,cachedGenerationFetch,type CacheScope} from '../src/cost-cache.js';
import {ExactEmbeddingCache} from '../src/embedding-cache.js';
const settings={baseUrl:'https://api.openai.com/v1',apiKey:'not-a-real-key',model:'o3'};
const scope:CacheScope={owner:'owner-fixture',chat:'telegram:chat-fixture',role:'chat'};
const usage={input_tokens:100,input_tokens_details:{cached_tokens:40}};
test('opaque stable key isolates owner chat role actual model normalized URL and auth tenant',()=>{
 const key=promptCacheKey(scope,settings,'chat',settings.model)!;
 assert.match(key,/^[a-f0-9]{64}$/);assert.equal(key.length,64);
 assert.equal(key,promptCacheKey({...scope},settings,'chat',settings.model));
 assert.equal(key,promptCacheKey(scope,{...settings,baseUrl:settings.baseUrl+'/'},'chat',settings.model));
 for(const changed of [
  promptCacheKey({...scope,owner:'foreign'},settings,'chat',settings.model),
  promptCacheKey({...scope,chat:'other'},settings,'chat',settings.model),
  ...(['fast','worker','summary','learning','review'] as const).map(role=>promptCacheKey(scope,settings,role,settings.model)),
  promptCacheKey(scope,settings,'chat','other-model'),
  promptCacheKey(scope,{...settings,apiKey:'other-tenant'},'chat',settings.model),
  promptCacheKey(scope,{...settings,baseUrl:'https://different.invalid/v1'},'chat',settings.model)
 ])assert.notEqual(changed,key);
 assert.equal(promptCacheKey(undefined,settings,'chat',settings.model),undefined);
 assert(!key.includes(scope.owner)&&!key.includes(settings.apiKey));
});
test('actual usage denominator, zero and missing are not invented hits',()=>{
 assert.deepEqual(cacheUsage(usage),{inputTokens:100,cachedInputTokens:40,cachedInputPercent:40});
 assert.deepEqual(cacheUsage(undefined),{inputTokens:null,cachedInputTokens:null,cachedInputPercent:null});
 assert.equal(cacheUsage({input_tokens:0,input_tokens_details:{cached_tokens:0}}).cachedInputPercent,null);
 assert.equal(cacheUsage({input_tokens:3,input_tokens_details:{cached_tokens:4}}).cachedInputPercent,null);
 assert.equal(cacheUsage({input_tokens:NaN,input_tokens_details:{cached_tokens:-1}}).cachedInputTokens,null);
 assert.equal(cacheUsage({input_tokens:100,input_tokens_details:{cached_tokens:0}}).cachedInputPercent,0);
});
test('documented SDK Responses request receives scoped key; content and options unchanged',async()=>{
 let body:Record<string,unknown>={};
 const send:typeof fetch=async(_input,init)=>{
  body=JSON.parse(init!.body as string);
  return new Response(JSON.stringify({id:'resp_fixture',object:'response',created_at:1,model:settings.model,status:'completed',output:[{type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'ok',annotations:[]}]}],usage:{...usage,output_tokens:1,output_tokens_details:{reasoning_tokens:0}}}),{headers:{'content-type':'application/json'}});
 };
 const provider=createOpenAI({baseURL:settings.baseUrl,apiKey:settings.apiKey,fetch:cachedGenerationFetch(settings,undefined,send)});
 await cacheScope(scope,()=>generateText({model:provider.responses(settings.model),instructions:'unchanged trusted instruction',prompt:'unchanged untrusted text',maxRetries:0,providerOptions:{openai:{store:false,reasoningEffort:'low'}}}));
 assert.equal(body.prompt_cache_key,promptCacheKey(scope,settings,'chat',settings.model));
 assert.equal(body.store,false);assert.equal((body.reasoning as {effort:string}).effort,'low');
 assert(!('prompt_cache_retention' in body));assert(JSON.stringify(body).includes('unchanged untrusted text'));
});
test('scope isolated under concurrency, nested roles restore, unsupported and unknown omit keys',async()=>{
 const captured:Record<string,unknown>[]=[];
 const send:typeof fetch=async(_input,init)=>{captured.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({usage}));};
 const fetcher=cachedGenerationFetch(settings,undefined,send),request=(path='responses')=>fetcher(settings.baseUrl+'/'+path,{method:'POST',body:JSON.stringify({model:settings.model,input:'exact'})});
 await Promise.all([cacheScope(scope,async()=>{await cacheRole('review',()=>request());await request();}),cacheScope({...scope,owner:'foreign'},()=>request())]);
 assert(captured.some(b=>b.prompt_cache_key===promptCacheKey(scope,settings,'review',settings.model)));
 assert(captured.some(b=>b.prompt_cache_key===promptCacheKey(scope,settings,'chat',settings.model)));
 assert(captured.some(b=>b.prompt_cache_key===promptCacheKey({...scope,owner:'foreign'},settings,'chat',settings.model)));
 for(const path of ['chat/completions','completions','embeddings','models']){
  await cacheScope(scope,()=>request(path));assert.equal(captured.at(-1)!.prompt_cache_key,undefined);
 }
 await request();assert.equal(captured.at(-1)!.prompt_cache_key,undefined);
});
test('embedding exact text, owner profile model dimensions base tenant separate, cloned values',async()=>{
 const cache=new ExactEmbeddingCache();let calls=0;const load=async()=>{calls++;return [1,2];},validate=(v:number[])=>assert.equal(v.length,2);
 const profile=['v1','model',2,'https://embedding.invalid','hashed-tenant'];
 const first=await cache.get('a',profile,' exact ',load,validate);first[0]=999;
 assert.deepEqual(await cache.get('a',profile,' exact ',load,validate),[1,2]);assert.equal(calls,1);
 await cache.get('a',profile,'exact',load,validate);await cache.get('b',profile,' exact ',load,validate);
 for(let i=0;i<profile.length;i++)await cache.get('a',profile.map((x,j)=>i===j?'changed':x),' exact ',load,validate);
 assert.equal(calls,8);
 await cache.get(undefined,profile,' exact ',load,validate);await cache.get(undefined,profile,' exact ',load,validate);assert.equal(calls,10);
});
test('embedding in-flight dedup, bounded LRU and TTL, failure and dimension errors evict',async()=>{
 let now=0,calls=0,finish!:()=>void;
 const cache=new ExactEmbeddingCache(2,10,()=>now);
 const load=async()=>{calls++;await new Promise<void>(r=>finish=r);return [1,2];},valid=(v:number[])=>{if(v.length!==2)throw new Error('bad dimensions');};
 const a=cache.get('owner','profile','a',load,valid),b=cache.get('owner','profile','a',load,valid);
 await Promise.resolve();finish();assert.deepEqual(await Promise.all([a,b]),[[1,2],[1,2]]);assert.equal(calls,1);
 const immediate=async()=>{calls++;return [1,2];};
 await cache.get('owner','profile','b',immediate,valid);await cache.get('owner','profile','c',immediate,valid);await cache.get('owner','profile','a',immediate,valid);assert.equal(calls,4);
 now=10;await cache.get('owner','profile','a',immediate,valid);assert.equal(calls,5);
 await assert.rejects(cache.get('owner','profile','bad',async()=>{throw new Error('offline');},valid));
 await assert.rejects(cache.get('owner','profile','bad',async()=>[1],valid));
 assert.deepEqual(await cache.get('owner','profile','bad',immediate,valid),[1,2]);
});
test('static delivery style precedes volatile history; trusted clock system and notes user',()=>{
 const s=readFileSync(new URL('../src/brain.ts',import.meta.url),'utf8');
 assert(s.includes('${staticTurnStyle}${recallStyle}\\n${recentChatStyle(history)}'));
 assert(s.includes("role: 'user', content: \x60Previously learned advisory notes"));
 assert(s.includes("role: 'system' as const, content: \x60\x24{turnInstructions}"));
 assert(s.includes('${actionSafetyInstruction}\\n${persona}\\n${rules}\\nLearning is optional advisory data.'));
 assert(s.includes('currentTimeContext(owner, config.time)'));
});

test('unknown compatible gateway never receives cache key or a retry',async()=>{
 let calls=0;let body:Record<string,unknown>={};
 const custom={...settings,baseUrl:'https://gateway.invalid/v1'};
 const send:typeof fetch=async(_input,init)=>{calls++;body=JSON.parse(init!.body as string);return new Response(JSON.stringify({error:{message:'fixture failure'}}),{status:400});};
 const response=await cacheScope(scope,()=>cachedGenerationFetch(custom,undefined,send)(custom.baseUrl+'/responses',{method:'POST',body:JSON.stringify({model:custom.model,input:'same'})}));
 assert.equal(response.status,400);assert.equal(calls,1);assert.equal(body.prompt_cache_key,undefined);
});
