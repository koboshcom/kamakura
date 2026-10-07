import test from 'node:test';import assert from 'node:assert/strict';import {config} from '../src/config.js';import {speechAvailable,synthesizeVoice} from '../src/speech.js';
test('optional speech capability probe and synthesis are bounded, separated from chat keys and validate Ogg',async()=>{
 const old={...config.speech};const fetchOriginal=globalThis.fetch;const requests:{url:string;init?:RequestInit}[]=[];
 config.speech={baseUrl:'https://speech.example.test/v1',apiKey:'own-speech-key',model:'test-tts',voice:'voice'};
 try{globalThis.fetch=async(input,init)=>{requests.push({url:String(input),init});if(String(input).endsWith('openapi.json'))return Response.json({paths:{'/v1/audio/speech':{}}});if(String(input).endsWith('models'))return Response.json({data:[{id:'test-tts'}]});return new Response(Buffer.from('OggSdummy'));};
 assert.equal(await speechAvailable(),true);const audio=await synthesizeVoice('hello');assert.equal(audio.toString(),'OggSdummy');assert.equal(requests[0].url,'https://speech.example.test/openapi.json');assert.equal(requests[2].url,'https://speech.example.test/v1/audio/speech');assert.equal((requests[2].init?.headers as {Authorization:string}).Authorization,'Bearer own-speech-key');
 globalThis.fetch=async()=>new Response('unavailable',{status:404});assert.equal(await speechAvailable(),false);await assert.rejects(()=>synthesizeVoice('hello'),/unavailable/);await assert.rejects(()=>synthesizeVoice('tskey-auth-notforvoice123'),/spoken/);
 config.speech.model='';assert.equal(await speechAvailable(),false);
 }finally{config.speech=old;globalThis.fetch=fetchOriginal;}
});
