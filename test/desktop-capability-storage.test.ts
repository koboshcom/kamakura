import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactCredentials, redactStoredCredentials, preventCredentialStorage, registerDesktopCapability } from '../src/credentials.js';
import { DurableBuffer } from '../src/storage-buffer.js';
import { unsafeLesson } from '../src/learning.js';

const key = 'ab'.repeat(32);
const url = `https://vnc.example.test/${key}`;

test('desktop capabilities remain deliverable but are redacted for storage', () => {
  assert.equal(redactCredentials(url), url);
  assert.equal(redactStoredCredentials('cd'.repeat(32)), 'cd'.repeat(32), 'unrelated storage identifiers are not capabilities');
  registerDesktopCapability(key, Date.now() + 3600000);
  for (const text of [url, `${url}/websockify`, `key ${key}`, JSON.stringify({ url })]) {
    assert.ok(!redactStoredCredentials(text).includes(key));
    assert.throws(() => preventCredentialStorage(text));
    assert.ok(unsafeLesson(text));
  }
  assert.equal(redactStoredCredentials('see https://example.test/docs'), 'see https://example.test/docs');
});

test('pending history journal does not retain path capabilities even in nested values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamakura-capability-'));
  try {
    const buffer = new DurableBuffer<{ _id: string; nested: { url: string }; text: string }>(dir);
    buffer.append({ _id: 'fixture', nested: { url }, text: `open ${url}` });
    assert.ok(!JSON.stringify(buffer.pending()).includes(key));
    assert.ok(!readFileSync(join(dir, 'history-pending.json'), 'utf8').includes(key));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
