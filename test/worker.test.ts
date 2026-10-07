import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { canWork, workTools } from '../src/work-tools.js';
import { runWorker } from '../src/worker.js';
import { sandboxes } from '../src/sandbox.js';
import type { IncomingMessage } from '../src/types.js';

const incoming: IncomingMessage = { transport: 'telegram', chatId: '123', senderId: '123', sender: 'owner', id: '1', text: 'run printf worker-ok', isGroup: false, timestamp: 0 };

test('worker restricts tools to authorized sender DM and checks cancellation', async () => {
  config.telegramAllowed.add('123'); config.sandbox.allowed.add('123');
  try {
    assert.equal(canWork(incoming), true);
    config.telegramAllowed.add('-123');
    assert.equal(canWork({ ...incoming, isGroup: true, chatId: '-123' }), true);
    config.telegramAllowed.delete('-123');
    for (const message of [{ ...incoming, isGroup: true, chatId: '-456' }, { ...incoming, chatId: '456' }, { ...incoming, senderId: undefined }, { ...incoming, senderId: '456', chatId: '456' }]) {
      assert.equal(canWork(message), false);
      assert.deepEqual(workTools(message), {});
    }
    const controller = new AbortController(); controller.abort();
    const tools = workTools(incoming, controller.signal);
    await assert.rejects(async () => tools.run_command!.execute!({ command: 'printf unsafe' }, { toolCallId: '1', messages: [] }));
  } finally { config.telegramAllowed.delete('123'); config.sandbox.allowed.delete('123'); }
});

test('worker sends high effort Responses request, executes sender sandbox tool and returns result', async () => {
  const originalFetch = globalThis.fetch;
  const originalRun = sandboxes.run;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  config.telegramAllowed.add('123'); config.sandbox.allowed.add('123');
  let requests = 0; let executed = false;
  sandboxes.run = async (owner, command) => { assert.equal(owner, '123'); assert.equal(command, 'printf worker-ok'); executed = true; return { output: 'worker-ok', exitCode: 0, timedOut: false }; };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.reasoning.effort, config.workerEffort);
    assert.equal(body.store, false);
    assert.ok(body.tools.some((t: { name?: string }) => t.name === 'run_command'));
    assert.ok(body.tools.some((t: { name?: string }) => t.name === 'exec_py'));
    assert.ok(!body.tools.some((t: { name?: string }) => t.name === 'start_worker'));
    for (const name of ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'web_fetch', 'send_message']) assert.ok(body.tools.some((t: { name?: string }) => t.name === name));
    assert.ok(!body.tools.some((t: { name?: string }) => t.name === 'ssh_public_key'));
    assert.match(JSON.stringify(body.input), /followup-test/);
    requests++;
    const output = requests === 1 ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'run_command', arguments: JSON.stringify({ command: 'printf worker-ok' }), status: 'completed' }] : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'worker-ok', annotations: [] }] }];
    return new Response(JSON.stringify({ id: 'resp_test', created_at: 1, model: config.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    let followupRead = false;
    assert.equal(await runWorker({ id: 'test', incoming, task: 'Run the requested command and report output',
      takeMessages: () => { if (followupRead) return []; followupRead = true; return ['followup-test']; },
      sendMessage: async () => ({ sent: true }),
    }, new AbortController().signal), 'worker-ok');
    assert.equal(requests, 2); assert.equal(executed, true);
  } finally {
    globalThis.fetch = originalFetch; sandboxes.run = originalRun;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    config.telegramAllowed.delete('123'); config.sandbox.allowed.delete('123');
  }
});
