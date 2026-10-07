import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { DesktopAccess, validateDesktopTarget } from '../src/desktop-access.js';
const container = 'a'.repeat(64), base = 'https://desktop.example';
function make(extra: Partial<ConstructorParameters<typeof DesktopAccess>[0]> = {}) {
  return new DesktopAccess({ publicBaseUrl: base, isAuthorized: id => id === 'owner', resolveTarget: async () => ({ ip: '172.18.0.2', authorization: 'Basic Zml4dHVyZQ==' }), ...extra });
}
async function listen(g: DesktopAccess) {
  await new Promise<void>(r => g.server.listen(0, '127.0.0.1', r));
  const a = g.server.address(); assert(a && typeof a !== 'string'); return a.port;
}
async function get(port: number, path: string, cookie?: string) {
  return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,headers:cookie?{cookie}:{}},res=>{
      let body='';res.on('data',d=>{body+=d;});res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
}
async function bootstrap(g:DesktopAccess,port:number,owner='owner') {
  const link=new URL(g.issue(owner,container));const response=await get(port,link.pathname);
  assert.equal(response.status,303);
  return {link,response,cookie:response.headers['set-cookie']![0]!.split(';')[0]!,page:response.headers.location!};
}
function ws(port:number,path:string,cookie:string,origin=base,protocol?:string) {
  return connect(port,'127.0.0.1',function(){this.write(`GET ${path} HTTP/1.1\r\nHost: desktop.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${protocol === undefined ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`}\r\n`);});
}
async function deniedWs(port:number,path:string,cookie:string,origin=base,protocol?:string) {
  const socket=ws(port,path,cookie,origin,protocol);let data='';
  await new Promise<void>((resolve,reject)=>{socket.on('data',d=>{data+=d;});socket.on('end',resolve);socket.on('error',reject);});
  assert.match(data,/403 Forbidden/);
}
test('HTTPS origin, private bridge targets and bounded TTL fail closed',()=>{
  for(const publicBaseUrl of ['http://desktop.example','https://u:p@desktop.example','https://desktop.example/path','https://desktop.example/?a=1'])assert.throws(()=>make({publicBaseUrl}));
  for(const ttlMs of [0,86400001,NaN])assert.throws(()=>make({ttlMs}));
  for(const ip of ['127.0.0.1','169.254.169.254','8.8.8.8','localhost','172.18.0.2:123','::1'])assert.throws(()=>validateDesktopTarget(ip));
  for(const ip of ['172.18.0.2','10.1.2.3','192.168.1.2'])assert.equal(validateDesktopTarget(ip),ip);
});
test('authorized bounded issuance stores only hashes, defaults to one hour',()=>{
  const g=make({maxTokens:1,now:()=>1000});try{
    assert.throws(()=>g.issue('other',container));assert.throws(()=>g.issue('owner','host'));
    const key=new URL(g.issue('owner',container)).pathname.slice(1);assert.match(key,/^[a-f0-9]{64}$/);
    const grants=(g as unknown as {grants:Map<string,{expires:number}>}).grants;
    assert(!grants.has(key));assert(grants.has(createHash('sha256').update(key).digest('hex')));
    assert.equal([...grants.values()][0]!.expires,3601000);assert(!JSON.stringify([...grants]).includes(key));
    assert.throws(()=>g.issue('owner',container));g.revokeOwner('owner');assert.doesNotThrow(()=>g.issue('owner',container));
  }finally{g.close();}
});
test('single-use bootstrap mints independent hashed owner session, unknown/expired/revoked deny',async()=>{
  let now=1000,allowed=true;const g=make({now:()=>now,ttlMs:10000,isAuthorized:()=>allowed});const port=await listen(g);
  try{
    const {link,response,cookie,page}=await bootstrap(g,port);
    assert.match(response.headers['set-cookie']![0]!,/HttpOnly; Secure; SameSite=Strict/);
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');
    assert.equal(page,`${link.pathname}/vnc.html?autoconnect=1&path=${link.pathname.slice(1)}/websockify`);
    assert(!cookie.includes(link.pathname.slice(1)));
    assert(!JSON.stringify([...(g as unknown as {grants:Map<string,unknown>}).grants]).includes(cookie.split('=')[1]!));
    assert.equal((await get(port,link.pathname)).status,403);assert.equal((await get(port,link.pathname,cookie)).status,403);
    assert.equal((await get(port,'/'+ 'f'.repeat(64))).status,403);
    now=11000;assert.equal((await get(port,page,cookie)).status,403);
    const second=new URL(g.issue('owner',container));allowed=false;assert.equal((await get(port,second.pathname)).status,403);
  }finally{g.close();}
});
test('concurrent redemption is atomic after target inspection',async()=>{
  const g=make({resolveTarget:async()=>{await new Promise(r=>setTimeout(r,10));return{ip:'172.18.0.2',authorization:'Basic Zml4dHVyZQ=='};}});const port=await listen(g);
  try{const link=new URL(g.issue('owner',container));const result=await Promise.all([get(port,link.pathname),get(port,link.pathname)]);assert.deepEqual(result.map(r=>r.status).sort(),[303,403]);}finally{g.close();}
});
test('traversal, invalid origins, expired websocket and owner cookie swapping fail before resolver',async()=>{
  let calls=0,now=1000;const g=make({now:()=>now,ttlMs:10000,isAuthorized:id=>['owner','other'].includes(id),resolveTarget:async()=>{calls++;return{ip:'172.18.0.2',authorization:'Basic Zml4dHVyZQ=='};}});const port=await listen(g);
  try{
    const one=await bootstrap(g,port),two=await bootstrap(g,port,'other');calls=0;
    for(const path of [one.link.pathname+'/../vnc.html',one.link.pathname+'/%2e%2e/vnc.html',one.link.pathname+'/\\vnc.html','//evil.example/'])assert.equal((await get(port,path,one.cookie)).status,403);
    assert.equal((await get(port,two.page,one.cookie)).status,403);
    await deniedWs(port,one.link.pathname+'/websockify',one.cookie,'https://evil.example');
    await deniedWs(port,one.link.pathname+'/elsewhere',one.cookie);
    await deniedWs(port,one.link.pathname+'/websockify',one.cookie,base,'base64');
    await deniedWs(port,one.link.pathname+'/websockify',one.cookie,base,'binary, invalid protocol');
    now=11000;await deniedWs(port,one.link.pathname+'/websockify',one.cookie);assert.equal(calls,0);
  }finally{g.close();}
});
test('bootstrap rejects replaced containers, public targets and authorization lost during inspection',async()=>{
  for(const mode of ['replaced','public','revoked']){
    let allowed=true;const g=make({isAuthorized:()=>allowed,resolveTarget:async(owner,id)=>{
      assert.equal(owner,'owner');assert.equal(id,container);if(mode==='replaced')throw new Error('replaced');if(mode==='revoked')allowed=false;
      return{ip:mode==='public'?'169.254.169.254':'172.18.0.2',authorization:'Basic Zml4dHVyZQ=='};
    }});const port=await listen(g);try{assert.equal((await get(port,new URL(g.issue('owner',container)).pathname)).status,403);}finally{g.close();}
  }
});
test('real HTTP assets and websocket prefix work with session; expiry closes active tunnel',async t=>{
  const ip=Object.values(networkInterfaces()).flat().find(a=>{if(!a||a.family!=='IPv4')return false;try{validateDesktopTarget(a.address);return true;}catch{return false;}})?.address;
  if(!ip){t.skip('No private test interface');return;}
  const backend=createServer((req,res)=>{assert(['/vnc.html','/app/ui.js'].includes(req.url!));assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,'Basic Zml4dHVyZQ==');res.end('noVNC fixture');});
  backend.on('upgrade',(req,socket)=>{assert.equal(req.url,'/websockify');assert.equal(req.headers.cookie,undefined);const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${req.headers['sec-websocket-protocol'] ? 'Sec-WebSocket-Protocol: binary\r\n' : ''}\r\n`);socket.on('error',()=>socket.destroy());socket.on('data',d=>socket.write(d));});
  try{await new Promise<void>((r,j)=>{backend.once('error',j);backend.listen(6080,ip,r);});}catch(e){if((e as NodeJS.ErrnoException).code==='EADDRINUSE'){t.skip('Fixture port busy');return;}throw e;}
  let now=1000;const g=make({now:()=>now,ttlMs:10000,resolveTarget:async()=>({ip,authorization:'Basic Zml4dHVyZQ=='})});const port=await listen(g);
  try{
    const {link,cookie,page}=await bootstrap(g,port);assert.equal((await get(port,page,cookie)).body,'noVNC fixture');assert.equal((await get(port,link.pathname+'/app/ui.js',cookie)).body,'noVNC fixture');
    await new Promise<void>((resolve,reject)=>{const socket=ws(port,link.pathname+'/websockify',cookie,base,'binary');socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('binary handshake timeout'));});socket.once('data',chunk=>{try{assert.match(chunk.toString(),/Sec-WebSocket-Protocol: binary\r\n/i);socket.destroy();resolve();}catch(e){socket.destroy();reject(e);}});socket.on('error',reject);});
    await new Promise<void>((resolve,reject)=>{const socket=ws(port,link.pathname+'/websockify',cookie);socket.setTimeout(3500,()=>{socket.destroy();reject(new Error('timeout'));});let upgraded=false;socket.on('data',chunk=>{if(!upgraded){assert.match(chunk.toString(),/101 Switching Protocols/);assert.doesNotMatch(chunk.toString(),/Sec-WebSocket-Protocol:/i,'noVNC offers no subprotocol, so browsers reject an unsolicited binary protocol');upgraded=true;socket.write('echo');}else{assert.equal(chunk.toString(),'echo');now=11000;}});socket.on('close',()=>{assert(upgraded);resolve();});socket.on('error',reject);});
    assert.equal((await get(port,page,cookie)).status,403);
  }finally{g.close();backend.close();}
});
