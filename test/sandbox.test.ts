import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxOptions, SandboxManager } from '../src/sandbox.js';
import { sizeBytes } from '../src/config.js';
const s = { allowed: new Set(['42']), image: 'img', socketPath: '/x', instance: 't', cpus: 2, memory: sizeBytes('3g'), disk: sizeBytes('35G'), pids: 128, network: false, idleMs: 60000, commandMs: 1000, maxOutput: 1024, maxContainers: 2, volumeDriver: 'local', volumeOptions: {}, allowSoftQuota: false };
test('sandbox has no host mounts and is locked down', () => {
  const o = sandboxOptions('42', s, 'vol');
  assert.equal(o.HostConfig!.Binds, undefined);
  assert.deepEqual(o.HostConfig!.Mounts!.map(m => m.Type), ['volume']);
  assert.equal(o.HostConfig!.NetworkMode, 'none');
  assert.equal(o.HostConfig!.Privileged, false);
  assert.deepEqual(o.HostConfig!.CapDrop, ['ALL']);
  assert.equal(o.HostConfig!.NanoCpus, 2e9);
  assert.equal(o.HostConfig!.PidsLimit, 128);
});
test('allowlist is exact numeric ids, no wildcard', async () => {
  const m = new SandboxManager({ ...s, allowed: new Set(['42', '*']) }, {} as never);
  assert.ok(m.authorized('42'));
  assert.ok(!m.authorized('*'));
  assert.ok(!m.authorized('7'));
  await assert.rejects(m.run('7', 'ls'), /not authorized/);
});
