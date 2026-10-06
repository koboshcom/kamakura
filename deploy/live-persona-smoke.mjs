// Run in built core via stdin. No secrets or private key material printed.
import assert from 'node:assert/strict';
import { config } from './dist/config.js';
import { think, reminders } from './dist/brain.js';
import { sandboxes } from './dist/sandbox.js';
import { workTools } from './dist/work-tools.js';
const owners = ['6612253937', '7853500388'];
assert.deepEqual([...config.telegramAllowed].sort(), [...owners].sort());
assert.deepEqual([...config.sandbox.allowed].sort(), [...owners].sort());
assert.equal(config.reasoningEffort, 'low');
assert.equal(config.workerEffort, 'high');
console.log('PASS exact two-owner access and independent low/high efforts');
const incoming = { transport: 'telegram', chatId: owners[0], senderId: owners[0], sender: 'live test', id: 'persona-smoke', text: 'hey bbg', isGroup: false, addressed: true, timestamp: Date.now() };
const tools = workTools(incoming);
assert.ok(!('ssh_public_key' in tools));
for (const name of ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'web_fetch', 'run_command', 'exec_py']) assert.ok(name in tools, name);
console.log('PASS full coding toolset without special-case SSH tool');
if (process.env.LIVE_TEST_OPENAI === 'true') {
  const answer = await think([{ role: 'user', sender: 'live test', text: incoming.text, at: Date.now() }], incoming);
  assert.ok(answer.trim());
  assert.doesNotMatch(answer, /<skip>|questionable plan|what can i help|the step|sexual content/i);
  console.log('PASS real Responses greeting, no canned quip or refusal');
  console.log('Greeting response', JSON.stringify(answer));
}
reminders.close();
sandboxes.stop();
