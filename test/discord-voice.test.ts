import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceConfig} from '../src/discord-voice-config.js';
import {VoiceLines,pcm} from '../src/discord-voice-protocol.js';
import {VoiceSession,type VoiceWire,type Backend} from '../src/discord-voice-session.js';
import type {ServerEvent,ClientEvent} from 'openai/resources/live/live';
const self='222222222222222222',user='111111111111111111';
const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_USER_TOKEN:'test-only',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',DISCORD_VOICE_BACKEND_BASE_URL:'https://backend.example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'offline-backend',DISCORD_VOICE_BACKEND_MODEL:'backend-model',OPENAI_LIVE_API_KEY:'test-only',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'1'})};
test('voice disabled ignores absent credentials and owner map',()=>{
 assert.equal(voiceConfig({}).enabled,false);assert.equal(voiceConfig({DISCORD_VOICE_ENABLED:'false',DISCORD_VOICE_OWNER_IDS:'bad'}).enabled,false);
 assert.throws(()=>voiceConfig({DISCORD_VOICE_ENABLED:'yes'}));
});
test('voice requires canonical explicit owners, separate self and bounded duration',()=>{
 assert.equal(voiceConfig(env).owners.get(user),'1');
 for(const patch of [{SANDBOX_ALLOWED_USERS:'*'},{SANDBOX_ALLOWED_USERS:'2'},{DISCORD_VOICE_OWNER_IDS:'{}'},{DISCORD_VOICE_SELF_ID:user},{DISCORD_VOICE_ALLOWED_USERS:'01'},{DISCORD_VOICE_MAX_SECONDS:'301'},{DISCORD_VOICE_MAX_SECONDS:'NaN'},{DISCORD_VOICE_IPC_DIR:'relative'},{DISCORD_VOICE_PYTHON:'python'},{OPENAI_LIVE_API_KEY:''},{DISCORD_VOICE_USER_TOKEN:''},{DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'01'})}])assert.throws(()=>voiceConfig({...env,...patch}));
});
test('bounded IPC parser handles split lines and rejects huge/invalid/burst data',()=>{
 const parser=new VoiceLines();assert.deepEqual(parser.feed(Buffer.from('{"x":')),[]);assert.deepEqual(parser.feed(Buffer.from('1}\n{"y":2}\n')),[{x:1},{y:2}]);
 assert.throws(()=>parser.feed(Buffer.alloc(8193,65)));
 assert.throws(()=>new VoiceLines().feed(Buffer.from('garbage\n')));
 assert.throws(()=>new VoiceLines().feed(Buffer.from('{}\n'.repeat(129))));
});
test('PCM accepts exact canonical 20ms frames only',()=>{
 assert.equal(pcm(Buffer.alloc(960).toString('base64')).length,960);
 for(const v of ['',Buffer.alloc(959).toString('base64'),Buffer.alloc(961).toString('base64'),'!'.repeat(1280),null])assert.throws(()=>pcm(v));
});
const event=(x:Record<string,unknown>)=>x as unknown as ServerEvent;
function fixture(backend:Backend=async()=> 'short answer'){
 const sends:ClientEvent[]=[],ipc:Record<string,unknown>[]=[];let auth=true,closed=0,ended=0,buffer=0;
 const wire:VoiceWire={send:e=>{sends.push(e);},close:()=>{closed++;},buffered:()=>buffer};
 const session=new VoiceSession(voiceConfig(env),wire,e=>ipc.push(e),()=>auth,backend,'short test prompt',()=>{ended++;});
 return {session,sends,ipc,setAuth:(v:boolean)=>{auth=v;},setBuffer:(v:number)=>{buffer=v;},stats:()=>({closed,ended})};
}
function active(f:ReturnType<typeof fixture>){f.session.start();f.session.event(event({type:'session.started'}));}
test('session handshake then identity revocation shuts down and never resumes',()=>{
 const f=fixture();active(f);assert.equal(f.session.state,'active');assert.equal(f.sends[0]?.type,'session.start');
 f.setAuth(false);f.session.input({type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});
 assert.equal(f.session.state,'closing');assert.equal(f.ipc.at(-1)?.type,'end');f.session.disconnected();f.session.disconnected();assert.deepEqual(f.stats(),{closed:1,ended:1});
});
test('sequence, size, backpressure and early audio fail closed',()=>{
 for(const msg of [{type:'audio',seq:1,pcm:Buffer.alloc(960).toString('base64'),speech:false},{type:'audio',seq:0,pcm:'bad',speech:false},{type:'bad'}]){
  const f=fixture();active(f);f.session.input(msg);assert.equal(f.session.state,'closing');f.session.disconnected();
 }
 const f=fixture();f.setBuffer(20000);f.session.start();assert.equal(f.session.state,'closing');f.session.disconnected();
 const g=fixture();g.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')}));assert.equal(g.session.state,'closing');g.session.disconnected();
});
test('best-effort interruptions keep microphone forwarding, flush and resume repeatedly',()=>{
 const f=fixture();active(f);let now=1000;
 const real=Date.now;Date.now=()=>now;
 try{
  const mic=(seq:number,speech:boolean)=>f.session.input({type:'audio',seq,pcm:Buffer.alloc(960).toString('base64'),speech});
  const output=()=>f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')}));
  const pace=()=> (f.session as unknown as {pace():void}).pace();
  output();mic(0,true);assert.equal(f.session.state,'active');pace();
  assert.equal(f.ipc.filter(x=>x.type==='audio').length,0);
  output(); // Old/ambiguous chunks during heuristic hold are dropped.
  now+=100;mic(1,true);assert.equal(f.ipc.filter(x=>x.type==='flush').length,1);
  now+=301;mic(2,false);output();pace();
  assert.equal(f.ipc.filter(x=>x.type==='audio').length,1);
  mic(3,true);assert.equal(f.ipc.filter(x=>x.type==='flush').length,2);
  now+=301;mic(4,false);output();pace();
  assert.equal(f.ipc.filter(x=>x.type==='audio').length,2);
  assert.equal(f.sends.filter(x=>x.type==='session.input_audio.append').length,5);
  assert.equal(f.sends.some(x=>x.type==='session.close'),false);
  // Late old chunks after the hold can play: expressly accepted best-effort policy.
  f.session.event(event({type:'session.closed'}));assert.equal(f.session.finalized,true);
 }finally{Date.now=real;f.session.disconnected();}
});
test('oversized provider audio and transcript retention reject',()=>{
 const f=fixture();active(f);f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(20000).toString('base64')}));assert.equal(f.session.state,'closing');f.session.disconnected();
 const g=fixture();active(g);g.session.event(event({type:'session.input_transcript.delta',event_id:'a',delta:'x'.repeat(4001),start_ms:0,end_ms:1}));assert.equal(g.session.state,'closing');g.session.disconnected();
});
test('local freshness watchdog ends call without input heartbeats',async()=>{
 const f=fixture();active(f);await new Promise(r=>setTimeout(r,260));assert.equal(f.session.state,'closing');assert.equal(f.session.stopReason,'input_heartbeat_stale');f.session.disconnected();
});
test('provider finalized event differs from uncertain disconnect',()=>{
 const f=fixture();active(f);f.session.event(event({type:'session.usage.updated',usage:{seconds:2}}));f.session.disconnected();assert.equal(f.session.finalized,false);assert.equal(f.session.seconds,2);
 const g=fixture();active(g);g.session.event(event({type:'session.closed'}));assert.equal(g.session.finalized,true);assert.equal(g.session.state,'ended');
});
test('backend attaches original delegation id and excludes metadata task guesses',async()=>{
 let prompt='';const f=fixture(async p=>{prompt=p;return 'answer';});active(f);
 f.session.event(event({type:'session.input_transcript.delta',event_id:'input',delta:'what is this',start_ms:1,end_ms:8}));
 f.session.event(event({type:'session.delegation.created',offset_ms:8,delegation:{id:'original-id',target:'client',task:'SHOULD-NOT-INCLUDE'}}));
 await new Promise(r=>setImmediate(r));assert.match(prompt,/what is this/);assert.doesNotMatch(prompt,/SHOULD-NOT-INCLUDE/);
 assert.equal(f.sends.at(-1)?.type,'session.commentary.append');assert.equal((f.sends.at(-1) as {delegation_id:string}).delegation_id,'original-id');f.session.disconnected();
});
test('backend late result is dropped and aborted after newer input',async()=>{
 let resolve!:(x:string)=>void,signal:AbortSignal|undefined;
 const f=fixture(async(_p,s)=>{signal=s;return await new Promise<string>(r=>{resolve=r;});});active(f);
 f.session.event(event({type:'session.input_transcript.delta',event_id:'a',delta:'first',start_ms:0,end_ms:1}));
 f.session.event(event({type:'session.delegation.created',offset_ms:1,delegation:{id:'d',target:'client'}}));
 await new Promise(r=>setImmediate(r));
 f.session.event(event({type:'session.input_transcript.delta',event_id:'b',delta:'new',start_ms:1,end_ms:2}));
 assert.equal(f.session.state,'active');assert.equal(signal?.aborted,true);resolve('late');await new Promise(r=>setImmediate(r));assert.equal(f.sends.some(e=>e.type==='session.commentary.append'),false);f.session.disconnected();
});
test('duplicate delegation and excessive backend output recover without closing',async()=>{
 const f=fixture();active(f);const d=event({type:'session.delegation.created',offset_ms:0,delegation:{id:'d',target:'client'}});f.session.event(d);await new Promise(r=>setImmediate(r));f.session.event(d);assert.equal(f.session.state,'active');f.session.disconnected();
 const g=fixture(async()=> 'x'.repeat(4097));active(g);g.session.event(event({type:'session.input_transcript.delta',event_id:'a',delta:'request',start_ms:0,end_ms:1}));g.session.event(d);await new Promise(r=>setImmediate(r));assert.equal(g.session.state,'active');assert.equal(g.sends.at(-1)?.type,'session.commentary.append');g.session.disconnected();
});
test('exact frames are paced at 20ms and health is separate from PCM',async()=>{
 const f=fixture();active(f);f.session.input({type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});
 f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(1920).toString('base64')}));await new Promise(r=>setTimeout(r,65));
 assert.equal(f.ipc.filter(e=>e.type==='audio').length,2);assert.ok(f.ipc.some(e=>e.type==='health'));f.session.disconnected();
});

test('late socket open after close cannot start a provider session',()=>{
 const f=fixture();f.session.stop();const before=f.sends.length;f.session.start();assert.equal(f.sends.length,before);f.session.disconnected();f.session.start();assert.equal(f.sends.length,before);
});

test('expired output and valid burst backlog flush without hangup',()=>{
 const real=Date.now;let now=1000;Date.now=()=>now;const f=fixture();active(f);
 try{
  const mic=(seq:number)=>f.session.input({type:'audio',seq,pcm:Buffer.alloc(960).toString('base64'),speech:false});
  const out=(n:number)=>f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(n).toString('base64')}));
  mic(0);out(2);now+=250;mic(1);(f.session as unknown as {pace():void}).pace();
  assert.equal(f.ipc.filter(e=>e.type==='flush').length,0);
  now++;mic(2);(f.session as unknown as {pace():void}).pace();
  assert.equal(f.session.state,'active');assert.equal(f.ipc.filter(e=>e.type==='flush').length,1);
  assert.equal(f.ipc.filter(e=>e.type==='audio').length,0);
  out(960);(f.session as unknown as {pace():void}).pace();
  assert.equal(f.ipc.filter(e=>e.type==='audio').length,1);
  out(9600);out(2);assert.equal(f.session.state,'active');
  f.session.event(event({type:'session.closed'}));assert.equal(f.session.stopReason,'provider_session_closed');
 }finally{f.session.disconnected();Date.now=real;}
});

test('continuous replenishment ages oldest remaining bytes, not first queue arrival',()=>{
 const real=Date.now;let now=1000;Date.now=()=>now;const f=fixture();active(f);
 try{
  for(let i=0;i<30;i++){
   f.session.input({type:'audio',seq:i,pcm:Buffer.alloc(960).toString('base64'),speech:false});
   f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(i===0?1920:960).toString('base64')}));
   (f.session as unknown as {pace():void}).pace();
   assert.equal(f.session.state,'active',`healthy continuous stream stopped at tick ${i}, reason ${f.session.stopReason}`);
   now+=20;
  }
  assert.equal(f.ipc.filter(e=>e.type==='audio').length,30);
 }finally{f.session.disconnected();Date.now=real;}
});

test('partial chunk drain retains original byte ages and true backlog never plays',()=>{
 const real=Date.now;let now=1000;Date.now=()=>now;const f=fixture();active(f);
 try{
  const mic=(seq:number)=>f.session.input({type:'audio',seq,pcm:Buffer.alloc(960).toString('base64'),speech:false});
  const out=(n:number)=>f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(n).toString('base64')}));
  const pace=()=> (f.session as unknown as {pace():void}).pace();
  mic(0);out(1440);pace(); // Remaining 480 bytes still belong to original arrival.
  now+=200;mic(1);out(960);
  now+=51;mic(2);pace(); // Entire local backlog flushed, including newer tail.
  assert.equal(f.session.state,'active');assert.equal(f.ipc.filter(e=>e.type==='audio').length,1);
  assert.equal(f.ipc.filter(e=>e.type==='flush').length,1);
  out(9600);now+=251;mic(3);pace();
  assert.equal(f.session.state,'active');assert.equal(f.ipc.filter(e=>e.type==='audio').length,1);
  assert.equal(f.ipc.filter(e=>e.type==='flush').length,2);
 }finally{f.session.disconnected();Date.now=real;}
});

test('playback diagnostics retain only fixed content-free write and queue counters', async () => {
 const {safeVoiceDiagnostic}=await import('../src/discord-voice-service.js');
 const row=safeVoiceDiagnostic({stage:'call_counters',counters:{receive_resyncs:1,output_received_frames:3,output_enqueued_frames:2,output_dequeued_frames:1,output_flushed_frames:1,discord_write_attempts:4,discord_write_frames:3,discord_write_pcm_bytes:11520,discord_write_errors:1,payload:123},attempt:'2a0a98ec4a2d0c4b'});
 assert.equal(row?.counters.discord_write_frames,3);
 assert.equal(row?.counters.discord_write_pcm_bytes,11520);
 assert.equal(row?.counters.receive_resyncs,1);
 assert.equal(row?.counters.payload,undefined);
});
test('local playback timings count genuine frames and reset between sessions',()=>{
 const f=fixture();active(f);
 const pace=()=> (f.session as unknown as {pace():void}).pace();
 f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(1920).toString('base64')}));
 pace();pace();
 assert.equal(f.session.latency.output_queue_n,2);
 assert.ok(f.session.latency.output_queue_max_us>=0);
 f.session.input({type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:true});
 f.session.input({type:'audio',seq:1,pcm:Buffer.alloc(960).toString('base64'),speech:false});
 assert.ok(f.session.latency.classified_speech_end_first_us>=0);
 const g=fixture();assert.deepEqual(g.session.latency,{});
 f.session.disconnected();g.session.disconnected();
});
