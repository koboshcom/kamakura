
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {config} from '../src/config.js';
import {searchWeb,webSearchTools} from '../src/web-search.js';
test('private search encodes queries, fixes engine, caps and filters results',async()=>{
 let requests=0;
 const results=await searchWeb('cats & dogs !google',2,async(url,options)=>{
  requests++;const u=new URL(String(url));
  assert.equal(u.origin,'http://searxng:8080');assert.equal(u.pathname,'/search');assert.equal(u.searchParams.get('q'),'cats & dogs !google');
  assert.equal(u.searchParams.get('engines'),'duckduckgo');assert.equal(u.searchParams.get('format'),'json');assert.equal(options?.redirect,'error');assert.ok(options?.signal);
  return Response.json({results:[{title:'bad',url:'javascript:alert(1)'},{title:'bad'},{title:'one',url:'https://example.com',content:'excerpt'},{title:'dup',url:'https://example.com'},{title:'two',url:'https://example.org'}]});
 });
 assert.equal(requests,1);assert.deepEqual(results,{results:[{title:'one',url:'https://example.com/',snippet:'excerpt'},{title:'two',url:'https://example.org/',snippet:''}]});
});
test('search distinguishes empty results from errors and hides backend details',async()=>{
 assert.deepEqual(await searchWeb('none',5,async()=>Response.json({results:[]})),{results:[]});
 for(const send of [
  async()=>new Response('secret',{status:503}),
  async()=>new Response('not json'),
  async()=>Response.json({results:'bad'}),
  async()=>Response.json({results:[],unresponsive_engines:[['duckduckgo','timeout']]}),
  async()=>{throw new Error('private secret');},
  async()=>new Response('x'.repeat(1048577)),
 ]){
  await assert.rejects(searchWeb('cats',5,send),/^Error: Web search unavailable; try again later$/);
 }
});
test('search validates bounds and configured endpoint before transport',async()=>{
 let calls=0;const send=async()=>{calls++;return Response.json({results:[]});};
 for(const [q,n]of [['',5],['x'.repeat(1001),5],['cats',11],['cats',0]]as const)await assert.rejects(searchWeb(q,n,send));
 const original=config.searxngUrl;
 try{for(const url of ['file:///etc/passwd','http://user:pass@searxng','http://searxng/?secret=1']){config.searxngUrl=url;await assert.rejects(searchWeb('cats',5,send),/SEARXNG_URL/);}}
 finally{config.searxngUrl=original;}
 assert.equal(calls,0);
});
test('web search is opt-in and is an executable tool for every provider',async()=>{
 const saved=config.webSearch;const original=globalThis.fetch;
 try{
  config.webSearch=false;assert.deepEqual(webSearchTools(),{});
  config.webSearch=true;const tools=webSearchTools();assert.equal(typeof tools.web_search.execute,'function');
  globalThis.fetch=async()=>Response.json({results:[{title:'example',url:'https://example.com',content:'test'}]});
  const result=await tools.web_search.execute!({query:'example',limit:1},{toolCallId:'test',messages:[]});
  assert.deepEqual(result,{results:[{title:'example',url:'https://example.com/',snippet:'test'}]});
 }finally{config.webSearch=saved;globalThis.fetch=original;}
});
test('compose search has no host ports and only DuckDuckGo configured',()=>{
 const compose=readFileSync('compose.yaml','utf8'),settings=readFileSync('deploy/searxng/settings.yml','utf8');
 const service=compose.split('  searxng:\n')[1].split('  mongo:\n')[0];
 assert.match(service,/searxng\/searxng/);assert.doesNotMatch(service,/\n    ports:/);assert.match(service,/settings.yml:ro/);assert.match(compose,/search-internal:\n    internal: true/);
 assert.match(settings,/keep_only: \[duckduckgo\]/);assert.match(settings,/formats: \[json\]/);assert.match(settings,/limiter: false/);
 for(const file of ['src/brain.ts','src/worker.ts'])assert.match(readFileSync(file,'utf8'),/\.\.\.webSearchTools\(/);
});
