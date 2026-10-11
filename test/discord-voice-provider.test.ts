import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {voiceConfig} from '../src/discord-voice-config.js';
import {providerApiKey} from '../src/provider-key.js';
import {createVoiceLive} from '../src/discord-voice-provider.js';
import {VoiceSession} from '../src/discord-voice-session.js';

const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'offline-discord',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:'111111111111111111',DISCORD_VOICE_OWNER_IDS:'{"111111111111111111":"1"}',OPENAI_API_KEY:'offline-main'};
test('voice credential precedence matches the effective shared main provider key',()=>{
 assert.equal(providerApiKey({PROVIDER_API_KEY:'preferred',OPENAI_API_KEY:'legacy'}),'preferred');
 assert.equal(providerApiKey({PROVIDER_API_KEY:' ',OPENAI_API_KEY:'legacy'}),'legacy');
 for(const value of [undefined,'',' '])assert.equal(voiceConfig({...env,PROVIDER_API_KEY:'preferred',OPENAI_LIVE_API_KEY:value}).apiKey,'preferred');
 assert.equal(voiceConfig({...env,PROVIDER_API_KEY:'preferred',OPENAI_LIVE_API_KEY:'voice'}).apiKey,'voice');
 assert.throws(()=>voiceConfig({...env,OPENAI_API_KEY:''}));
 assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_API_KEY:'invalid\r\nheader'}));
});
test('Live defaults, derived base paths, exact endpoints and operator private hosts',()=>{
 const cfg=voiceConfig(env);assert.equal(cfg.baseUrl,'https://api.openai.com/v1');assert.equal(cfg.endpoint,'wss://api.openai.com/v1/live/sessions');assert.equal(cfg.model,'gpt-live-1');
 assert.equal(voiceConfig({...env,OPENAI_LIVE_BASE_URL:'http://127.0.0.1:54321/custom/'}).endpoint,'ws://127.0.0.1:54321/custom/live/sessions');
 for(const [raw,normalized] of [['http://10.0.0.2:54321/socket/','ws://10.0.0.2:54321/socket/'],['https://voice.internal/socket','wss://voice.internal/socket'],['ws://localhost/socket','ws://localhost/socket'],['wss://voice.internal/socket','wss://voice.internal/socket']]){
  assert.equal(voiceConfig({...env,OPENAI_LIVE_ENDPOINT:raw}).endpoint,normalized);
 }
});
test('provider URL errors are sanitized and credential/query/control inputs reject',()=>{
 for(const name of ['OPENAI_LIVE_BASE_URL','OPENAI_LIVE_ENDPOINT']){
  for(const value of ['file:///private','ftp://example.test','https://user:secret@example.test/x','https://example.test/x?api_key=secret','https://example.test/x#secret','https://example.test/?','https://example.test/#','https://example.test/\r\nsecret',' https://example.test/','https://example.test/\\secret']){
   assert.throws(()=>voiceConfig({...env,[name]:value}),error=>error instanceof Error&&error.message==='Invalid voice provider URL');
  }
 }
 assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_BASE_URL:'ws://localhost/v1'}));
 for(const model of ['',' ','bad\nmodel','x'.repeat(201)])assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_MODEL:model}),/Invalid voice provider configuration/);
 assert.equal(voiceConfig({OPENAI_LIVE_ENDPOINT:'bad',OPENAI_LIVE_MODEL:''}).enabled,false);
});
test('configured model reaches actual session.start while delegation and instructions remain unchanged',()=>{
 const cfg=voiceConfig({...env,OPENAI_LIVE_MODEL:'self-host-live'});
 let first:unknown;const session=new VoiceSession(cfg,{send:event=>{first??=event;},close:()=>{},buffered:()=>0},()=>{},()=>true,async()=>'', 'unchanged instructions',()=>{});
 try{session.start();assert.deepEqual(first,{type:'session.start',session:{model:'self-host-live',store:false,audio:{format:{type:'audio/pcm',rate:24000},output:{voice:'marin'}},delegation:{type:'client'},instructions:'unchanged instructions'}});}finally{session.disconnected();}
});
test('actual LiveWS uses exact local endpoint, Bearer header only, and unchanged Live events',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 const cfg=voiceConfig({...env,OPENAI_LIVE_ENDPOINT:'ws://127.0.0.1:'+port+'/custom-socket'});
 const connected=once(server,'connection');
 const live=createVoiceLive(cfg);live.on('error',()=>{});
 try{
  const [peer,req]=await connected;
  assert.equal(req.url,'/custom-socket');assert.equal(req.headers.authorization,'Bearer offline-main');
  assert.equal(req.headers['openai-organization'],undefined);assert.equal(req.headers['openai-project'],undefined);
  const message=once(peer,'message');live.send({type:'session.start',session:{model:cfg.model}});
  assert.equal(JSON.parse(String((await message)[0])).type,'session.start');
 }finally{live.close();for(const peer of server.clients)peer.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('LiveWS never forwards credentials through an HTTP redirect',async()=>{
 let targetHits=0;const target=createServer((_req,res)=>{targetHits++;res.end();});
 await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
 const redirect=createServer((_req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:'+(target.address() as {port:number}).port+'/stolen'});res.end();});
 await new Promise<void>(resolve=>redirect.listen(0,'127.0.0.1',resolve));
 const live=createVoiceLive(voiceConfig({...env,OPENAI_LIVE_ENDPOINT:'http://127.0.0.1:'+(redirect.address() as {port:number}).port+'/redirect'}));
 try{await once(live,'error');assert.equal(targetHits,0);}finally{
  live.close();await Promise.all([target,redirect].map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})));
 }
});
