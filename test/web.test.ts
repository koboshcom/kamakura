import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {debugWebConfig,DebugWebTransport} from '../src/transports/web.js';
import {chatKey,type IncomingMessage} from '../src/types.js';
import {canWork} from '../src/work-tools.js';
test('debug web is opt-in and remote binds require token',()=>{
 assert.equal(debugWebConfig({}),undefined);
 assert.equal(debugWebConfig({DEBUG_WEBCHAT:'1',DEBUG_WEBCHAT_OWNER_ID:'123',DEBUG_WEBCHAT_HOST:'0.0.0.0'})?.token.length,64);
 assert.equal(debugWebConfig({DEBUG_WEBCHAT:'1',DEBUG_WEBCHAT_OWNER_ID:'123'})?.host,'127.0.0.1');
});
test('web accepts text with server-owned separate identity and polls replies',async()=>{
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 const transport=new DebugWebTransport({host:'127.0.0.1',port,owner:'123',token:'secret'},false);let message:IncomingMessage|undefined;
 await transport.start(m=>{message=m;});
 try{
 const base='http://127.0.0.1:'+port;
 assert.equal((await fetch(base+'/messages')).status,401);
 assert.equal((await fetch(base+'/messages',{method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json',Origin:'https://evil.test'},body:'{"text":"bad"}'})).status,403);
 const headers={Authorization:'Bearer secret','Content-Type':'application/json'};
 assert.equal((await fetch(base+'/messages',{method:'POST',headers,body:JSON.stringify({text:'hello',senderId:'999'})})).status,202);
 assert.equal(message?.senderId,'123');assert.equal(chatKey(message!),'web:123');assert.equal(canWork(message!,()=>true),true);
 await transport.send('123','reply https://example.com/image.png');
 const entries=await (await fetch(base+'/messages',{headers})).json() as {text:string}[];assert.equal(entries.length,2);assert.match(entries[1]!.text,/image.png/);
 assert.match(await (await fetch(base)).text(),/meta charset="utf-8"/);
 }finally{await transport.stop();}
});
