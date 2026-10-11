import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {voiceConfig} from '../src/discord-voice-config.js';
import {createVoiceLive} from '../src/discord-voice-provider.js';
import {VoiceSession} from '../src/discord-voice-session.js';

const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'offline-discord',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:'111111111111111111',DISCORD_VOICE_OWNER_IDS:'{"111111111111111111":"1"}',OPENAI_LIVE_API_KEY:'offline-live',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',DISCORD_VOICE_BACKEND_BASE_URL:'https://backend.example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'offline-backend',DISCORD_VOICE_BACKEND_MODEL:'backend-model'};
test('Live and backend never inherit main config and endpoint override cannot waive triplets',()=>{
 for(const field of ['OPENAI_LIVE_API_KEY','OPENAI_LIVE_BASE_URL','OPENAI_LIVE_MODEL','DISCORD_VOICE_BACKEND_API_KEY','DISCORD_VOICE_BACKEND_BASE_URL','DISCORD_VOICE_BACKEND_MODEL']){
  assert.throws(()=>voiceConfig({...env,[field]:'',OPENAI_API_KEY:'main',OPENAI_BASE_URL:'https://main.test/v1',OPENAI_MODEL:'main',OPENAI_LIVE_ENDPOINT:'wss://live.test/socket'}),new RegExp(field));
 }
 assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_API_KEY:'invalid\r\nheader'}),/OPENAI_LIVE_API_KEY/);
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
   assert.throws(()=>voiceConfig({...env,[name]:value}),error=>error instanceof Error&&error.message===name);
  }
 }
 assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_BASE_URL:'ws://localhost/v1'}));
 for(const model of ['',' ','bad\nmodel','x'.repeat(201)])assert.throws(()=>voiceConfig({...env,OPENAI_LIVE_MODEL:model}),/OPENAI_LIVE_MODEL/);
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
  assert.equal(req.url,'/custom-socket');assert.equal(req.headers.authorization,'Bearer offline-live');
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

test('retired shared key produces sanitized migration error without reusing it',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"const {validateStartupProviders}=await import('./src/provider-startup.ts');validateStartupProviders();"],{env:{...process.env,DOTENV_CONFIG_PATH:'/nonexistent-provider-test',PROVIDER_API_KEY:'private-retired-value'},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/PROVIDER_API_KEY/);assert.doesNotMatch(result.stderr,/private-retired-value/);
});
