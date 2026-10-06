import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostComputers, hostInputSchema } from '../src/host-computer.js';
const secret = 'a'.repeat(40);
function setup(entries: unknown = [{ telegramUserId: '123', endpoint: 'http://100.64.1.2:8765', secret }]) {
  const dir = mkdtempSync(join(tmpdir(), 'host-test-'));
  const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(entries));
  return { path, clean: () => rmSync(dir, { recursive: true }) };
}
test('opt-in and strict endpoint validation', () => {
  assert.equal(new HostComputers('').available('123'), false);
  for (const endpoint of ['http://localhost:8765', 'http://100.63.1.2:8765', 'http://100.128.1.2:8765', 'http://100.64.1.2:80', 'https://100.64.1.2:8765', 'http://100.64.1.2:8765/path', 'http://1681916162:8765', 'http://100.64.1.2:8765/']) {
    const s = setup([{ telegramUserId: '123', endpoint, secret }]);
    try { assert.throws(() => new HostComputers(s.path), /Invalid/); } finally { s.clean(); }
  }
  for (const entries of [[{ telegramUserId: '*', endpoint: 'http://100.64.1.2:8765', secret }], [{ telegramUserId: '123', endpoint: 'http://100.64.1.2:8765', secret: 'short' }]]) {
    const s = setup(entries); try { assert.throws(() => new HostComputers(s.path)); } finally { s.clean(); }
  }
});
test('schema rejects arbitrary exec, extra bypass flags and unbounded inputs', () => {
  for (const input of [{ action: 'exec', code: 'ls' }, { action: 'click', x: -1, y: 0 }, { action: 'screenshot', confirmed: true }, { action: 'type', text: 'x'.repeat(2001) }, { action: 'type', text: '\n' }, { action: 'press', keys: ['invalid'] }]) assert.equal(hostInputSchema.safeParse(input).success, false);
});
test('immediate screenshots, exact user scoped single-use confirmations and expiry', async () => {
  const s = setup(); let clock = 1000; const calls: RequestInit[] = [];
  const fetcher = (async (_url, init) => { calls.push(init!); return Response.json({ text: secret, images: [] }); }) as typeof fetch;
  const hosts = new HostComputers(s.path, fetcher, () => clock);
  try {
    assert.equal(hosts.available('123'), true); assert.equal(hosts.available('0123'), false);
    assert.equal((await hosts.request('123', { action: 'screenshot' })).text.includes(secret), false);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.redirect, 'error');
    assert.equal((calls[0]!.headers as Record<string,string>)['X-Telegram-User-Id'], '123');
    assert.equal((calls[0]!.headers as Record<string,string>).Authorization, `Bearer ${secret}`);
    const queued = await hosts.request('123', { action: 'type', text: secret });
    assert.equal(queued.text.includes(secret), false);
    const token = queued.text.match(/confirm [a-f0-9]{32}/)![0];
    assert.equal(calls.length, 1);
    assert.equal(await hosts.confirm('123', token + '\n'), undefined);
    assert.equal(await hosts.confirm('123', `please ${token}`), undefined);
    assert.match((await hosts.confirm('456', token))!.text, /No matching/);
    await hosts.confirm('123', token); assert.equal(calls.length, 2);
    await hosts.confirm('123', token); assert.equal(calls.length, 2);
    const next = await hosts.request('123', { action: 'move', x: 3, y: 4 });
    clock += 60000;
    assert.match((await hosts.confirm('123', next.text.match(/confirm [a-f0-9]{32}/)![0]))!.text, /expired/);
    assert.equal(calls.length, 2);
    const older = await hosts.request('123', { action: 'press', keys: ['enter'] });
    await hosts.request('123', { action: 'press', keys: ['tab'] });
    assert.match((await hosts.confirm('123', older.text.match(/confirm [a-f0-9]{32}/)![0]))!.text, /No matching/);
    assert.equal(calls.length, 2);
  } finally { s.clean(); }
});
test('HTTP errors and oversized/non-PNG responses fail closed without remote text', async () => {
  const s = setup();
  try {
    for (const response of [new Response('redirect', { status: 302 }), Response.json({ text: secret, images: ['notpng'] }), new Response('x'.repeat(6 * 1024 * 1024 + 1))]) {
      const hosts = new HostComputers(s.path, (async () => response) as typeof fetch);
      const result = await hosts.request('123', { action: 'screenshot' });
      assert.match(result.text, /failed/); assert.equal(result.text.includes(secret), false); assert.deepEqual(result.images, []);
    }
  } finally { s.clean(); }
});
