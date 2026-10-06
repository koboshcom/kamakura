import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTailscaleKeys } from '../src/sandbox-credentials.js';

test('Tailscale keys are optional and map exact users without shared fallback', () => {
  assert.equal(loadTailscaleKeys().size, 0);
  const dir = mkdtempSync(join(tmpdir(), 'tailkeys-'));
  const path = join(dir, 'keys.json');
  try {
    writeFileSync(path, JSON.stringify({ '42': 'tskey-auth-abcdefghij', '43': 'tskey-auth-klmnopqrst' }));
    const keys = loadTailscaleKeys(path);
    assert.equal(keys.get('42'), 'tskey-auth-abcdefghij');
    assert.equal(keys.get('7'), undefined);
    for (const data of [{ '*': 'tskey-auth-abcdefghij' }, { '042': 'tskey-auth-abcdefghij' }, { '42': 'short' }, { '42': 'tskey-auth-abcdefghij\n' }, [], null]) {
      writeFileSync(path, JSON.stringify(data));
      assert.throws(() => loadTailscaleKeys(path), /Invalid per-user/);
    }
    writeFileSync(path, 'not json');
    assert.throws(() => loadTailscaleKeys(path), /Invalid per-user/);
    writeFileSync(path, ' '.repeat(65537));
    assert.throws(() => loadTailscaleKeys(path), /Invalid per-user/);
  } finally { rmSync(dir, { recursive: true }); }
});
