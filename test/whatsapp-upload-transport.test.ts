import test from 'node:test';
import assert from 'node:assert/strict';
import {WhatsAppTransport} from '../src/transports/whatsapp.js';
import {whatsappConfig} from '../src/whatsapp-config.js';
const owner='6612253937',chat='15551234567@s.whatsapp.net';
const cfg=whatsappConfig({WHATSAPP_ENABLED:'true',WHATSAPP_AUTH_DIR:'/run/private/wa',WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':owner}),WHATSAPP_ALLOWED_NUMBERS:'+15551234567',SANDBOX_ALLOWED_USERS:owner});
test('WA authenticates/claims before download, passes only video/image, failure is honest and audio stays disabled',async()=>{
 let downloads=0,claims=0;const received:any[]=[];let fail=false;
 const tr:any=new WhatsAppTransport(cfg,{claim:async()=>{claims++;return true;}},undefined,undefined,async(item,kind,cap,signal)=>{
  downloads++;assert.ok(['image','video'].includes(kind));assert.equal(cap,cfg.maxMediaBytes);assert.ok(signal instanceof AbortSignal);
  if(fail)throw new Error('integrity fixture failure');return Buffer.from('fixture');
 });
 tr.stopped=false;tr.socket={user:{id:'other@s.whatsapp.net'},end:()=>{}};tr.onMessage=(m:any)=>received.push(m);
 let id=0;const message=(kind:string,remote=chat)=>({key:{remoteJid:remote,id:String(++id)},messageTimestamp:Math.floor(Date.now()/1000),message:{[kind+'Message']:{caption:'describe',mimetype:kind+'/fixture'}}});
 try{
  await tr.receive(message('video','15559999999@s.whatsapp.net'),tr.socket);assert.equal(downloads,0);assert.equal(claims,0);
  for(const kind of ['image','video']){await tr.receive(message(kind),tr.socket);assert.equal(received.at(-1).media[0].kind,kind);assert.equal(received.at(-1).authenticatedOwner,true);assert.equal(received.at(-1).credentialEligible,false);}
  fail=true;await tr.receive(message('video'),tr.socket);assert.equal(received.at(-1).media.length,0);assert.match(received.at(-1).text,/unavailable/);assert.ok(!received.at(-1).text.includes('integrity fixture'));
  const n=downloads;await tr.receive(message('audio'),tr.socket);assert.equal(downloads,n);assert.match(received.at(-1).text,/Audio inspection remains disabled/);
 }finally{await tr.stop();}
});
