import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverReply } from '../src/delivery.js';
import { parseReply } from '../src/reply.js';
import { chatStyle } from '../src/chat-style.js';
import type { IncomingMessage, Transport } from '../src/types.js';
const incoming: IncomingMessage = {transport:'telegram',chatId:'123',senderId:'123',sender:'owner',id:'1',text:'hey',timestamp:0,isGroup:false};

test('split replies send separate bubbles in order and record only sent messages', async () => {
  const sent: string[] = []; const recorded: string[] = []; const pauses: number[] = [];
  const transport = { send: async (_id: string, text: string) => { sent.push(text); } } as Transport;
  await deliverReply(parseReply('first\n\nsecond', 3, 100), incoming, transport, () => true,
    text => recorded.push(text), 50, async ms => { pauses.push(ms); });
  assert.deepEqual(sent, ['first','second']); assert.deepEqual(recorded,sent); assert.deepEqual(pauses,[50]);
});
test('a newer batch stops unsent bubbles after the pause', async () => {
  let valid = true; const sent: string[] = []; const recorded: string[] = [];
  const transport = { send: async (_id: string, text: string) => { sent.push(text); } } as Transport;
  await deliverReply(parseReply('first\n\nsecond', 3, 100), incoming, transport, () => valid,
    text => recorded.push(text), 50, async () => { valid = false; });
  assert.deepEqual(sent,['first']); assert.deepEqual(recorded,['first']);
});
test('turn reinforcement uses bounded bubbles without new permissions', () => {
  assert.match(chatStyle(3), /at most 3/);
  assert.match(chatStyle(3), /does not change permissions/);
  assert.match(chatStyle(3), /No em dashes/);
});
