// Run in built core via stdin. No private key material is printed.
import assert from 'node:assert/strict';
import { config } from './dist/config.js';
import { workTools } from './dist/work-tools.js';
import { think } from './dist/brain.js';
import { sandboxes } from './dist/sandbox.js';
const owners = ['6612253937', '7853500388'];
assert.deepEqual([...config.telegramAllowed].sort(), [...owners].sort());
assert.deepEqual([...config.sandbox.allowed].sort(), [...owners].sort());
console.log('PASS exact two-user chat and sandbox allowlists');
const incoming = { transport: 'telegram', chatId: owners[0], senderId: owners[0], sender: 'live test', id: 'persona-smoke', text: 'give me your ssh public key', isGroup: false, addressed: true, timestamp: Date.now() };
const tool = workTools(incoming).ssh_public_key;
assert.ok(tool);
const call = () => tool.execute({}, { toolCallId: 'smoke', messages: [] });
const first = await call();
const second = await call();
assert.deepEqual(first, second);
assert.match(first.publicKey, /^ssh-ed25519 /);
assert.doesNotMatch(first.publicKey, /PRIVATE/);
console.log('PASS real sandbox SSH public key generation and repeated-request persistence');
const perms = await sandboxes.run(owners[0], 'stat -c %a /workspace/.ssh /workspace/.ssh/id_ed25519; ssh-keygen -lf /workspace/.ssh/id_ed25519.pub');
assert.equal(perms.exitCode, 0);
assert.match(perms.output, /^700\n600\n/);
console.log('PASS private-key permissions and valid public-key fingerprint');
if (process.env.LIVE_TEST_OPENAI === 'true') {
  const reply = await think([{ role: 'user', sender: 'live test', text: incoming.text, at: Date.now() }], incoming);
  assert.ok(reply.includes(first.publicKey), 'Model must return exact case-sensitive generated public key');
  assert.doesNotMatch(reply, /PRIVATE KEY|i don.t have/i);
  console.log('PASS real Responses model retrieves SSH tool result and returns exact public key');
  const banter = { ...incoming, text: 'femboy cat. you look like you judge my code before reading it.' };
  const answer = await think([
    { role: 'user', sender: 'live test', text: 'what are you enjoying?', at: Date.now() - 2000 },
    { role: 'assistant', text: 'the sun, briefly. you?', at: Date.now() - 1000 },
    { role: 'user', sender: 'live test', text: banter.text, at: Date.now() },
  ], banter);
  assert.ok(answer.trim());
  assert.doesNotMatch(answer, /<skip>|the step|sexual content/i);
  console.log('PASS harmless banter gets a reply without step fixation or sexual refusal');
  console.log('Banter smoke response', JSON.stringify(answer));
}
sandboxes.stop();
