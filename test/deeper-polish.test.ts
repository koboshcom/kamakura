import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {sttConfig,transcribeVoiceNote,VoiceNoteError,voiceNoteFailure} from '../src/voice-note.js';
import {checkStorageDisk} from '../src/storage-disk.js';
import {logger} from '../src/logger.js';
const audio={data:Buffer.alloc(128),duration:0.25,sourceBytes:32};
test('unconstrained string-key args are schema-compatible without weakening runtime data',()=>{
 const schema=z.object({}).catchall(z.unknown());assert.deepEqual(schema.parse({x:1,nested:{a:true}}),{x:1,nested:{a:true}});assert.throws(()=>schema.parse([]));assert.throws(()=>schema.parse(null));
 const json=z.toJSONSchema(schema);assert.equal('propertyNames' in json,false);assert.equal(json.type,'object');assert.equal(json.additionalProperties!==false,true);
});
test('STT default is 60s configurable, timeout aborts actual request and rejects late text',async(t)=>{
 assert.equal(sttConfig({STT_URL:'https://fixture.test',STT_KEY:'fixture'}).requestTimeoutMs,60000);
 assert.equal(sttConfig({STT_URL:'https://fixture.test',STT_KEY:'fixture',STT_REQUEST_TIMEOUT_SECONDS:'15'}).requestTimeoutMs,15000);
 assert.throws(()=>sttConfig({STT_REQUEST_TIMEOUT_SECONDS:'0'}));
 const logs:any[]=[];t.mock.method(logger,'info',(fields:any)=>logs.push(fields));
 let signal:AbortSignal|undefined,finish!:(r:Response)=>void;const cfg={...sttConfig({STT_URL:'https://fixture.test',STT_KEY:'fixture'}),requestTimeoutMs:5};
 const work=transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async(_url,init)=>{signal=init!.signal as AbortSignal;return new Promise<Response>(r=>{finish=r;});});
 await assert.rejects(work,/stt_timeout/);assert.equal(signal!.aborted,true);finish(Response.json({text:'private late transcript'}));await Promise.resolve();
 assert.equal(logs.length,1);assert.equal(logs[0].code,'stt_timeout');assert.equal(logs[0].sourceBytes,32);assert.doesNotMatch(JSON.stringify(logs),/fixture|private|https|transcript/);
 assert.match(voiceNoteFailure(new VoiceNoteError('stt_timeout')),/Couldn’t hear/);
});
test('STT deadline covers hanging response stream; caller cancel and revoked owner never yield text',async()=>{
 const cfg={...sttConfig({STT_URL:'https://fixture.test',STT_KEY:'fixture'}),requestTimeoutMs:5};let cancelled=false;
 await assert.rejects(transcribeVoiceNote(audio,cfg,()=>true,new AbortController().signal,async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}))),/stt_timeout/);assert.ok(cancelled);
 const controller=new AbortController();const work=transcribeVoiceNote(audio,{...cfg,requestTimeoutMs:1000},()=>true,controller.signal,async()=>new Promise(()=>{}));controller.abort();await assert.rejects(work,/stt_cancelled/);
 let authorized=true;await assert.rejects(transcribeVoiceNote(audio,{...cfg,requestTimeoutMs:1000},()=>authorized,new AbortController().signal,async()=>{authorized=false;return Response.json({text:'never deliver'});}),/owner_denied/);
});
test('disk warning scope is observed DATA filesystem only, rate limited and unreadable is not healthy',async()=>{
 const rows:any[]=[];let time=100000000;const report=(fields:any)=>rows.push(fields);
 await checkStorageDisk('/fixture',async()=>({bavail:1,bsize:4096}),()=>time,report);assert.equal(rows[0].event,'storage_disk_low');assert.match(rows[0].scope,/Mongo volume not observed/);
 await checkStorageDisk('/fixture',async()=>({bavail:1,bsize:4096}),()=>time,report);assert.equal(rows.length,1);time+=300001;
 await checkStorageDisk('/fixture',async()=>{throw Error('private path');},()=>time,report);assert.equal(rows[1].event,'storage_disk_unknown');assert.doesNotMatch(JSON.stringify(rows),/private path/);
});
