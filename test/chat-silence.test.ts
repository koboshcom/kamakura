import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatTools } from '../src/chat-tools.js';
import { chatDelivery } from '../src/chat-delivery.js';
import type { HistoryStore } from '../src/history.js';
import type { IncomingMessage, Transport } from '../src/types.js';

const options = { toolCallId: 'silence-test', messages: [] };
const incoming: IncomingMessage = { transport: 'telegram', chatId: '6612253937', senderId: '6612253937', sender: 'owner', id: '1', text: 'a personal update', timestamp: 1, isGroup: false };
function fixture(message = incoming) {
  const sent: string[] = [], recorded: string[] = [], reactions: string[] = [];
  let active = true;
  // These tests never search history or access persistence.
  const tools = chatTools(message, {} as HistoryStore, {
    current: () => active,
    send: async text => { sent.push(text); },
    react: async emoji => { reactions.push(emoji); },
  }, [], text => recorded.push(text));
  return { tools, sent, recorded, reactions, cancel: () => { active = false; } };
}

test('explicit end_turn is genuinely silent, including intentional DM and ambient group silence', async () => {
  for (const message of [incoming, { ...incoming, text: 'please do not reply' }, { ...incoming, isGroup: true, addressed: false }]) {
    const f = fixture(message);
    assert.deepEqual(await f.tools.end_turn.execute!({}, options), { finished: true });
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.recorded, []);
    assert.deepEqual(f.reactions, []);
  }
});

test('end_turn after delivery never sends again; duplicate bubbles do not report success', async () => {
  const f = fixture();
  assert.deepEqual(await f.tools.send_message.execute!({ text: 'one thought' }, options), { sent: true });
  const duplicate = await f.tools.send_message.execute!({ text: 'one thought' }, options) as { sent: boolean };
  assert.equal(duplicate.sent, false);
  assert.deepEqual(await f.tools.end_turn.execute!({}, options), { finished: true });
  assert.deepEqual(f.sent, ['one thought']);
  assert.deepEqual(f.recorded, ['one thought']);
});

test('a legitimate reaction ends without an added text bubble', async () => {
  const f = fixture();
  assert.ok(f.tools.react, 'focused test configuration must enable reactions');
  assert.deepEqual(await f.tools.react!.execute!({ emoji: '👍' }, options), { reacted: true });
  assert.deepEqual(await f.tools.end_turn.execute!({}, options), { finished: true });
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.reactions, ['👍']);
});

test('cancelled or stale turns cannot end successfully or send a replacement', async () => {
  const f = fixture(); f.cancel();
  await assert.rejects(() => f.tools.end_turn.execute!({}, options) as Promise<unknown>, /superseded/);
  await assert.rejects(() => f.tools.send_message.execute!({ text: 'late' }, options) as Promise<unknown>, /superseded/);
  await assert.rejects(() => f.tools.react!.execute!({ emoji: '👍' }, options) as Promise<unknown>, /superseded/);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.recorded, []); assert.deepEqual(f.reactions, []);
});

test('aborted send and cancellation while pacing never deliver or record invented success', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(() => f.tools.send_message.execute!({ text: 'aborted' }, { ...options, abortSignal: abort.signal }) as Promise<unknown>);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.recorded, []);
  let active = true, started = 0;
  const delivered: string[] = [];
  const delivery = chatDelivery({ send: async () => { throw Error('must not send'); } } as unknown as Transport, incoming, {
    current: () => active, deliveryStarted: () => { started++; }, pace: async () => { active = false; }, delivered: async text => { if (text) delivered.push(text); },
  });
  const tools = chatTools(incoming, {} as HistoryStore, delivery, [], text => delivered.push(text));
  await assert.rejects(() => tools.send_message.execute!({ text: 'stale after pause' }, options) as Promise<unknown>, /superseded/);
  assert.equal(started, 0); assert.deepEqual(delivered, []);
});

test('delivery prompt distinguishes activity completion from conversational closure without hardcoded examples', () => {
  const brain = readFileSync('src/brain.ts', 'utf8');
  assert.match(brain, /stopping an activity with asking you to stop replying/);
  assert.match(brain, /Honor explicit requests for silence/);
  assert.match(brain, /Never manufacture a reply after delivery, cancellation or a stale turn/);
});
