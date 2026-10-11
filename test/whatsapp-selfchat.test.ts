import test from 'node:test';
import assert from 'node:assert/strict';
import {WhatsAppTransport} from '../src/transports/whatsapp.js';
import {whatsappConfig} from '../src/whatsapp-config.js';
const self='15551234567@s.whatsapp.net',other='15557654321@s.whatsapp.net';
const cfg=()=>whatsappConfig({WHATSAPP_ENABLED:'true',WHATSAPP_AUTH_DIR:'/run/private/wa',WHATSAPP_OWNER_NUMBERS:JSON.stringify({'+15551234567':'6612253937','+15557654321':'7853500388'}),WHATSAPP_ALLOWED_NUMBERS:'+15551234567,+15557654321',SANDBOX_ALLOWED_USERS:'6612253937,7853500388'});
function fixture(claims=new Set<string>()){
 const got:any[]=[],sent:any[]=[];
 const tr:any=new WhatsAppTransport(cfg(),{claim:async(id:string)=>{if(claims.has(id))return false;claims.add(id);return true}});
 const socket:any={user:{id:self},signalRepository:{lidMapping:{getPNForLID:async(lid:string)=>lid==='123@lid'?other:lid==='456@lid'?self:null}},sendMessage:async(chat:string,content:any,opts:any)=>{sent.push(opts);await tr.receive(msg(chat,opts.messageId,true),socket)}};
 tr.stopped=false;tr.connected=true;tr.socket=socket;tr.onMessage=(m:any)=>got.push(m);
 return {tr,socket,got,sent,claims};
}
const msg=(chat:string,id:string,fromMe=false)=>({key:{remoteJid:chat,id,fromMe},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:'hello'}});
test('trusted LID owners accepted, stranger/group/hinted PN denied, alias dedup',async()=>{
 const f=fixture();
 await f.tr.receive(msg('123@lid','one'),f.socket);
 assert.equal(f.got[0].senderId,'7853500388');
 await f.tr.receive(msg(other,'one'),f.socket);assert.equal(f.got.length,1);
 for(const chat of ['789@lid','99999999999@s.whatsapp.net','123@g.us'])await f.tr.receive({...msg(chat,'deny'),key:{...msg(chat,'deny').key,remoteJidAlt:self}},f.socket);
 assert.equal(f.got.length,1);
 await f.tr.send('123@lid','reply');assert.ok(f.sent[0].messageId);
});
test('only linked-owner selfchat allowed; outgoing races and restart echoes denied',async()=>{
 const f=fixture();
 await f.tr.receive(msg(self,'human',true),f.socket);
 await f.tr.receive(msg(other,'not-self',true),f.socket);
 assert.equal(f.got.length,1);
 await f.tr.send(self,'answer');assert.equal(f.got.length,1);
 const id=f.sent[0].messageId;
 const restarted=fixture(f.claims);
 await restarted.tr.receive(msg('456@lid',id,true),restarted.socket);
 assert.equal(restarted.got.length,0);
 await restarted.tr.receive(msg('456@lid','human-new',true),restarted.socket);
 assert.equal(restarted.got[0].senderId,'6612253937');
});
test('outbound claim failure prevents send entirely',async()=>{
 const f=fixture();await f.tr.receive(msg(self,'human',true),f.socket);
 f.tr.store={claim:async()=>{throw Error('storage unavailable')}};
 await assert.rejects(f.tr.send(self,'answer'));
 assert.equal(f.sent.length,0);
});
