import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {voiceConfig} from '../src/discord-voice-config.js';
import {createVoiceLive} from '../src/discord-voice-provider.js';
import {createVoiceBackend} from '../src/discord-voice-service.js';
import {VoiceSession} from '../src/discord-voice-session.js';

const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_PROVIDER:'xai',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'offline-discord',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:'111111111111111111',DISCORD_VOICE_OWNER_IDS:'{"111111111111111111":"1"}',XAI_VOICE_API_KEY:'offline-xai',DISCORD_VOICE_BACKEND_BASE_URL:'https://backend.example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'offline-backend',DISCORD_VOICE_BACKEND_MODEL:'backend-model'};
test('xAI isolated defaults, exact endpoint and selected key validation',()=>{
 const cfg=voiceConfig(env);assert.equal(cfg.model,'grok-voice-3.0');assert.equal(cfg.endpoint,'wss://api.x.ai/v1/realtime?model=grok-voice-3.0');assert.equal(cfg.voice,'Eve');assert.equal(cfg.backendApiKey,'offline-backend');
 assert.equal(voiceConfig({...env,XAI_VOICE_ENDPOINT:cfg.endpoint}).endpoint,cfg.endpoint);
 assert.throws(()=>voiceConfig({...env,XAI_VOICE_API_KEY:'',OPENAI_LIVE_API_KEY:'do-not-inherit',OPENAI_API_KEY:'do-not-inherit'}),/XAI_VOICE_API_KEY/);
 for(const endpoint of ['wss://u:secret@host/realtime','wss://host/realtime?api_key=secret','wss://host/realtime?model=other','wss://host/realtime?model=grok-voice-3.0#secret',' wss://host/realtime','wss://host/realtime?model=grok-voice-3.0&x=y']){
  assert.throws(()=>voiceConfig({...env,XAI_VOICE_ENDPOINT:endpoint}),/XAI_VOICE_ENDPOINT/);
 }
 assert.throws(()=>voiceConfig({...env,DISCORD_VOICE_PROVIDER:'invalid'}),/DISCORD_VOICE_PROVIDER/);
 assert.throws(()=>voiceConfig({...env,DISCORD_VOICE_BACKEND_PROVIDER:'invalid'}),/DISCORD_VOICE_BACKEND_PROVIDER/);
 assert.throws(()=>voiceConfig({...env,DISCORD_VOICE_BACKEND_API_KEY:''}),/DISCORD_VOICE_BACKEND_API_KEY/);
 assert.equal(voiceConfig({DISCORD_VOICE_PROVIDER:'invalid',XAI_VOICE_API_KEY:'bad\nkey'}).enabled,false);
});
async function fixture(){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const cfg=voiceConfig({...env,XAI_VOICE_ENDPOINT:'ws://127.0.0.1:'+(server.address() as {port:number}).port+'/realtime'});
 const connected=once(server,'connection'),live=createVoiceLive(cfg);live.on('error',()=>{});
 const opened=new Promise<void>(r=>live.socket.on('open',r));
 const [peer,request]=await connected;await opened;
 const sent:Record<string,any>[]=[];peer.on('message',(raw:Buffer)=>sent.push(JSON.parse(String(raw))));
 const events:Record<string,any>[]=[];live.on('event',e=>events.push(e));
 const send=(e:unknown)=>peer.send(JSON.stringify(e));
 const sync=async()=>{
  if(peer.readyState!==1)return;
  await new Promise<void>((resolve,reject)=>{
   const done=()=>{clearTimeout(timer);peer.off('pong',done);peer.off('close',done);resolve();};
   const timer=setTimeout(()=>{peer.off('pong',done);peer.off('close',done);reject(new Error('fixture socket sync timeout'));},1000);
   peer.once('pong',done);peer.once('close',done);peer.ping();
  });
  await new Promise<void>(r=>setImmediate(r));
 };
 const start=async()=>{
  live.send({type:'session.start',session:{model:cfg.model,instructions:'private instructions'}});
  await sync();send({type:'session.created'});send({type:'session.updated',session:{model:cfg.model,audio:{input:{format:{type:'audio/pcm',rate:24000}},output:{format:{type:'audio/pcm',rate:24000}}}}});await sync();
 };
 const cleanup=async()=>{live.close();for(const client of server.clients)client.close(1000);await new Promise<void>(resolve=>server.close(()=>resolve()));};
 return {cfg,live,peer,request,sent,events,send,sync,start,cleanup};
}
test('actual local socket maps configuration/audio and never forwards GPT Live events',async()=>{
 const f=await fixture();try{
  assert.equal(f.request.url,'/realtime?model=grok-voice-3.0');assert.equal(f.request.headers.authorization,'Bearer offline-xai');
  assert.equal(f.request.headers['openai-project'],undefined);assert.equal(f.request.headers['openai-organization'],undefined);
  await f.start();const session=f.sent[0]!.session;
  assert.equal(f.sent[0]!.type,'session.update');assert.equal(session.model,'grok-voice-3.0');assert.equal(session.instructions,'private instructions');
  assert.deepEqual(session.audio.output,{format:{type:'audio/pcm',rate:24000},transport:'json'});assert.deepEqual(session.resumption,{enabled:false});
  assert.equal(session.tools.length,1);assert.equal(session.tools[0].name,'delegate_current_request');assert.equal(f.events[0]!.type,'session.started');
  const audio=Buffer.alloc(960).toString('base64');f.live.send({type:'session.input_audio.append',audio});await f.sync();
  assert.deepEqual(f.sent[1],{type:'input_audio_buffer.append',audio});
  f.send({type:'response.created',response:{id:'response_1'}});
  f.send({type:'response.output_audio.delta',response_id:'response_1',delta:audio});await f.sync();
  assert.equal(f.events.at(-1)!.type,'session.output_audio.delta');
  f.live.send({type:'session.instructions.append',delegation_id:null,content:'stop'});await f.sync();
  assert.deepEqual(f.sent.at(-1),{type:'response.cancel',response_id:'response_1'});
  const n=f.events.length;f.send({type:'response.output_audio.delta',response_id:'response_1',delta:audio});await f.sync();assert.equal(f.events.length,n);
 }finally{await f.cleanup();}
});
test('cumulative corrections are not appended; only completed transcripts captured once',async()=>{
 const f=await fixture();try{
  await f.start();
  f.send({type:'input_audio_buffer.speech_started',item_id:'input_1'});
  f.send({type:'conversation.item.input_audio_transcription.updated',item_id:'input_1',transcript:'delete'});
  f.send({type:'conversation.item.input_audio_transcription.updated',item_id:'input_1',transcript:'do not delete'});
  f.send({type:'input_audio_buffer.speech_stopped',item_id:'input_1'});
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'input_1',transcript:'do not delete'});
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'input_1',transcript:'do not delete'});
  f.send({type:'response.created',response:{id:'response_1'}});
  f.send({type:'response.output_audio_transcript.done',item_id:'output_1',response_id:'response_1',transcript:'okay'});
  await f.sync();
  const transcripts=f.events.filter(e=>e.type.includes('transcript'));assert.deepEqual(transcripts.map(e=>e.delta),['do not delete','okay']);
  assert.ok(transcripts.every(e=>e.start_ms>=0&&e.end_ms>=e.start_ms));
 }finally{await f.cleanup();}
});
test('function calls use captured history, dedupe IDs and do not fabricate acknowledgements',async()=>{
 const f=await fixture();try{
  await f.start();f.send({type:'response.created',response:{id:'response_1'}});const call={type:'response.function_call_arguments.done',response_id:'response_1',call_id:'call_1',name:'delegate_current_request',arguments:'{}'};
  f.send(call);f.send(call);await f.sync();assert.equal(f.events.filter(e=>e.type==='session.delegation.created').length,1);
  f.live.send({type:'session.commentary.append',delegation_id:'call_1',content:'result',event_id:'reply'});await f.sync();
  assert.deepEqual(f.sent.slice(-2),[{type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_1',output:'result'}},{type:'response.create'}]);
  assert.ok(!f.events.some(e=>e.type==='session.commentary.appended'));
  assert.throws(()=>f.live.send({type:'session.commentary.append',delegation_id:'foreign',content:'bad'}));
 }finally{await f.cleanup();}
});
test('malformed function arguments, wrong audio and provider errors fail closed',async()=>{
 for(const event of [
  {type:'response.function_call_arguments.done',response_id:'response_1',call_id:'call_1',name:'delegate_current_request',arguments:'{"request":"untrusted command"}'},
  {type:'response.output_audio.delta',response_id:'response_1',delta:'bad'},
  {type:'error',error:{message:'secret key must never escape',code:'secret'}}
 ]){
  const f=await fixture();try{await f.start();f.send({type:'response.created',response:{id:'response_1'}});f.send(event);await f.sync();assert.equal(f.events.at(-1)!.type,'error');assert.ok(!JSON.stringify(f.events).includes('secret'));}finally{await f.cleanup();}
 }
});
test('clean WebSocket close is reusable locally but never synthesizes session.closed',async()=>{
 const f=await fixture();try{
  await f.start();const closed=once(f.live,'close');f.live.send({type:'session.close'});await closed;
  assert.equal(f.live.locallyClosed,true);assert.ok(!f.events.some(e=>e.type==='session.closed'));
 }finally{await f.cleanup();}
});
test('xAI redirects do not forward Authorization',async()=>{
 let hits=0;const target=createServer((_req,res)=>{hits++;res.end();});await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
 const redirect=createServer((_req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:'+(target.address() as {port:number}).port});res.end();});await new Promise<void>(r=>redirect.listen(0,'127.0.0.1',r));
 const live=createVoiceLive(voiceConfig({...env,XAI_VOICE_ENDPOINT:'ws://127.0.0.1:'+(redirect.address() as {port:number}).port}));
 try{await once(live,'error');assert.equal(hits,0);}finally{live.close();await Promise.all([target,redirect].map(s=>new Promise<void>(r=>s.close(()=>r()))));}
});
test('existing VoiceSession gates xAI startup and rejects unconfirmed backend cleanup',()=>{
 const cfg=voiceConfig(env),sent:unknown[]=[],out:unknown[]=[];
 const session=new VoiceSession(cfg,{send:e=>{sent.push(e);},close:()=>{},buffered:()=>0},e=>{out.push(e);},()=>true,async()=>'', 'offline',()=>{});
 try{session.start();assert.equal((sent[0] as any).type,'session.start');session.event({type:'session.started'} as any);assert.deepEqual(out,[{type:'ready'}]);assert.equal(session.finalized,false);assert.equal(session.backendClean,true);}finally{session.disconnected();}
});


test('xAI backend uses only independent chat-completions triplet',async()=>{
 const requests:Array<{url:string;authorization:string|undefined;body:any}>=[];
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{
   requests.push({url:req.url!,authorization:req.headers.authorization,body:JSON.parse(body)});
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({id:'offline',object:'chat.completion',created:1,model:'backend-model',choices:[{index:0,message:{role:'assistant',content:'backend answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const cfg=voiceConfig({...env,DISCORD_VOICE_BACKEND_PROVIDER:'xai',DISCORD_VOICE_BACKEND_BASE_URL:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1'});
  assert.equal(await createVoiceBackend(cfg)('offline prompt',new AbortController().signal),'backend answer');
  assert.equal(requests.length,1);assert.equal(requests[0]!.url,'/v1/chat/completions');
  assert.equal(requests[0]!.authorization,'Bearer offline-backend');assert.equal(requests[0]!.body.model,'backend-model');
  assert.equal(JSON.stringify(requests).includes('offline-xai'),false);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('xAI refuses mismatched session audio or model and never marks failure reusable',async()=>{
 for(const session of [
  {model:'grok-voice-latest'},
  {model:'grok-voice-3.0',audio:{output:{format:{type:'audio/pcm',rate:48000}}}}
 ]){
  const f=await fixture();
  try{
   f.live.send({type:'session.start',session:{model:f.cfg.model,instructions:'offline'}});
   const closed=once(f.live,'close');f.send({type:'session.updated',session});await closed;
   assert.equal(f.live.locallyClosed,false);assert.ok(f.events.some(e=>e.type==='error'));assert.ok(!f.events.some(e=>e.type==='session.started'));
  }finally{await f.cleanup();}
 }
});
test('xAI stale response audio, transcript and functions cannot leak after a replacement',async()=>{
 const f=await fixture();try{
  await f.start();
  f.send({type:'response.created',response:{id:'old'}});
  f.send({type:'response.created',response:{id:'new'}});
  const n=f.events.length;
  f.send({type:'response.output_audio.delta',response_id:'old',delta:Buffer.alloc(960).toString('base64')});
  f.send({type:'response.output_audio_transcript.done',response_id:'old',item_id:'old_item',transcript:'stale'});
  f.send({type:'response.function_call_arguments.done',response_id:'old',call_id:'old_call',name:'delegate_current_request',arguments:'{}'});
  await f.sync();assert.equal(f.events.length,n);
  f.send({type:'response.done',response:{id:'new',status:'completed'}});
  f.send({type:'response.output_audio.delta',response_id:'new',delta:Buffer.alloc(960).toString('base64')});
  await f.sync();assert.equal(f.events.length,n);
 }finally{await f.cleanup();}
});
test('xAI abnormal remote close does not count as local clean closure',async()=>{
 const f=await fixture();try{
  await f.start();const closed=once(f.live,'close');f.peer.terminate();await closed;
  assert.equal(f.live.locallyClosed,false);
 }finally{await f.cleanup();}
});
