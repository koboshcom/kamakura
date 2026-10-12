import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSession,type Backend,type VoiceSessionHooks} from '../src/discord-voice-session.js';
import {voiceConfig} from '../src/discord-voice-config.js';
import type {ClientEvent,ServerEvent} from 'openai/resources/live/live';
const env={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'test',OPENAI_LIVE_BASE_URL:'https://api.openai.com/v1',OPENAI_LIVE_MODEL:'gpt-live-1',OPENAI_LIVE_API_KEY:'test',DISCORD_VOICE_BACKEND_BASE_URL:'https://example.test/v1',DISCORD_VOICE_BACKEND_API_KEY:'test',DISCORD_VOICE_BACKEND_MODEL:'test',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:'111111111111111111',DISCORD_VOICE_OWNER_IDS:'{"111111111111111111":"1"}'};
const flush=()=>new Promise<void>(r=>setImmediate(r));
function fixture(backend:Backend=async()=> 'done',hooks:VoiceSessionHooks={}){
 const sends:ClientEvent[]=[],ipc:any[]=[],reasons:string[]=[];let seq=0,throwReply=false,authorized=true,buffer=0;
 const s=new VoiceSession(voiceConfig(env),{send:e=>{if(throwReply&&e.type==='session.commentary.append')throw new Error('private failure');sends.push(e);},close:()=>{},buffered:()=>buffer},e=>ipc.push(e),()=>authorized,backend,'test',()=>{},{...hooks,diagnostic:r=>reasons.push(r)});
 const event=(e:any)=>s.event(e as ServerEvent);
 s.start();event({type:'session.started'});
 const mic=()=>s.input({type:'audio',seq:seq++,speech:false,pcm:Buffer.alloc(960).toString('base64')});
 const fragment=()=>event({type:'session.input_transcript.delta',event_id:'f',start_ms:0,end_ms:1,delta:'current request'});
 const delegate=(id='id',extra:any={})=>event({type:'session.delegation.created',offset_ms:1,delegation:{id,target:'client'},...extra});
 const replies=()=>sends.filter(e=>e.type==='session.commentary.append') as Extract<ClientEvent,{type:'session.commentary.append'}>[];
 const healthy=()=>{mic();assert.equal(s.state,'active');assert.equal(sends.some(e=>e.type==='session.close'),false);assert.equal(ipc.some(e=>e.type==='end'),false);};
 return {s,sends,ipc,reasons,event,mic,fragment,delegate,replies,healthy,throwReply:(v:boolean)=>throwReply=v,authorize:(v:boolean)=>authorized=v,buffer:(v:number)=>buffer=v};
}
for(const [label,backend] of [
 ['main/tool error',async()=>{throw new Error('PRIVATE DO NOT LEAK');}],
 ['empty result',async()=> ''],
 ['oversized result',async()=> 'x'.repeat(5000)],
 ['malformed result',async()=> null as unknown as string],
] as Array<[string,Backend]>){
 test(label+' gets one correlated honest fallback with mic/playback recovery',async()=>{
  const f=fixture(backend);try{f.fragment();f.delegate();await flush();f.healthy();assert.equal(f.replies().length,1);assert.equal(f.replies()[0]!.delegation_id,'id');assert.doesNotMatch(f.replies()[0]!.content,/PRIVATE|DO NOT LEAK/);assert.match(f.replies()[0]!.content,/cannot confirm/);
   f.event({type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')});(f.s as any).pace();assert.equal(f.ipc.filter(e=>e.type==='audio').length,1);
  }finally{f.s.disconnected();}
 });
}
test('timeout aborts work, keeps call alive, suppresses late results and tracks incomplete cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let resolve!:(s:string)=>void,signal!:AbortSignal;
 const f=fixture(async(_p,s)=>{signal=s;return await new Promise<string>(r=>resolve=r);});
 try{f.fragment();f.delegate('timeout');await flush();t.mock.timers.tick(15001);await flush();f.healthy();assert.equal(signal.aborted,true);assert.equal(f.s.backendClean,false);assert.match(f.replies()[0]!.content,/timed out/);assert.equal(f.replies()[0]!.delegation_id,'timeout');
  f.delegate('blocked');await flush();assert.match(f.replies()[1]!.content,/still stopping/);
  resolve('stale success');await flush();assert.equal(f.s.backendClean,true);assert.equal(f.replies().length,2);f.healthy();
 }finally{f.s.disconnected();t.mock.timers.reset();}
});
test('cooperative timeout releases busy for repeated correlated success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let n=0;
 const f=fixture(async(_p,s)=>++n===1?await new Promise<string>((_,reject)=>s.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})):'second success');
 try{f.fragment();f.delegate('first');await flush();t.mock.timers.tick(15001);await flush();f.healthy();f.delegate('second');await flush();assert.deepEqual(f.replies().map(e=>e.delegation_id),['first','second']);assert.equal(f.replies()[1]!.content,'second success');assert.equal(f.s.backendClean,true);}
 finally{f.s.disconnected();t.mock.timers.reset();}
});
test('missing task ignores metadata, malformed correlation drops, duplicate never executes twice',async()=>{
 let n=0;const f=fixture(async()=>{n++;return 'result';});
 try{f.delegate('missing',{delegation:{id:'missing',target:'client',task:'invented'}});await flush();assert.match(f.replies()[0]!.content,/repeat/);assert.equal(n,0);
  f.event({type:'session.delegation.created'});f.delegate('',{});f.delegate('bad-offset',{offset_ms:NaN});await flush();f.healthy();
  f.fragment();f.delegate('real');await flush();f.delegate('real');await flush();assert.equal(n,1);assert.equal(f.replies().filter(e=>e.delegation_id==='real').length,1);
 }finally{f.s.disconnected();}
});
test('reply write failure and backpressure are nonfatal and bounded, next ID recovers',async()=>{
 const f=fixture();try{f.fragment();f.throwReply(true);f.delegate('failed');await flush();f.healthy();assert.equal(f.replies().length,0);assert.ok(f.reasons.includes('delegation_reply_unavailable'));
  f.throwReply(false);f.buffer(20000);f.delegate('backpressure');await flush();f.buffer(0);f.healthy();assert.equal(f.replies().length,0);
  f.delegate('recovery');await flush();f.healthy();assert.equal(f.replies()[0]!.delegation_id,'recovery');
 }finally{f.s.disconnected();}
});
test('correlated invalid reply error is nonfatal, unmatched/session/auth errors still fail closed',async()=>{
 const f=fixture();try{f.fragment();f.delegate();await flush();f.event({type:'error',error:{code:'invalid_value',client_event_id:f.replies()[0]!.event_id}});f.healthy();assert.ok(f.reasons.includes('delegation_reply_rejected'));
  f.event({type:'error',error:{code:'invalid_value',client_event_id:'foreign'}});assert.equal(f.s.stopReason,'provider_error');
 }finally{f.s.disconnected();}
 const g=fixture();try{g.fragment();g.delegate();await flush();g.event({type:'error',error:{code:'invalid_api_key',client_event_id:g.replies()[0]!.event_id}});assert.equal(g.s.stopReason,'provider_error');}finally{g.s.disconnected();}
});
test('teardown cancels work and no stale result or fallback is sent after call',async()=>{
 let resolve!:(s:string)=>void,signal!:AbortSignal;const f=fixture(async(_p,s)=>{signal=s;return await new Promise<string>(r=>resolve=r);});
 f.fragment();f.delegate();await flush();f.s.disconnected();assert.equal(signal.aborted,true);resolve('postcall private success');await flush();assert.equal(f.replies().length,0);assert.equal(f.s.backendClean,true);
});
test('native main hook failure uses same correlation without leaking exception',async()=>{
 const f=fixture(undefined,{delegate:async()=>{throw new Error('other owner secret');}});try{f.fragment();f.delegate('native');await flush();f.healthy();assert.equal(f.replies()[0]!.delegation_id,'native');assert.doesNotMatch(f.replies()[0]!.content,/other owner secret/);}finally{f.s.disconnected();}
});
test('valid output burst reproduces old 9600-byte overflow but now flushes within cap',()=>{
 const f=fixture();try{for(let i=0;i<30;i++){f.event({type:'session.output_audio.delta',delta:Buffer.alloc(3840).toString('base64')});f.healthy();assert.ok((f.s as any).output.length<=9600);}
  assert.ok(f.reasons.includes('output_backlog_flushed'));f.event({type:'session.output_audio.delta',delta:'not-pcm'});assert.equal(f.s.stopReason,'output_format_or_overflow');
 }finally{f.s.disconnected();}
});
