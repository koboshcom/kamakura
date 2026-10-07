import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxOptions, SandboxManager, assertUsernsRuntime } from '../src/sandbox.js';
import { sizeBytes } from '../src/config.js';
const s = { allowed: new Set(['42']), image: 'img', socketPath: '/x', coreSocketPath: '/core', usernsRoot: false, instance: 't', cpus: 2, memory: sizeBytes('3g'), disk: sizeBytes('35G'), pids: 128, network: false, tailscale: false, idleMs: 60000, commandMs: 1000, maxOutput: 1024, maxContainers: 2, root: '/opt/kamakura/sandboxes', rootView: undefined, allowSoftQuota: false };
test('sandbox has only its workspace host bind and is locked down', () => {
  const o = sandboxOptions('42', s, 'vol');
  assert.equal(o.HostConfig!.Binds, undefined);
  assert.deepEqual(o.HostConfig!.Mounts!.map(m => m.Type), ['bind']);
  assert.equal(o.HostConfig!.NetworkMode, 'none');
  assert.equal(o.HostConfig!.Privileged, false);
  assert.deepEqual(o.HostConfig!.CapDrop, ['ALL']);
  assert.equal(o.HostConfig!.NanoCpus, 2e9);
  assert.equal(o.HostConfig!.PidsLimit, 128);
  assert.equal(o.HostConfig!.Memory, sizeBytes('3GiB'));
  assert.equal(o.HostConfig!.MemorySwap, o.HostConfig!.Memory);
  assert.equal(o.HostConfig!.Runtime, 'runc');
  assert.equal(o.HostConfig!.LogConfig!.Config!.compress, 'false');
  assert.deepEqual(o.HostConfig!.Devices, []);
  assert.deepEqual(o.HostConfig!.DeviceRequests, []);
  assert.deepEqual(o.HostConfig!.Mounts, [{ Type: 'bind', Source: 'vol', Target: '/work', ReadOnly: false, BindOptions: { Propagation: 'rprivate' } }]);
});
test('allowlist is exact numeric ids, no wildcard', async () => {
  const m = new SandboxManager({ ...s, allowed: new Set(['42', '*']) }, {} as never);
  assert.ok(m.authorized('42'));
  assert.ok(!m.authorized('*'));
  assert.ok(!m.authorized('7'));
  await assert.rejects(m.run('7', 'ls'), /not authorized/);
});

// These fixtures exercise non-remapped readonly sandboxes, independent of live .env.
let previousRootMode: string | undefined;
beforeEach(() => { previousRootMode = process.env.SANDBOX_ROOTFS_MODE; process.env.SANDBOX_ROOTFS_MODE = 'readonly'; });
afterEach(() => { if (previousRootMode === undefined) delete process.env.SANDBOX_ROOTFS_MODE; else process.env.SANDBOX_ROOTFS_MODE = previousRootMode; });
