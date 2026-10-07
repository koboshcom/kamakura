import assert from 'node:assert/strict';
import {sandboxes} from './dist/sandbox.js';
import {cuaPython} from './dist/cua-tools.js';
try {
 for(const owner of ['6612253937','7853500388']) {
  await sandboxes.desktopTarget(owner);
  const doctor=await sandboxes.run(owner,'cua-driver doctor --json');
  assert.equal(doctor.exitCode,0,doctor.output);assert.match(doctor.output,/x11/i);
  const windows=await sandboxes.execPython(owner,cuaPython('list_windows',{session:'kamakura'}));
  assert(!windows.text.includes('Traceback'),windows.text);assert(windows.text.length>0);
  const input=await sandboxes.execPython(owner,"r=cua.call('press_key',{'session':'kamakura','key':'ESC','target':{'kind':'desktop','display_id':'primary'}})\nlog(r)");
  assert(!input.text.includes('Traceback'),input.text);assert(!input.text.includes("'isError': True"),input.text);
  const state=await sandboxes.execPython(owner,cuaPython('get_desktop_state',{session:'kamakura',max_image_dimension:1024}));
  assert(!state.text.includes('Traceback'),state.text);assert(state.images.length>0,state.text);
  const fallback=await sandboxes.execPython(owner,'display(screenshot())');assert(fallback.images.length>0,fallback.text);
  console.log('PASS owner Cua doctor, windows, harmless Escape input, actual PNG and screenshot fallback',owner);
 }
} finally {sandboxes.stop();}
