import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createHash} from 'node:crypto';
import {SearchCollector,GroundingPages,trustedSuggestions,resultHTML,groundingHeaders} from '../src/video-grounding.js';
import {GeminiVideoClient,geminiVideoSettings,GeminiYouTubeCache} from '../src/gemini-video.js';
import {redactStoredCredentials} from '../src/credentials.js';
const html='<style>.container { padding: 8px; }</style><div class="container"><a href="https://www.google.com/search?q=example" target="_blank">Search</a><svg viewBox="0 0 8 8"><path d="M0 0"/></svg></div>';
function result(text='<script>model html</script>'){
 const c=new SearchCollector();c.step({type:'google_search_call',arguments:{queries:['example']}});
 c.step({type:'google_search_result',result:[{search_suggestions:html}]});c.step({type:'text',annotations:[{type:'url_citation',url:'https://example.com',title:'Source',start_index:0,end_index:4}]});
 c.interaction({usage:{total_input_tokens:100,total_output_tokens:20,grounding_tool_count:[{type:'google_search',count:1}]}});
 return c.finish(text);
}
test('trusted API widget byte-identical, model text escaped without altering answer',()=>{
 const r=result();assert.equal(trustedSuggestions(html),html);const page=resultHTML(r);assert(page.includes(html));assert(page.includes('&lt;script&gt;model html&lt;/script&gt;'));assert(!page.includes('<script>model'));assert(!page.includes('<iframe'));assert(page.includes('charset="utf-8"'));assert(page.includes('name="viewport"'));
 for(const h of ['<script>alert(1)</script>','<a href="javascript:alert(1)">x</a>','<a href="https://example.com" onclick="x()">x</a>','<iframe src="x"></iframe>','<base href="https://example.com">','<svg><foreignObject><div>x</div></foreignObject></svg>','<a href="/api">x</a>'])assert.throws(()=>trustedSuggestions(h));
});
test('enabled is not used, missing/unsafe suggestions incomplete; usage/queries/sources retained',()=>{
 const c=new SearchCollector();assert.equal(c.finish('No search').used,false);
 c.step({type:'google_search_call',arguments:{queries:['query']}});const r=c.finish('answer');assert.equal(r.used,true);assert.equal(r.complete,false);
 const b=new SearchCollector();b.step({type:'google_search_result',result:[{search_suggestions:'<script>x</script>'}]});assert.equal(b.finish('a').complete,false);
 assert.equal(result().sources.length,1);assert.equal(result().usage.total_input_tokens,100);assert.deepEqual(result().queries,['example']);
});
test('generateContent grounding metadata and citation spans validated',()=>{
 const c=new SearchCollector();c.generate({usageMetadata:{promptTokenCount:20},candidates:[{groundingMetadata:{webSearchQueries:['example'],searchEntryPoint:{renderedContent:html},groundingChunks:[{web:{uri:'https://example.com',title:'a'}}],groundingSupports:[{segment:{startIndex:0,endIndex:2}}]}}]});
 assert.equal(c.finish('ok').complete,true);assert.equal(c.finish('ok').sources.length,1);
 assert.throws(()=>new SearchCollector().step({type:'text_annotation_delta',annotations:[{type:'url_citation',url:'https://example.com',start_index:5,end_index:2}]}));
});
async function get(port:number,path:string,cookie?:string,method='GET'){return new Promise<{status:number;headers:any;body:string}>((r,j)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:cookie?{cookie}:{}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>r({status:res.statusCode!,headers:res.headers,body}));});req.on('error',j);req.end();});}
test('result-only bearer access, hashes, no cookies, headers, expiry, revoke, unrelated tokens denied',async()=>{
 let now=1000;const pages=new GroundingPages('https://desktop.example',o=>['one','two'].includes(o),1000,2,()=>now);
 const server=createServer((req,res)=>{if(!pages.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 try{
  assert.throws(()=>pages.issue('other',result()));assert.throws(()=>pages.issue('one',new SearchCollector().finish('unused')));
  const one=pages.issue('one',result()),two=pages.issue('two',result('two'));const path=new URL(one.url).pathname,token=path.split('/').pop()!;
  const entries=(pages as any).entries;assert(!JSON.stringify([...entries]).includes(token));assert(!entries.has(token));assert(entries.has(createHash('sha256').update('grounding-result-only\0'+token).digest('hex')));
  assert(!redactStoredCredentials(one.url).includes(token));
  const valid=await get(port,path,'desktop_access=unrelated');assert.equal(valid.status,200);assert.equal(valid.headers['set-cookie'],undefined);assert.equal(valid.headers['cache-control'],'no-store');assert.equal(valid.headers['referrer-policy'],'no-referrer');assert.match(valid.headers['content-security-policy'],/script-src 'none'.*frame-ancestors 'none'/);assert.equal(valid.headers['x-robots-tag'],'noindex, nofollow, noarchive');assert(valid.body.includes(html));
  for(const p of ['/video-result/','/video-result/'+ 'f'.repeat(64),path+'?x=1',path+'/../',path.replace(token,'%'+token)])assert.equal((await get(port,p)).status,403);
  assert.equal((await get(port,path,undefined,'POST')).status,403);
  assert.equal((await get(port,path,undefined,'HEAD')).body,'');
  assert.throws(()=>pages.issue('one',result()));pages.revokeOwner('one');assert.equal((await get(port,path)).status,403);assert.equal((await get(port,new URL(two.url).pathname)).status,200);
  now=2001;assert.equal((await get(port,new URL(two.url).pathname)).status,403);assert.equal(entries.size,0);
 }finally{pages.close();server.close();}
});
const settings=geminiVideoSettings({GEMINI_VIDEO_KEY:'fixture-search-key',GEMINI_VIDEO_MODEL:'gemini-3.5-flash-lite',GEMINI_VIDEO_BASE_URL:'https://provider.example',GEMINI_VIDEO_GOOGLE_SEARCH:'true'})!;
const event=(event_type:string,rest:any)=>'data: '+JSON.stringify({event_type,...rest})+'\n\n';
function wire(used=true){return event('step.start',{index:0,step:{type:'thought'}})+event('step.delta',{index:0,delta:{type:'text',text:'private thought'}})+(used?event('step.start',{index:1,step:{type:'google_search_call',arguments:{queries:['example']}}})+event('step.delta',{index:2,delta:{type:'google_search_result',result:[{search_suggestions:html}]}}):'')+event('step.start',{index:3,step:{type:'model_output'}})+event('step.delta',{index:3,delta:{type:'text',text:'Original answer'}})+event('step.delta',{index:3,delta:{type:'text_annotation_delta',annotations:[{type:'url_citation',url:'https://example.com',start_index:0,end_index:8}]}})+event('interaction.completed',{interaction:{status:'completed',usage:{total_input_tokens:120,total_output_tokens:20}}});}
test('static native/agentic documented search tool SSE, thoughts excluded, consumed once',async()=>{
 for(const duration of [90,600]){
  let body:any;const client=new GeminiVideoClient(settings,(async(_u,i)=>{body=JSON.parse(String(i?.body));return new Response(wire(),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch);
  assert.equal(await client.answerURI('https://www.youtube.com/watch?v=8jppMQSi_rE',duration,undefined,'identify',AbortSignal.timeout(1000)),'Original answer');
  assert.deepEqual(body.tools,[{type:'google_search'}]);assert.equal(body.store,false);assert.equal(duration<300?body.input[0].processing.type:body.input[0].processing,duration<300?'static':'agentic');
  const r=client.takeSearch()!;assert(r.used&&r.complete);assert.equal(r.original,'Original answer');assert.equal(r.sources.length,1);assert.equal(client.takeSearch(),undefined);
 }
});
test('short local generateContent Google Search exact wire',async()=>{
 let body:any;const client=new GeminiVideoClient(settings,(async(_u,i)=>{body=JSON.parse(String(i?.body));return new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'secret thought'},{text:'original local'}]},groundingMetadata:{webSearchQueries:['example'],searchEntryPoint:{renderedContent:html}}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:30}}));}) as typeof fetch);
 assert.equal(await client.answer({data:Buffer.from('clip'),mime:'video/mp4',start:0,end:11,sourceDuration:11,transferBytes:4,processedSeconds:1,fingerprint:'x'},'identify',undefined,AbortSignal.timeout(1000)),'original local');assert.deepEqual(body.tools,[{googleSearch:{}}]);assert.equal(client.takeSearch()?.used,true);
});
test('native cache followup fresh question, no answer replay, owner isolation, unused has no page',async()=>{
 let calls=0;const client=new GeminiVideoClient(settings,(async()=>{calls++;return new Response(wire(calls===1),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch);
 const c=new GeminiYouTubeCache(),uri='https://www.youtube.com/watch?v=8jppMQSi_rE';let metadata=0;
 const m=async()=>{metadata++;return 90;},f=async()=>{throw new Error('no fallback');};
 const a=await c.watch('one','s',uri,undefined,'q1',client,m,f);assert(a.search?.used);assert(!a.text.includes('Original answer'));assert.equal(a.search?.original,'Original answer');
 const b=await c.watch('one','s',uri,undefined,'q2',client,m,f);assert.equal(b.search?.used,false);assert(b.text.includes('Original answer'));assert.equal(metadata,1);assert.equal(calls,2);
 await c.watch('two','s',uri,undefined,'q3',client,m,f);assert.equal(metadata,2);
});
test('toggle strict/off wire zero search and malformed metadata bounded',async()=>{
 assert.throws(()=>geminiVideoSettings({GEMINI_VIDEO_KEY:'x',GEMINI_VIDEO_MODEL:'x',GEMINI_VIDEO_BASE_URL:'https://provider.example',GEMINI_VIDEO_GOOGLE_SEARCH:'yes'}));
 let body:any;const client=new GeminiVideoClient({...settings,grounding:false},(async(_u,i)=>{body=JSON.parse(String(i?.body));return new Response(wire(false),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch);
 await client.answerURI('https://www.youtube.com/watch?v=8jppMQSi_rE',90,undefined,'q',AbortSignal.timeout(1000));assert.equal(body.tools,undefined);assert.equal(client.takeSearch(),undefined);
 assert.throws(()=>new SearchCollector().step({type:'google_search_result',result:new Array(33)}));
 assert.throws(()=>new GroundingPages('http://insecure',()=>true));
 assert.equal(groundingHeaders['Cache-Control'],'no-store');
});

test('documented search start without result, final model output authoritative and completion usage',async()=>{
 const stream=event('step.start',{index:0,step:{type:'google_search_result'}})+event('step.delta',{index:0,delta:{type:'google_search_result',result:[{search_suggestions:html}]}})+event('step.start',{index:1,step:{type:'model_output',content:[]}})+event('step.delta',{index:1,delta:{type:'text',text:'intermediate answer'}})+event('step.start',{index:2,step:{type:'model_output',content:[]}})+event('step.delta',{index:2,delta:{type:'text',text:'Final answer'}})+event('interaction.completed',{interaction:{status:'completed',steps:[{type:'google_search_call',arguments:{queries:['example']}},{type:'model_output',content:[{type:'text',text:'Final answer',annotations:[{type:'url_citation',url:'https://example.com',start_index:0,end_index:5}]}]}],usage:{total_input_tokens:80,total_output_tokens:20}}});
 const client=new GeminiVideoClient(settings,(async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})) as typeof fetch);
 assert.equal(await client.answerURI('https://www.youtube.com/watch?v=8jppMQSi_rE',90,undefined,'q',AbortSignal.timeout(1000)),'Final answer');const r=client.takeSearch()!;assert(r.used&&r.complete);assert.equal(r.sources.length,1);assert.deepEqual(r.queries,['example']);assert.equal(r.usage.total_output_tokens,20);
});
