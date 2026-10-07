// Run inside built core after sandbox image build. Never logs configured secrets.
// From project root, pipe into docker compose exec -T -e LIVE_TEST_USER=ID
// core node --input-type=module. Core cwd must be /app.
import assert from 'node:assert/strict';
import { sandboxes } from './dist/sandbox.js';
import { think } from './dist/brain.js';
const user = process.env.LIVE_TEST_USER;
assert.ok(user && sandboxes.authorized(user), 'Set LIVE_TEST_USER to an allowlisted Telegram ID');
const result = await sandboxes.run(user, 'printf "shell-ok\\n"; id -u; printf "persistent-ok" > /work/live-smoke.txt');
assert.equal(result.exitCode, 0);
assert.match(result.output, /shell-ok\n1000/);
console.log('PASS real run_command, uid 1000 and workspace write');
const first = await sandboxes.execPython(user, 'live_smoke_value = 41\nlog(live_smoke_value)\ndisplay(pyautogui.screenshot())');
assert.match(first.text, /41/);
assert.equal(first.images.length, 1);
assert.ok(Buffer.from(first.images[0], 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
console.log('PASS persistent desktop worker and PNG screenshot');
const second = await sandboxes.execPython(user, 'log(live_smoke_value + 1)\nb = get_browser()\np = b.new_page()\np.set_content("<title>live-smoke</title><p>browser-ok</p>")\nlog(p.title())\np.close()');
assert.match(second.text, /42/);
assert.match(second.text, /live-smoke/);
console.log('PASS Python globals persist and visible Playwright Chromium works');
if (process.env.LIVE_TEST_OPENAI === 'true') {
  const incoming = { transport: 'telegram', chatId: user, id: 'live-smoke', senderId: user, sender: 'live test', text: 'Say a short hello. This is a startup check.', isGroup: false, addressed: true, timestamp: Date.now() };
  const reply = await think([{ role: 'user', text: incoming.text, sender: incoming.sender, at: incoming.timestamp }], incoming);
  assert.ok(reply.trim() && !reply.includes('<skip>'));
  console.log('PASS configured OpenAI model returns a reply');
}
sandboxes.stop();
await (await import('./dist/brain.js')).reminders.close();
await (await import('./dist/mongo.js')).closeMongo();
