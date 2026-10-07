import test from 'node:test';import assert from 'node:assert/strict';
import {HistoryStore} from '../src/history.js';import {chatTools} from '../src/chat-tools.js';import {config} from '../src/config.js';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const options={toolCallId:'t',messages:[]};
test('explicit tools serialize bubbles and validate reactions/reply targets; owner search finds beyond recent window',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chattools-'));const owner='6612253937';config.sandbox.allowed.add(owner);
 try{const history=new HistoryStore(dir,2);history.add(`telegram:${owner}`,{role:'user',senderId:owner,id:'1',text:'the old project was lunar wrench',at:1});for(let n=2;n<8;n++)history.add(`telegram:${owner}`,{role:'user',senderId:owner,id:String(n),text:'recent',at:n});
 const incoming={transport:'telegram' as const,chatId:owner,senderId:owner,sender:'owner',id:'7',text:'hi',timestamp:7,isGroup:false};const sent:string[]=[];let active=true;
 const tools=chatTools(incoming,history,{send:async(text,id)=>{sent.push(`${text}/${id??''}`);},react:async emoji=>{sent.push(emoji);},current:()=>active},history.get(`telegram:${owner}`),()=>{});
 const result=await tools.search_history.execute!({query:'lunar wrench',limit:8},options) as {messages:{id:string}[]};assert.equal(result.messages[0].id,'1');
 await Promise.all([tools.send_message.execute!({text:'first',reply_to:'1'},options),tools.send_message.execute!({text:'second'},options)]);assert.deepEqual(sent,['first/1','second/']);
 await assert.rejects(()=>tools.send_message.execute!({text:'no',reply_to:'999'},options) as Promise<unknown>,/known message/);
 await tools.react!.execute!({emoji:'👍'},options);active=false;await assert.rejects(()=>tools.send_message.execute!({text:'stale'},options) as Promise<unknown>,/superseded/);
 assert.equal(new HistoryStore(dir,2).search(`telegram:${owner}`,owner,'lunar').length,1);assert.equal(history.search('telegram:-123',owner,'lunar').length,0);
 history.add(`telegram:${owner}`,{role:'user',senderId:owner,text:'https://u:dummysecret@example.test?token=dummyquerysecret',at:9});assert.ok(!readFileSync(join(dir,'history-archive.json'),'utf8').includes('dummysecret'));assert.ok(!readFileSync(join(dir,'history-archive.json'),'utf8').includes('dummyquerysecret'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
