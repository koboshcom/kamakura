import test from 'node:test';
import assert from 'node:assert/strict';
import {finalResultText} from '../src/chat-final-text.js';
import {chatTools} from '../src/chat-tools.js';
import {chatCompletion} from '../src/chat-completion.js';
test('final prose cannot send after zero, one or multiple explicit bubbles',async()=>{
 for(const n of [0,1,3]){
 const sent:string[]=[];const completion=chatCompletion();
 const tools=chatTools({transport:'telegram',chatId:'1',senderId:'1',sender:'owner',id:'1',text:'hi',isGroup:false,timestamp:1},{} as any,{current:()=>true,send:async t=>{sent.push(t);},react:async()=>{}},[],(_t,p,f)=>completion.delivered(p,f));
 for(let i=0;i<n;i++)await tools.send_message.execute!({text:['first thought','another detail','last thought'][i],purpose:'chat',finish_turn:i===n-1},{toolCallId:'test',messages:[]});
 assert.equal(finalResultText('unsolicited final prose',true),'');assert.equal(sent.length,n);assert.equal(completion.canStop(false),n>0);
 }
 assert.equal(finalResultText('worker result',false),'worker result');
});
test('consecutive near-identical bubbles suppressed while distinct additions continue',async()=>{
 const sent:string[]=[];const tools=chatTools({transport:'telegram',chatId:'1',id:'1',text:'hi',sender:'owner',isGroup:false,timestamp:1},{} as any,{current:()=>true,send:async t=>{sent.push(t);},react:async()=>{}},[],()=>{});
 const opts={toolCallId:'test',messages:[]};
 await tools.send_message.execute!({text:'hi there',purpose:'chat',finish_turn:false},opts);
 const duplicate:any=await tools.send_message.execute!({text:'Hi, there!',purpose:'chat',finish_turn:false},opts);
 assert.equal(duplicate.sent,false);
 await tools.send_message.execute!({text:'new useful detail',purpose:'chat',finish_turn:true},opts);
 assert.deepEqual(sent,['hi there','new useful detail']);
});
test('semantic emoji and symbol differences remain distinct',async()=>{
 const sent:string[]=[];const tools=chatTools({transport:'telegram',chatId:'1',id:'1',text:'hi',sender:'owner',isGroup:false,timestamp:1},{} as any,{current:()=>true,send:async t=>{sent.push(t);},react:async()=>{}},[],()=>{});
 const opts={toolCallId:'symbols',messages:[]};
 for(const text of ['choice 👍','choice 👎','value +'])await tools.send_message.execute!({text,purpose:'chat',finish_turn:false},opts);
 assert.deepEqual(sent,['choice 👍','choice 👎','value +']);
});
