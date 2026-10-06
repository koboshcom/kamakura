import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseReply } from '../src/reply.ts';

test('skips silent replies', () => assert.deepEqual(parseReply('<skip>', 3, 100), { skip: true, messages: [] }));

test('splits replies and limits output', () => {
  assert.deepEqual(parseReply('one\n\n two \n\nthree\n\nfour', 3, 4).messages, ['one', 'two', 'thre']);
});

test('accepts emoji reactions only', () => {
  assert.equal(parseReply('<react:😂>', 3, 100).reaction, '😂');
  assert.equal(parseReply('<react:hello>', 3, 100).reaction, undefined);
});
