import test from 'node:test';
import assert from 'node:assert/strict';
import { think, reminders } from '../src/brain.js';
import { config } from '../src/config.js';
import { sandboxes } from '../src/sandbox.js';
import { chatStyle } from '../src/chat-style.js';

test('chat can recover from a tool failure across more than five real SDK steps', async () => {
  const fetch = globalThis.fetch, run = sandboxes.run, key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  config.telegramAllowed.add('987654321'); config.sandbox.allowed.add('987654321');
  let calls = 0, commands = 0;
  sandboxes.run = async () => { commands++; if (commands === 1) throw new Error('first approach failed'); return { output: 'verified', exitCode: 0, timedOut: false }; };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    assert.match(JSON.stringify(body.input.at(-1)), /diagnose and try another/);
    if (calls === 2) assert.match(JSON.stringify(body.input), /first approach failed/);
    const output = calls < 7
      ? [{ type: 'function_call', id: `fc_${calls}`, call_id: `call_${calls}`, name: 'run_command', arguments: JSON.stringify({command: `check-${calls}`}), status: 'completed' }]
      : [{type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'checked. fixed', annotations: []}]}];
    return new Response(JSON.stringify({id: `resp_${calls}`, created_at: 1, model: config.model, status: 'completed', output, usage: {input_tokens: 10, output_tokens: 10, total_tokens: 20}}), {headers: {'content-type': 'application/json'}});
  };
  try {
    assert.equal(await think([], {transport: 'telegram', chatId: '987654321', senderId: '987654321', sender: 'owner', id: '1', text: 'check and fix the issue', isGroup: false, timestamp: 0}), 'checked. fixed');
    assert.equal(calls, 7); assert.equal(commands, 6);
    assert(!chatStyle(4).includes('tailscale'));
  } finally {
    globalThis.fetch = fetch; sandboxes.run = run;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    config.telegramAllowed.delete('987654321'); config.sandbox.allowed.delete('987654321'); await reminders.close();
  }
});
