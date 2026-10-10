import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../src/chat-completion.js';
import { chatTools } from '../src/chat-tools.js';
import type { HistoryStore } from '../src/history.js';
const options = { toolCallId: 'completion', messages: [] };
const incoming = { transport: 'telegram' as const, chatId: '1', senderId: '1', sender: 'owner', id: '1', text: 'hello', timestamp: 1, isGroup: false };
function setup() {
  const state = chatCompletion(), sent: string[] = [];
  let active = true;
  const tools = chatTools(incoming, {} as HistoryStore, { current: () => active, send: async text => { sent.push(text); }, react: async () => {} }, [], (_text, purpose, finish) => state.delivered(purpose, finish));
  return { state, tools, sent, cancel: () => { active = false; } };
}
test('a successful final casual send stops generation without needing another model step', async () => {
  const f = setup();
  assert.equal(f.state.canStop(false), false);
  await f.tools.send_message.execute!({ text: 'one thought', purpose: 'chat', finish_turn: true }, options);
  assert.equal(f.state.canStop(false), true);
  assert.deepEqual(f.sent, ['one thought']);
});
test('genuinely additive extra bubbles remain available, then final delivery stops', async () => {
  const f = setup();
  await f.tools.send_message.execute!({ text: 'first point', purpose: 'chat', finish_turn: false }, options);
  assert.equal(f.state.canStop(false), false);
  await f.tools.send_message.execute!({ text: 'a distinct second point', purpose: 'chat', finish_turn: true }, options);
  assert.equal(f.state.canStop(false), true);
  assert.deepEqual(f.sent, ['first point', 'a distinct second point']);
});
test('progress, artifacts/results, legacy sends and pending work cannot be auto-completed', async () => {
  for (const purpose of ['progress', 'answer', undefined]) {
    const f = setup();
    await f.tools.send_message.execute!({ text: 'result', purpose, finish_turn: true }, options);
    assert.equal(f.state.canStop(false), false);
  }
  const f = setup();
  await f.tools.send_message.execute!({ text: 'checking', purpose: 'chat', finish_turn: true }, options);
  assert.equal(f.state.canStop(true), false);
});
test('quiet and reaction endings do not invent a send or a completion flag', async () => {
  const f = setup();
  await f.tools.end_turn.execute!({}, options);
  assert.equal(f.state.canStop(false), false); assert.deepEqual(f.sent, []);
  await f.tools.react!.execute!({ emoji: '👍' }, options);
  assert.equal(f.state.canStop(false), false); assert.deepEqual(f.sent, []);
});
test('stale, cancelled and aborted sends neither deliver nor complete', async () => {
  const f = setup(); f.cancel();
  await assert.rejects(() => f.tools.send_message.execute!({ text: 'late', purpose: 'chat', finish_turn: true }, options) as Promise<unknown>, /superseded/);
  assert.equal(f.state.canStop(false), false); assert.deepEqual(f.sent, []);
  const g = setup(), controller = new AbortController(); controller.abort();
  await assert.rejects(() => g.tools.send_message.execute!({ text: 'aborted', purpose: 'chat', finish_turn: true }, { ...options, abortSignal: controller.signal }) as Promise<unknown>);
  assert.equal(g.state.canStop(false), false); assert.deepEqual(g.sent, []);
});
test('a duplicate is not delivered and cannot forge a final completion', async () => {
  const f = setup();
  await f.tools.send_message.execute!({ text: 'same', purpose: 'chat', finish_turn: false }, options);
  const result = await f.tools.send_message.execute!({ text: 'same', purpose: 'chat', finish_turn: true }, options) as { sent: boolean };
  assert.equal(result.sent, false); assert.equal(f.state.canStop(false), false); assert.deepEqual(f.sent, ['same']);
});
test('uncertain transport failure never creates success or a stop flag', async () => {
  const state = chatCompletion(); let attempts = 0;
  const tools = chatTools(incoming, {} as HistoryStore, { current: () => true, send: async () => { attempts++; throw Error('uncertain network failure'); }, react: async () => {} }, [], (_text, purpose, finish) => state.delivered(purpose, finish));
  await assert.rejects(() => tools.send_message.execute!({ text: 'uncertain', purpose: 'chat', finish_turn: true }, options) as Promise<unknown>, /uncertain network failure/);
  assert.equal(state.canStop(false), false); assert.equal(attempts, 1);
  const duplicate = await tools.send_message.execute!({ text: 'uncertain', purpose: 'chat', finish_turn: true }, options) as { sent: boolean };
  assert.equal(duplicate.sent, false); assert.equal(state.canStop(false), false); assert.equal(attempts, 1);
});
