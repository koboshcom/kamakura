import test from 'node:test';
import assert from 'node:assert/strict';
import { tool } from 'ai';
import { z } from 'zod';
import { turnWork } from '../src/turn-work.js';
import { taskProgress } from '../src/task-progress.js';
const options={toolCallId:'test',messages:[]};
test('quick tools do not require announcements but stale turns remain blocked',async()=>{
 let current=true;let executions=0;const progress=taskProgress(async()=>{throw new Error('quick task should not announce');},()=>false,()=>current);
 const tools=progress.guard({work:tool({inputSchema:z.object({}),execute:async()=>++executions})});
 await tools.work.execute!({},options);assert.equal(executions,1);
 current=false;await assert.rejects(()=>tools.work.execute!({},options) as Promise<unknown>,/superseded/);assert.equal(executions,1);
});
test('progress remains pending through work and clears only on result delivery',async()=>{
 const state=turnWork();state.sent('checking now','progress');assert.ok(state.needsWork);assert.equal(state.canEnd(),false);
 const tools=state.guard({work:tool({inputSchema:z.object({}),execute:async()=>({ok:true})})});
 await tools.work.execute!({},options);assert.ok(state.pending);assert.equal(state.needsWork,false);assert.equal(state.canEnd(),false);
 state.sent('it works','answer');assert.equal(state.canEnd(),true);
});
test('unmarked legacy promises cannot end after intent alone; failures still need a real blocker',async()=>{
 const state=turnWork();state.sent("i'll open the page");assert.ok(state.needsWork);
 state.sent('one moment');assert.equal(state.canEnd(),false);
 const tools=state.guard({work:tool({inputSchema:z.object({}),execute:async()=>{throw new Error('offline');}})});
 await assert.rejects(()=>tools.work.execute!({},options) as Promise<unknown>,/offline/);
 assert.equal(state.needsWork,false);assert.equal(state.canEnd(),false);state.sent('the site is offline');assert.equal(state.canEnd(),true);
});
