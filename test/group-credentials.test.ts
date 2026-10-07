import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {workTools} from '../src/work-tools.js';
const options={toolCallId:'test',messages:[]};
test('owner group credentials usable without broader authorization; unowned/injected key and persistent file writes blocked',async()=>{
 const owner='6612253937',group='-777';const authorize=sandboxes.authorized,run=sandboxes.run;config.telegramAllowed.add(group);
 sandboxes.authorized=id=>id===owner;sandboxes.run=async()=>({output:'ok',exitCode:0,timedOut:false});
 const key='tskey-auth-ownerdummytest';const incoming={transport:'telegram' as const,chatId:group,senderId:owner,sender:'owner',id:'1',text:`use ${key}`,isGroup:true,timestamp:0,credentialEligible:true};
 try{
  const tools=workTools(incoming);assert.ok(tools.run_command);
  assert.equal((await tools.run_command!.execute!({command:`test -n '${key}'`},options) as {output:string}).output,'ok');
  await assert.rejects(()=>tools.run_command!.execute!({command:'test -n tskey-auth-injectednonownertest'},options) as Promise<unknown>,/authenticated owner/);
  await assert.rejects(()=>tools.write_file!.execute!({path:'key',content:key},options) as Promise<unknown>,/cannot be stored/);
  await assert.rejects(()=>tools.watch_desktop!.execute!({},options) as Promise<unknown>,/owner DM/);
  assert.deepEqual(workTools({...incoming,senderId:'999'}),{});
  assert.deepEqual(workTools({...incoming,chatId:'-888'}),{});
 }finally{config.telegramAllowed.delete(group);sandboxes.authorized=authorize;sandboxes.run=run;sandboxes.stop();}
});
