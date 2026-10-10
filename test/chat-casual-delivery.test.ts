import test from 'node:test';
import assert from 'node:assert/strict';
import { chatTools } from '../src/chat-tools.js';
import { chatCompletion } from '../src/chat-completion.js';
import { HistoryStore } from '../src/history.js';

test('casual brevity leaves additive bubbles, native reactions, quiet closure and stale cancellation intact', async () => {
  let active = true;
  const sent: string[] = [], reactions: string[] = [];
  const completion = chatCompletion();
  const incoming = {transport:'telegram' as const,chatId:'7853500388',senderId:'7853500388',sender:'owner',id:'1',text:'two separate messages',timestamp:1,isGroup:false};
  // No history operations in this delivery-only control, so no storage or migration.
  const history = Object.create(HistoryStore.prototype) as HistoryStore;
  const tools = chatTools(incoming, history, {current:()=>active,send:async text=>{sent.push(text);},react:async emoji=>{reactions.push(emoji);}}, [], (_text,purpose,finish)=>completion.delivered(purpose,finish));
  const options = {toolCallId:'delivery-control',messages:[]};
  await tools.send_message.execute!({text:'plain wood',purpose:'chat',finish_turn:false},options);
  assert.equal(completion.canStop(false),false);
  await tools.send_message.execute!({text:'the grain is enough decoration',purpose:'chat',finish_turn:true},options);
  assert.equal(completion.canStop(false),true);
  assert.equal(sent.length,2);
  await tools.react!.execute!({emoji:'👍'},options);
  assert.deepEqual(reactions,['👍']);
  await tools.end_turn.execute!({},options);
  assert.equal(sent.length,2);
  active=false;
  await assert.rejects(()=>tools.send_message.execute!({text:'stale'},options) as Promise<unknown>,/superseded/);
});
