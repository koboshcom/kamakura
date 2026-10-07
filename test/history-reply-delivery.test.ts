import test from 'node:test';
import assert from 'node:assert/strict';
import {chatTools} from '../src/chat-tools.js';
import {config} from '../src/config.js';
import type {HistoryStore} from '../src/history.js';
const options={toolCallId:'recall-cleanup',messages:[],context:{}};

test('recall cleanup applies to explicit delivery after lookup but preserves requested exact quotes', async () => {
  const owner='6612253937';config.sandbox.allowed.add(owner);
  const history={lookup:async()=>({messages:[],context:[]})} as unknown as HistoryStore;
  for(const [request,expected] of [['what did i say first?', 'you said wsg.'], ['quote my first message', 'you said “wsg”.']]) {
    const incoming={transport:'telegram' as const,chatId:owner,senderId:owner,sender:'owner',id:'1',text:request!,timestamp:1,isGroup:false};
    const sent:string[]=[];
    const tools=chatTools(incoming,history,{send:async text=>{sent.push(text);},react:async()=>{},current:()=>true},[],()=>{});
    await tools.search_history.execute!({query:'',limit:8,order:'earliest',role:'user',exact:false},options);
    await tools.send_message.execute!({text:'you said “wsg”.'},options);
    assert.deepEqual(sent,[expected]);
  }
});

test('ordinary delivery leaves formatting alone without a history lookup',async()=>{
  const incoming={transport:'telegram' as const,chatId:'6612253937',senderId:'6612253937',sender:'owner',id:'1',text:'write a command',timestamp:1,isGroup:false};
  const sent:string[]=[];
  const tools=chatTools(incoming,{} as HistoryStore,{send:async text=>{sent.push(text);},react:async()=>{},current:()=>true},[],()=>{});
  await tools.send_message.execute!({text:'run `pwd`'},options);
  assert.deepEqual(sent,['run `pwd`']);
});
