import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceConfig} from '../src/discord-voice-config.js';
import {VoiceLines,pcm} from '../src/discord-voice-protocol.js';
import {VoiceSession,type VoiceWire,type Backend} from '../src/discord-voice-session.js';
import type {ServerEvent,ClientEvent} from 'openai/resources/live/live';
const self='222222222222222222',user='111111111111111111';
const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:self,DISCORD_VOICE_USER_TOKEN:'test-only',OPENAI_LIVE_API_KEY:'test-only',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:user,DISCORD_VOICE_OWNER_IDS:JSON.stringify({[user]:'1'})};
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
test('barge-in drops queued output, sends close and ignores future provider audio',()=>{
 const f=fixture();active(f);f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')}));
 f.session.input({type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:true});assert.equal(f.session.state,'closing');
 f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')}));assert.equal(f.ipc.filter(x=>x.type==='audio').length,0);
 assert.equal(f.sends.at(-1)?.type,'session.close');f.session.disconnected();
});
test('oversized provider audio and transcript retention reject',()=>{
 const f=fixture();active(f);f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(10000).toString('base64')}));assert.equal(f.session.state,'closing');f.session.disconnected();
 const g=fixture();active(g);g.session.event(event({type:'session.input_transcript.delta',event_id:'a',delta:'x'.repeat(4001),start_ms:0,end_ms:1}));assert.equal(g.session.state,'closing');g.session.disconnected();
});
test('local freshness watchdog ends call without input heartbeats',async()=>{
 const f=fixture();active(f);await new Promise(r=>setTimeout(r,260));assert.equal(f.session.state,'closing');f.session.disconnected();
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
 f.session.event(event({type:'session.input_transcript.delta',event_id:'b',delta:'new',start_ms:1,end_ms:2}));
 assert.equal(signal?.aborted,true);resolve('late');await new Promise(r=>setImmediate(r));assert.equal(f.sends.some(e=>e.type==='session.commentary.append'),false);f.session.disconnected();
});
test('duplicate delegation, excessive backend output and instruction budget fail closed',async()=>{
 const f=fixture();active(f);const d=event({type:'session.delegation.created',offset_ms:0,delegation:{id:'d',target:'client'}});f.session.event(d);await new Promise(r=>setImmediate(r));f.session.event(d);assert.equal(f.session.state,'closing');f.session.disconnected();
 const g=fixture(async()=> 'x'.repeat(4097));active(g);g.session.event(event({type:'session.input_transcript.delta',event_id:'a',delta:'request',start_ms:0,end_ms:1}));g.session.event(d);await new Promise(r=>setImmediate(r));assert.equal(g.session.state,'closing');g.session.disconnected();
});
test('exact frames are paced at 20ms and health is separate from PCM',async()=>{
 const f=fixture();active(f);f.session.input({type:'audio',seq:0,pcm:Buffer.alloc(960).toString('base64'),speech:false});
 f.session.event(event({type:'session.output_audio.delta',delta:Buffer.alloc(1920).toString('base64')}));await new Promise(r=>setTimeout(r,65));
 assert.equal(f.ipc.filter(e=>e.type==='audio').length,2);assert.ok(f.ipc.some(e=>e.type==='health'));f.session.disconnected();
});
