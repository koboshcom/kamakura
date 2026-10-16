import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import type {ClientEvent} from 'openai/resources/live/live';
import type {VoiceConfig} from './discord-voice-config.js';

/** xAI Realtime to the existing bounded voice session. No reconnect or hosted tools. */
export class GrokVoiceLive extends EventEmitter {
 readonly socket:{on:(event:string,listener:(...args:any[])=>void)=>unknown;platformSocket:WebSocket};
 locallyClosed=false;
 private ws:WebSocket;private configured=false;private active=false;private stopping=false;private failed=false;
 private deadline?:ReturnType<typeof setTimeout>;private origin=performance.now();
 private current?:string;private cancelled=new Set<string>();private calls=new Set<string>();private replies=new Set<string>();private responses=new Set<string>();
 private items=new Map<string,{start:number;end:number}>();private transcripts=new Set<string>();
 constructor(private cfg:VoiceConfig){
  super();
  this.ws=new WebSocket(cfg.endpoint,{headers:{Authorization:'Bearer '+cfg.apiKey},followRedirects:false,maxPayload:65536,perMessageDeflate:false,handshakeTimeout:10000});
  this.socket={on:(event,listener)=>this.ws.on(event,listener),platformSocket:this.ws};
  this.ws.on('error',()=>{this.failed=true;this.emit('error',new Error('XAI_VOICE_CONNECTION'));});
  this.ws.on('message',(raw,binary)=>{
   if(this.stopping)return;
   try{
    if(binary)throw new Error('binary');
    const event:unknown=JSON.parse(raw.toString());
    if(!event||typeof event!=='object'||Array.isArray(event))throw new Error('event');
    this.receive(event as Record<string,any>);
   }catch{this.fail();}
  });
  this.ws.on('close',code=>{
   clearTimeout(this.deadline);this.locallyClosed=this.stopping&&!this.failed&&code===1000;
   this.items.clear();this.transcripts.clear();this.calls.clear();this.replies.clear();this.responses.clear();this.cancelled.clear();
   this.emit('close');
  });
 }
 private now(){return Math.max(0,Math.round(performance.now()-this.origin));}
 private write(event:Record<string,unknown>){
  if(this.ws.readyState!==WebSocket.OPEN||this.ws.bufferedAmount>16384)throw new Error('XAI_VOICE_UNAVAILABLE');
  const json=JSON.stringify(event);if(Buffer.byteLength(json)>16384)throw new Error('XAI_VOICE_EVENT_BUDGET');
  this.ws.send(json);
 }
 private fail(){this.failed=true;this.emit('event',{type:'error',error:{code:'invalid_request_error'}});this.close();}
 send(event:ClientEvent){
  if(event.type==='session.close'){this.close();return;}
  if(this.stopping)throw new Error('XAI_VOICE_CLOSED');
  switch(event.type){
   case 'session.start':
    if(this.configured)throw new Error('XAI_VOICE_DUPLICATE_START');
    this.configured=true;
    this.write({type:'session.update',session:{
     model:this.cfg.model,voice:this.cfg.voice,instructions:event.session.instructions,
     turn_detection:{type:'server_vad'},resumption:{enabled:false},
     audio:{input:{format:{type:'audio/pcm',rate:24000},transport:'json',transcription:{model:'grok-transcribe'}},output:{format:{type:'audio/pcm',rate:24000},transport:'json'}},
     tools:[{type:'function',name:'delegate_current_request',description:'Ask the authorized main agent about the current captured user request. No arguments and no action authority. Ask the user to repeat if transcription is missing.',parameters:{type:'object',properties:{},additionalProperties:false}}]
    }});
    break;
   case 'session.input_audio.append':
    if(!this.active)throw new Error('XAI_VOICE_NOT_READY');
    this.write({type:'input_audio_buffer.append',audio:event.audio});break;
   case 'session.instructions.append':
    if(this.current){if(this.cancelled.size>=512)throw new Error('XAI_VOICE_CANCEL_BUDGET');this.cancelled.add(this.current);this.write({type:'response.cancel',response_id:this.current});}
    break;
   case 'session.commentary.append':
    if(this.replies.has(event.delegation_id??''))throw new Error('XAI_VOICE_DUPLICATE_REPLY');
    if(!this.calls.has(event.delegation_id??''))throw new Error('XAI_VOICE_UNKNOWN_CALL');
    this.replies.add(event.delegation_id!);
    this.write({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.delegation_id,output:event.content}});
    // This is a local write, not a provider acknowledgement.
    this.write({type:'response.create'});break;
   default:throw new Error('XAI_VOICE_UNSUPPORTED_CLIENT_EVENT');
  }
 }
 private id(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);}
 private receive(e:Record<string,any>){
  if(e.type==='error'){this.fail();return;}
  if(e.type==='session.created')return;
  if(e.type==='session.updated'){
   if(!this.configured||this.active)throw new Error('session state');
   if(e.session?.model&&e.session.model!==this.cfg.model)throw new Error('model mismatch');
   for(const part of ['input','output']){
    const format=e.session?.audio?.[part]?.format;
    if(format&&(format.type!=='audio/pcm'||format.rate!==24000))throw new Error('audio mismatch');
   }
   this.active=true;this.emit('event',{type:'session.started'});return;
  }
  if(!this.active)return;
  const response=e.response_id??e.response?.id;
  if(response!==undefined&&!this.id(response))throw new Error('response id');
  if(e.type==='response.created'){
   if(!response||this.responses.has(response)||this.responses.size>=512)throw new Error('response state');
   if(this.current){if(this.cancelled.size>=512)throw new Error('cancel budget');this.cancelled.add(this.current);}
   this.responses.add(response);this.current=response;return;
  }
  if(response&&(!this.responses.has(response)||this.cancelled.has(response)))return;
  if(e.type==='response.done'){
   if(response===this.current)this.current=undefined;
   return;
  }
  if(e.type==='input_audio_buffer.speech_started'||e.type==='input_audio_buffer.speech_stopped'){
   if(!this.id(e.item_id))throw new Error('item id');
   if(!this.items.has(e.item_id)&&this.items.size>=512)throw new Error('item budget');
   const item=this.items.get(e.item_id)??{start:this.now(),end:this.now()};
   // Timing is local receive time, not invented provider audio offsets.
   if(e.type.endsWith('speech_started'))item.start=this.now();else item.end=Math.max(item.start,this.now());
   this.items.set(e.item_id,item);return;
  }
  // updated is cumulative and may correct earlier words. Never append or execute it.
  if(e.type==='conversation.item.input_audio_transcription.updated')return;
  if(e.type==='conversation.item.input_audio_transcription.completed'||e.type==='response.output_audio_transcript.done'){
   if(!this.id(e.item_id)||typeof e.transcript!=='string'||e.transcript.length>4000)throw new Error('transcript');
   const role=e.type.startsWith('conversation.')?'user':'assistant',key=role+':'+e.item_id;
   if(this.transcripts.has(key))return;
   if(this.transcripts.size>=512)throw new Error('transcript budget');
   this.transcripts.add(key);
   const timing=this.items.get(e.item_id)??{start:this.now(),end:this.now()};
   this.emit('event',{type:role==='user'?'session.input_transcript.delta':'session.output_transcript.delta',event_id:randomUUID(),delta:e.transcript,start_ms:timing.start,end_ms:Math.max(timing.start,timing.end)});
   return;
  }
  if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta'){
   if(response!==this.current||!response)return;
   if(typeof e.delta!=='string'||e.delta.length>65536||!/^[A-Za-z0-9+/]*={0,2}$/.test(e.delta))throw new Error('audio');
   const bytes=Buffer.from(e.delta,'base64');
   if(!bytes.length||bytes.length%2||bytes.toString('base64')!==e.delta)throw new Error('audio');
   // Existing session enforces the same stale/backlog/drop and playback gates.
   for(let i=0;i<bytes.length;i+=9600)this.emit('event',{type:'session.output_audio.delta',delta:bytes.subarray(i,i+9600).toString('base64')});
   return;
  }
  if(e.type==='response.function_call_arguments.done'){
   if(!this.id(e.call_id)||!response||e.name!=='delegate_current_request'||typeof e.arguments!=='string'||e.arguments.length>256)throw new Error('function');
   const args=JSON.parse(e.arguments);if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw new Error('arguments');
   if(this.calls.has(e.call_id))return;
   if(this.calls.size>=512)throw new Error('call budget');
   this.calls.add(e.call_id);
   this.emit('event',{type:'session.delegation.created',offset_ms:this.now(),delegation:{id:e.call_id,target:'client'}});
  }
 }
 close(){
  if(this.stopping)return;this.stopping=true;
  if(this.ws.readyState===WebSocket.CLOSED)return;
  if(this.ws.readyState===WebSocket.OPEN)this.ws.close(1000);else this.ws.terminate();
  this.deadline=setTimeout(()=>this.ws.terminate(),500);this.deadline.unref();
 }
}
