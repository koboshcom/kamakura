import test from 'node:test';import assert from 'node:assert/strict';import type {ModelMessage} from 'ai';
import {elideOldToolOutputs} from '../src/tool-elision.js';import {messageTokens,trimModelContext} from '../src/context-budget.js';
function fixture(name='read_file',value:Record<string,unknown>={text:'ordinary document '.repeat(2000),nextOffset:null}):ModelMessage[]{
 return [{role:'assistant',content:[{type:'tool-call',toolCallId:'r',toolName:name,input:{path:'file'}}]},
 {role:'tool',content:[{type:'tool-result',toolCallId:'r',toolName:name,output:{type:'json',value:value as never}}]},
 ...Array.from({length:8},()=>({role:'user' as const,content:'recent evidence'}))];
}
test('old completed passive read retains envelope/metadata, saves tokens, and never mutates source',()=>{
 const messages=fixture(),before=JSON.stringify(messages),result=elideOldToolOutputs(messages);
 assert.equal(JSON.stringify(messages),before);assert.equal(result[0],messages[0]);
 assert.ok(messageTokens(result[1]!)<messageTokens(messages[1]!));
 assert.match(JSON.stringify(result[1]),/elided/);
 const pinned=result.at(-1)!;
 assert.ok(trimModelContext(result,{limit:5000,instructions:'safety',pinned,schemaTokens:0,outputTokens:100}).includes(pinned));
});
test('recent/active results, failures, paged reads, approvals, task statuses and history stay intact',()=>{
 for(const name of ['run_command','exec_py','search_history','worker_status','write_file','edit_file']){const messages=fixture(name);assert.deepEqual(elideOldToolOutputs(messages),messages);}
 for(const value of [{text:'ordinary '.repeat(2000),nextOffset:4096},{text:'approval needed '.repeat(1000),nextOffset:null},{text:'failure '.repeat(1000),nextOffset:null}]){
 const messages=fixture('read_file',value);assert.deepEqual(elideOldToolOutputs(messages),messages);
 }
 const recent=fixture().slice(0,2);assert.deepEqual(elideOldToolOutputs(recent),recent);
 const incomplete=fixture();incomplete.splice(0,1);assert.deepEqual(elideOldToolOutputs(incomplete),incomplete);
 const web=fixture('web_fetch',{text:'ordinary '.repeat(2000),status:200,truncated:false,url:'https://example.test'});assert.match(JSON.stringify(elideOldToolOutputs(web)[1]),/example.test/);assert.match(JSON.stringify(elideOldToolOutputs(web)[1]),/elided/);
 const error=fixture('web_fetch',{text:'ordinary '.repeat(2000),status:403,truncated:false});assert.deepEqual(elideOldToolOutputs(error),error);
});
