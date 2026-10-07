import test from 'node:test';
import assert from 'node:assert/strict';
import {tool} from 'ai';
import {z} from 'zod';
import {taskProgress} from '../src/task-progress.js';
const options={toolCallId:'stale-test',messages:[],context:undefined};
test('superseded turns cannot dispatch fresh work after a delivered intent',async()=>{
 let current=true,executions=0;
 const progress=taskProgress(async()=>{},()=>true,()=>current);
 const tools=progress.guard({run:tool({inputSchema:z.object({}),execute:async()=>{executions++;return 'ok';}})});
 current=false;
 await assert.rejects(async()=>tools.run.execute!({},options),/superseded/);
 assert.equal(executions,0);
});
test('supersession during an awaited intent prevents side effects',async()=>{
 let current=true,executions=0;
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const progress=taskProgress(()=>gate,()=>false,()=>current);
 const tools=progress.guard({run:tool({inputSchema:z.object({}),execute:async()=>{executions++;return 'ok';}})});
 const announcement=progress.tools.announce_task!.execute!({text:'checking now'},options);
 const work=Promise.resolve(tools.run.execute!({},options));
 current=false;release();
 await announcement;
 await assert.rejects(work,/superseded/);
 assert.equal(executions,0);
});
test('current and legacy task dispatch retain intended behavior',async()=>{
 let executions=0;
 const base={run:tool({inputSchema:z.object({}),execute:async()=>{executions++;return 'ok';}})};
 const progress=taskProgress(async()=>{},()=>true,()=>true);
 assert.equal(await progress.guard(base).run.execute!({},options),'ok');
 assert.equal(await taskProgress().guard(base).run.execute!({},options),'ok');
 assert.equal(executions,2);
});
