import test from 'node:test';
import assert from 'node:assert/strict';
import {sttConfig,transcribeVoiceNote,type STTClock,voiceNoteFailure,VoiceNoteError} from '../src/voice-note.js';

const audio={data:Buffer.alloc(128),duration:1,sourceBytes:128};
const cfg=sttConfig({STT_URL:'https://offline.test',STT_KEY:'offline'});
class FakeClock implements STTClock {
 time=100; due=0; cleared=false; callback?:()=>void;
 now=()=>this.time;
 schedule=(fn:()=>void,ms:number)=>{this.callback=fn;this.due=this.time+ms;return 1 as unknown as ReturnType<typeof setTimeout>;};
 clear=()=>{this.cleared=true;this.callback=undefined;};
 advance(ms:number,fire=true){this.time+=ms;if(fire&&this.time>=this.due)this.callback?.();}
}
for(const seconds of [33,59]){
 test('full valid response at '+seconds+' seconds succeeds on default 60',async()=>{
  const clock=new FakeClock();let requestSignal:AbortSignal|undefined;
  const result=await transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async(_url,init)=>{
   requestSignal=init!.signal!;clock.advance(seconds*1000);return Response.json({text:'complete known words'});
  },clock);
  assert.equal(result.text,'complete known words');assert.equal(result.requestMs,seconds*1000);
  assert.equal(requestSignal!.aborted,false);assert.equal(clock.cleared,true);
 });
}
for(const seconds of [60,61]){
 test('late headers at '+seconds+' seconds abort even before delayed timer runs',async()=>{
  const clock=new FakeClock();let requestSignal:AbortSignal|undefined,cancelled=false;
  await assert.rejects(transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async(_url,init)=>{
   requestSignal=init!.signal!;clock.advance(seconds*1000,false);
   return new Response(new ReadableStream({cancel(){cancelled=true;}}));
  },clock),/stt_timeout/);
  assert.equal(requestSignal!.aborted,true);assert.equal(cancelled,true);assert.equal(clock.cleared,true);
 });
}
for(const seconds of [33,59,60,61]){
 test('headers at 1 second do not finish deadline; full body at '+seconds+' seconds',async()=>{
  const clock=new FakeClock();let requestSignal:AbortSignal|undefined;
  let reads=0,cancelled=false;
  const work=transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async(_url,init)=>{
   requestSignal=init!.signal!;clock.advance(1000);
   return new Response(new ReadableStream({
    pull(controller){
     if(reads++===0){controller.enqueue(new TextEncoder().encode('{"text":"full '));}
     else{clock.advance((seconds-1)*1000,false);controller.enqueue(new TextEncoder().encode('known transcript"}'));/* next read observes EOF */
      controller.close();}
    },cancel(){cancelled=true;}
   },{highWaterMark:0}));
  },clock);
  if(seconds<60){assert.equal((await work).text,'full known transcript');assert.equal(requestSignal!.aborted,false);}
  else{await assert.rejects(work,/stt_timeout/);assert.equal(requestSignal!.aborted,true);}
  assert.equal(clock.cleared,true);
 });
}
for(const timeoutSeconds of [60,15]){
 test('timer aborts hanging actual request at '+timeoutSeconds+' seconds and ignores late success',async()=>{
  const clock=new FakeClock();let requestSignal:AbortSignal|undefined,finish!:(value:Response)=>void,cancelled=false;
  const work=transcribeVoiceNote(audio,{...cfg,requestTimeoutMs:timeoutSeconds*1000},()=>true,new AbortController().signal,async(_url,init)=>{
   requestSignal=init!.signal!;return new Promise<Response>(resolve=>{finish=resolve;});
  },clock);
  clock.advance(timeoutSeconds*1000);
  await assert.rejects(work,/stt_timeout/);assert.equal(requestSignal!.aborted,true);
  finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));await Promise.resolve();await Promise.resolve();
  assert.equal(cancelled,true);assert.equal(clock.cleared,true);
 });
}
test('hanging response body aborts at absolute deadline and cancels reader',async()=>{
 const clock=new FakeClock();let entered!:(v?:unknown)=>void,cancelled=false;const ready=new Promise(resolve=>{entered=resolve;});
 let requestSignal:AbortSignal|undefined;
 const work=transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async(_url,init)=>{
  requestSignal=init!.signal!;clock.advance(1000);
  return new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){cancelled=true;}}));
 },clock);
 await ready;clock.advance(59000);await assert.rejects(work,/stt_timeout/);
 assert.equal(requestSignal!.aborted,true);assert.equal(cancelled,true);assert.equal(clock.cleared,true);
});
test('deadline rechecks final validation even when timer callback is delayed',async()=>{
 const clock=new FakeClock();let checks=0;
 await assert.rejects(transcribeVoiceNote(audio,cfg,()=>{if(++checks===2)clock.advance(60000,false);return true;},new AbortController().signal,async()=>Response.json({text:'late validated text'}),clock),/stt_timeout/);
 assert.equal(clock.cleared,true);
});
test('timeouts expose no provider diagnostics or made-up transcript to Kama',()=>{
 const text=voiceNoteFailure(new VoiceNoteError('stt_http_500'));
 assert.match(text,/Couldn’t hear.*try sending it again/);
 assert.doesNotMatch(text,/stt_|STT_|500|provider|transcript:/);
});
