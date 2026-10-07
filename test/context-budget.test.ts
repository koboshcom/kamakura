import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tool, type ModelMessage, type PrepareStepFunction, type ToolSet } from 'ai';
import { z } from 'zod';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { budgetOptions, trimModelContext, messageTokens, textTokens, toolTokens, ContextBudgetError } from '../src/context-budget.js';
const pinned: ModelMessage = {role:'user',content:'complete original owner request, credential abc and approval only here'};
const opts = {limit:1800,instructions:'authoritative authorization and safety',pinned,schemaTokens:0,outputTokens:100};
const pair: ModelMessage[] = [
 {role:'assistant',content:[{type:'tool-call',toolCallId:'one',toolName:'read',input:{path:'file'}}]},
 {role:'tool',content:[{type:'tool-result',toolCallId:'one',toolName:'read',output:{type:'text',value:'巨大的🙂 code'.repeat(4000)}}]},
];
test('real o200k Unicode/code counts and ordinary special strings',()=>{
 for(const s of ['你好世界🙂','const a = x => x ** 2;','<|endoftext|> hello <|im_start|>']) {
  assert.equal(textTokens(s),countTokens(s,{allowedSpecial:new Set(),disallowedSpecial:new Set()}));
 }
 assert.notEqual(textTokens('🙂'.repeat(40)),40 / 4);
});
test('oldest-only trimming preserves full immutable latest request and authoritative systems',()=>{
 const messages: ModelMessage[] = [{role:'user',content:'old '.repeat(4000)}, {role:'assistant',content:'newer'},pinned,{role:'system',content:'immutable step permissions'}];
 const before=JSON.stringify(messages);
 const result=trimModelContext(messages,opts);
 assert.deepEqual(result,messages.slice(1));
 assert.equal(JSON.stringify(messages),before);
 assert.ok(result.includes(pinned));
});
test('tool call/result pairs including parallel spans are removed together without mutation',()=>{
 const parallel: ModelMessage[] = [pair[0]!, {role:'assistant',content:[{type:'tool-call',toolCallId:'two',toolName:'read',input:{}}]},pair[1]!,{role:'tool',content:[{type:'tool-result',toolCallId:'two',toolName:'read',output:{type:'text',value:'small'}}]}];
 const before=JSON.stringify(parallel);
 assert.deepEqual(trimModelContext([...parallel,pinned],opts),[pinned]);
 assert.equal(JSON.stringify(parallel),before);
});
test('overflow fails closed instead of slicing request, instructions or schemas',()=>{
 assert.throws(()=>trimModelContext([pinned],{...opts,limit:10}),ContextBudgetError);
 assert.throws(()=>trimModelContext([pinned],{...opts,schemaTokens:5000}),ContextBudgetError);
 assert.throws(()=>trimModelContext([pinned],{...opts,instructions:'safety '.repeat(5000)}),ContextBudgetError);
 assert.throws(()=>trimModelContext([{role:'user',content:'missing pin'}],opts),ContextBudgetError);
 assert.throws(()=>trimModelContext([pair[1]!,pinned],opts),/Orphan/);
});
test('images and files reserve conservative modality budget and older media goes first',()=>{
 const media: ModelMessage = {role:'user',content:[{type:'image',image:new Uint8Array([1,2,3])}]};
 assert.ok(messageTokens(media)>=32768);
 assert.deepEqual(trimModelContext([media,pinned],opts),[pinned]);
 assert.ok(messageTokens({role:'user',content:[{type:'file',data:new Uint8Array(40000),mediaType:'application/pdf'}]})>72768);
 assert.equal(trimModelContext([media,pinned],{...opts,limit:100000}).length,2);
});
test('tool definitions counted with actual JSON schema and output reserve',async()=>{
 const tools={read:tool({description:'Read file',inputSchema:z.object({path:z.string()})})};
 assert.ok(await toolTokens(tools)>64);
 assert.throws(()=>trimModelContext([pinned],{...opts,outputTokens:2000}),ContextBudgetError);
});
test('initial and every prepared step trim including worker inbox, preserving controls and latest request',async()=>{
 let inbox=true;
 const options=await budgetOptions({instructions:opts.instructions,messages:[{role:'user' as const,content:'old '.repeat(5000)},pinned],tools:{} as ToolSet,maxOutputTokens:100,
  prepareStep: ((step)=>({activeTools:[],messages:[...step.messages,...(inbox?[{role:'user' as const,content:'Parent follow-up untrusted '.repeat(4000)}]:[]),{role:'system' as const,content:'step safety'}]})) as PrepareStepFunction<ToolSet>},1800);
 assert.ok(options.messages.includes(pinned));
 assert.match(String(options.messages[0]!.content),/DEGRADED EXTRACTIVE/);
 const step={messages:[...options.messages,...pair]} as Parameters<PrepareStepFunction<ToolSet>>[0];
 const result=await options.prepareStep(step);
 assert.deepEqual(result?.activeTools,[]);
 assert.ok(result?.messages?.includes(pinned));
 assert.ok(result?.messages?.some(m=>m.role==='system'&&m.content==='step safety'));
 assert.ok(result?.messages?.some(m=>String(m.content).includes('ADVISORY RUNNING SUMMARY')));
 inbox=false;
 const next=await options.prepareStep({messages:result!.messages!} as Parameters<PrepareStepFunction<ToolSet>>[0]);
 assert.ok(next?.messages?.includes(pinned));
});
test('both generation sites use initial/per-step wrapper, worker request has no character cut',()=>{
 for(const file of ['brain','worker']){
  const source=readFileSync(new URL(`../src/${file}.ts`,import.meta.url),'utf8');
  assert.match(source,/await budgetOptions\(/);
  assert.match(source,new RegExp(`config\.${file==='brain'?'chat':'worker'}ContextTokens`));
 }
 const source=readFileSync(new URL('../src/worker.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/originalRequest\.slice/);
});
test('env caps default 256000, reject fractional and out-of-range values',()=>{
 const script="import {config} from './src/config.ts'; console.log(config.chatContextTokens,config.workerContextTokens)";
 const run=(a:string,b:string)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...process.env,CHAT_CONTEXT_TOKENS:a,WORKER_CONTEXT_TOKENS:b},encoding:'utf8'});
 assert.match(run('256000','256000').stdout,/256000 256000/);
 assert.notEqual(run('4096.5','256000').status,0);
 assert.notEqual(run('256000','0').status,0);
 assert.match(run('8192','16384').stdout,/8192 16384/);
});
