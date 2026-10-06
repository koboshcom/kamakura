// Run inside built core via stdin. Does not send Telegram messages or print secrets.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from './dist/config.js';
import { runWorker } from './dist/worker.js';
import { workTools } from './dist/work-tools.js';
import { sandboxes } from './dist/sandbox.js';
const owner = '6612253937';
const filename = `live-worker-${randomUUID()}.txt`;
const text = `Startup tool check. Create ${filename} containing exactly alpha. Edit alpha to beta using edit_file. Read it with read_file, find it with list_files using the exact filename, and grep beta using that filename glob. Report the verified result. Do not modify anything else or access keys. No web fetch is needed.`;
const incoming = { transport: 'telegram', chatId: owner, senderId: owner, sender: 'live test', id: filename, text, isGroup: false, timestamp: Date.now() };
const tools = workTools(incoming);
const options = { toolCallId: 'live-check', messages: [] };
const progress = [];
let followupDelivered = false;
try {
  const reply = await runWorker({ id: randomUUID(), task: text, incoming,
    takeMessages() { if (followupDelivered) return []; followupDelivered = true; return ['The final response must contain worker-tools-ok after verification.']; },
    async sendMessage(message) { progress.push(message); return { sent: true }; },
  }, AbortSignal.timeout(180000));
  assert.ok(followupDelivered);
  assert.match(reply, /worker-tools-ok/i);
  const result = await tools.read_file.execute({ path: filename, offset: 0 }, options);
  assert.ok(JSON.stringify(result).includes('beta'));
  console.log('PASS actual high-effort Responses worker, follow-up context and persistent file tools');
  console.log('Progress messages', progress.length);
  console.log('Worker response', JSON.stringify(reply));
} finally { sandboxes.stop(); }
