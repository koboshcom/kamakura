// Actual-model desktop issuance and delivery, entirely captured rather than sent to Telegram.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-desktop-tool-live-'));
process.env.DATA_DIR = dir;
const { think, reminders } = await import('./dist/brain.js');
const { config } = await import('./dist/config.js');
const { workTools } = await import('./dist/work-tools.js');
const { desktopAccess } = await import('./dist/desktop-service.js');
const { HistoryStore } = await import('./dist/history.js');
const { sandboxes } = await import('./dist/sandbox.js');
const { stopLearning } = await import('./dist/learning-runtime.js');
const { collection, namespace, closeMongo } = await import('./dist/mongo.js');
const history = new HistoryStore(dir, 30);
try {
  for (const owner of ['6612253937', '7853500388']) {
    const incoming = { transport: 'telegram', chatId: owner, senderId: owner, sender: 'owner', id: '91001', text: 'Give me a private link to see and control my sandbox browser desktop. Use watch_desktop now, then send the generated link in this private chat. Do not run shell commands or start a background worker.', isGroup: false, addressed: true, timestamp: Date.now(), credentialEligible: true, learningEligible: false };
    await history.add('telegram:' + owner, { role: 'user', text: incoming.text, senderId: owner, id: incoming.id, at: incoming.timestamp });
    const sent = [];
    await think([], incoming, undefined, undefined, { history, delivery: { current: () => true, send: async text => { sent.push(text); await history.add('telegram:' + owner, { role: 'assistant', text, senderId: owner, at: Date.now() }); }, react: async () => {} } });
    const candidate = sent.flatMap(text => text.match(/https:\/\/[^\s<>"'`]+\/[a-f0-9]{64}/g) ?? []);
    assert.equal(candidate.length, 1, 'actual model must issue and deliver exactly one fresh desktop link');
    const url = new URL(candidate[0]);
    assert.equal(url.origin, new URL(config.desktopPublicBaseUrl).origin);
    const key = url.pathname.slice(1);
    const rows = await (await collection('history')).find({ ns: namespace(dir) }).toArray();
    assert.ok(!JSON.stringify(rows).includes(key), 'link key must not persist in history');
    assert.match(JSON.stringify(rows), /desktop access redacted/);
    await assert.rejects(() => workTools({ ...incoming, isGroup: true }).watch_desktop.execute({}, {}), /owner DM/);
    desktopAccess.revokeOwner(owner);
    console.log('PASS actual model owner desktop tool delivery, private-only and persisted key redaction', owner);
  }
} finally {
  desktopAccess?.close(); stopLearning(); await reminders.close(); sandboxes.stop(); await closeMongo(); rmSync(dir, { recursive: true, force: true });
}
