import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanHistoryReply, asksForExactHistory} from '../src/history-reply.js';

test('history recall delivery removes wrapping marks without changing spelling or contractions', () => {
  for (const text of ['you said "wsg".', 'you said “wsg”.', 'you said `wsg`.', "you said 'wsg'.", 'you said ‘wsg’.']) {
    assert.equal(cleanHistoryReply(text, 'what did i say first?', true), 'you said wsg.');
  }
  assert.equal(cleanHistoryReply('```text\nWsg\n```', 'what did i say first?', true), 'Wsg');
  assert.equal(cleanHistoryReply("you said you don't know; that's all.", 'what did i say?', true), "you said you don't know; that's all.");
});
test('exact requested history and non-recall replies keep original marks', () => {
  for (const request of ['quote my first message', 'give the exact full text', 'say it verbatim', 'preserving its original capitalization and punctuation']) {
    assert.equal(asksForExactHistory(request), true);
    assert.equal(cleanHistoryReply('“Meet HERE.” `Code`', request, true), '“Meet HERE.” `Code`');
  }
  assert.equal(cleanHistoryReply('use `python` and "a"', 'write code', false), 'use `python` and "a"');
  assert.equal(asksForExactHistory("don't quote my first message"), false);
});
