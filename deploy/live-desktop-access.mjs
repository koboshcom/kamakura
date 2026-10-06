import assert from 'node:assert/strict';
import { request } from 'node:http';
import { sandboxes } from './dist/sandbox.js';
import { config } from './dist/config.js';
import { DesktopAccess } from './dist/desktop-access.js';
import { readFileSync } from 'node:fs';
import { transcribeWav } from './dist/transcription.js';
const owners = ['6612253937','7853500388'];
assert.deepEqual([...config.telegramAllowed].sort(), owners.toSorted());
assert.deepEqual([...config.sandbox.allowed].sort(), owners.toSorted());
const targets = new Map();
for (const owner of owners) {
  const target = await sandboxes.desktopTarget(owner);
  targets.set(owner,target);
  // Desktop startup can take a few seconds, without a new recreation attempt.
  let response;
  for(let attempt=0;attempt<40;attempt++) {
    try { response=await fetch(target.url+'/vnc.html',{signal:AbortSignal.timeout(2000)}); break; } catch { await new Promise(r=>setTimeout(r,500)); }
  }
  assert.equal(response?.status,401);
  const secured = await fetch(target.url+'/vnc.html',{headers:{Authorization:target.authorization},signal:AbortSignal.timeout(5000)});
  assert.equal(secured.status,200);
  assert.match(await secured.text(), /noVNC/i);
  const shell = await sandboxes.run(owner,"test -f /workspace/.kamakura-preserve-novnc && test -f /opt/kamakura/file-tools.py && ! command -v tailscale >/dev/null && ps -eo args | grep -E 'chrome|chromium' | grep -v grep | head -c 2000");
  assert.equal(shell.exitCode,0);
  assert(!shell.output.includes('--headless'));
  const screenshot=await sandboxes.execPython(owner,'display(pyautogui.screenshot())');
  assert(screenshot.images.length>0);
  console.log('PASS actual owner desktop',owner,'backend401/auth200, workspace retained, no Tailscale, headed Chromium, screenshot');
}
const one=targets.get(owners[0]),two=targets.get(owners[1]);
assert.notEqual(one.authorization,two.authorization);
assert.equal((await fetch(two.url+'/vnc.html',{headers:{Authorization:one.authorization}})).status,401);
console.log('PASS cross-owner backend credential denied');
const gateway=new DesktopAccess({publicBaseUrl:'https://vnc.example.test',isAuthorized:owner=>owners.includes(owner),resolveTarget:async(owner,containerId)=>{
  const target=await sandboxes.desktopTarget(owner);assert.equal(target.containerId,containerId);
  return {ip:new URL(target.url).hostname,authorization:target.authorization};
}});
await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));
const port=gateway.server.address().port;
try {
 const link=new URL(gateway.issue(owners[0],one.containerId));
 const local='http://127.0.0.1:'+port;
 const boot=await fetch(local+link.pathname+link.search,{redirect:'manual'});
 assert.equal(boot.status,303);
 const cookie=boot.headers.get('set-cookie').split(';')[0];
 const page=await fetch(local+link.pathname,{headers:{Cookie:cookie}});
 assert.equal(page.status,200);assert.match(await page.text(),/noVNC/i);
 await new Promise((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path:link.pathname.replace('vnc.html','websockify'),headers:{Cookie:cookie,Origin:'https://vnc.example.test',Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13','Sec-WebSocket-Protocol':'binary'}});
   const timeout=setTimeout(()=>reject(new Error('No RFB banner')),5000);
   req.on('upgrade',(response,socket,head)=>{
     assert.equal(response.statusCode,101);
     const inspect=chunk=>{if(chunk.toString().includes('RFB ')){clearTimeout(timeout);socket.destroy();resolve();}};
     inspect(head);socket.on('data',inspect);socket.on('error',reject);
   });
   req.on('response',r=>reject(new Error('WS failed '+r.statusCode)));req.on('error',reject);req.end();
 });
 gateway.revokeOwner(owners[0]);
 assert.equal((await fetch(local+link.pathname,{headers:{Cookie:cookie}})).status,403);
 console.log('PASS genuine noVNC HTTP and websocket RFB stream through expiring owner gateway; revocation denies reuse');
 const transcript=await transcribeWav(readFileSync('/tmp/kamakura-audio-check-mono.wav'));
 assert.match(transcript,/shrine cat/i);
 console.log('PASS deployed Speaches transcription',JSON.stringify(transcript));
} finally {gateway.close();}
console.log('Public HTTPS proxy/browser access remains operator-configured, not validated by local smoke.');
