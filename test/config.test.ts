import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReasoningEffort } from '../src/config.js';

test('reasoning effort defaults to xhigh and accepts all configured levels', () => {
  assert.equal(parseReasoningEffort(), 'xhigh');
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(parseReasoningEffort(effort), effort);
  }
});

test('invalid or empty reasoning effort fails closed', () => {
  for (const effort of ['', 'HIGH', 'minimal', 'invalid']) {
    assert.throws(() => parseReasoningEffort(effort), /OPENAI_REASONING_EFFORT/);
  }
});
