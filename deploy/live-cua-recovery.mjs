// Actual owner-box idle expiry. No host/local-PC agent and no Telegram delivery.
import assert from 'node:assert/strict';
import {setTimeout as idle} from 'node:timers/promises';
import {sandboxes} from './dist/sandbox.js';
import {cuaPython} from './dist/cua-tools.js';
const owners=['6612253937','7853500388'];
const label='kamakura-idle-smoke';
const socket='/tmp/runtime-kamakura/cua-driver.sock';
const call=(name,args)=>`cua-driver call ${name} --socket ${socket} --args '${JSON.stringify(args)}'`;
try{
 for(const owner of owners){
  await sandboxes.desktopTarget(owner);
  const start=await sandboxes.run(owner,call('start_session',{session:label}));
  assert.equal(start.exitCode,0,start.output);
  const first=await sandboxes.execPython(owner,cuaPython('list_windows',{session:label}));
  assert.ok(!first.text.includes('Traceback'),first.text);
  console.log('PASS initial actual owner Cua session',owner);
 }
 console.log('Waiting 315 seconds with zero Cua calls to these sessions for real default idle expiry');
 await idle(315000);
 for(const owner of owners){
  const rejected=await sandboxes.run(owner,call('list_windows',{session:label}));
  assert.notEqual(rejected.exitCode,0,'actual idle session must expire before wrapper call');
  assert.match(rejected.output,/session has ended;.*was rejected/s);
  console.log('PASS actual idle expiry confirmed by driver rejection',owner);
  const recovered=await sandboxes.execPython(owner,cuaPython('list_windows',{session:label}));
  assert.ok(!recovered.text.includes('Traceback'),recovered.text);
  assert.match(recovered.text,/"recovered": true/);
  assert.match(recovered.text,/"last_status": "healthy"/);
  console.log('PASS transparent idle session recovery with health',owner,recovered.text.match(/\{"cua_health":.*\}/)?.[0]);
  // End a disposable session to test a harmless INPUT as the first rejected call.
  const ended=await sandboxes.run(owner,call('end_session',{session:label}));
  assert.equal(ended.exitCode,0,ended.output);
  const input=await sandboxes.execPython(owner,cuaPython('press_key',{session:label,key:'ESC',target:{kind:'desktop',display_id:'primary'}}));
  assert.ok(!input.text.includes('Traceback'),input.text);
  assert.match(input.text,/"recovered": true/);
  const state=await sandboxes.execPython(owner,cuaPython('get_desktop_state',{session:label,max_image_dimension:1024}));
  assert.ok(!state.text.includes('Traceback'),state.text);assert.ok(state.images.length>0,state.text);
  assert.match(state.text,/"recovered": false/);
  const fallback=await sandboxes.execPython(owner,'display(screenshot())');assert.ok(fallback.images.length>0,fallback.text);
  const health=await sandboxes.execPython(owner,'log(cua.health())');
  assert.match(health.text,/'recoveries': [2-9]/);assert.match(health.text,/'recovery_failures': 0/);
  console.log('PASS first-call Escape recovery, actual PNG, screenshot fallback and bounded health',owner,health.text.trim());
  await sandboxes.run(owner,call('end_session',{session:label}));
 }
}finally{sandboxes.stop();}
