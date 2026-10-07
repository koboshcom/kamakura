import test from 'node:test';
import assert from 'node:assert/strict';
import { rootPolicy, assertRootStorage, sandboxOptions, assertSandboxNetwork, sandboxNetwork } from '../src/sandbox.js';
import { config } from '../src/config.js';
test('remapped root is writable by default and strictly bounded on classic XFS', () => {
  assert.equal(rootPolicy(true).writable, true);
  const opts = sandboxOptions('42', { ...config.sandbox, usernsRoot: true }, '/work42');
  assert.equal(opts.HostConfig!.ReadonlyRootfs, false);
  assert.deepEqual(opts.HostConfig!.StorageOpt, { size: '8G' });
  assert.ok(opts.HostConfig!.CapAdd!.includes('SETUID'));
  assert.deepEqual(opts.HostConfig!.SecurityOpt, []);
  assert.throws(() => assertRootStorage({ Driver: 'overlay2', DriverStatus: [['Backing Filesystem', 'extfs']] }, true), /XFS/);
  assert.throws(() => assertRootStorage({ Driver: 'overlayfs', DriverStatus: [['Backing Filesystem', 'xfs']] }, true), /XFS/);
  assert.doesNotThrow(() => assertRootStorage({ Driver: 'overlay2', DriverStatus: [['Backing Filesystem', 'xfs']] }, true));
});
test('readonly is explicit optional mode for remapped root', () => {
  const old = process.env.SANDBOX_ROOTFS_MODE;
  process.env.SANDBOX_ROOTFS_MODE = 'readonly';
  try {
    const opts = sandboxOptions('42', { ...config.sandbox, usernsRoot: true }, '/work42');
    assert.equal(opts.HostConfig!.ReadonlyRootfs, true);
    assert.equal(opts.HostConfig!.StorageOpt, undefined);
    assert.deepEqual(opts.HostConfig!.SecurityOpt, ['no-new-privileges:true']);
  } finally { if (old === undefined) delete process.env.SANDBOX_ROOTFS_MODE; else process.env.SANDBOX_ROOTFS_MODE = old; }
});
test('dedicated network policy rejects default bridge, IPv6 and missing labels', () => {
  const {name, bridge} = sandboxNetwork('test');
  const info = { Name: name, Driver: 'bridge', EnableIPv6: false, Internal: false, Options: {'com.docker.network.bridge.name': bridge, 'com.docker.network.bridge.enable_icc': 'false'}, Labels: {'kamakura.network-policy': 'public-only-v1', 'kamakura.sandbox': 'test'}, IPAM: {Config: [{Subnet: '172.30.0.0/24', Gateway: '172.30.0.1'}]} };
  assert.doesNotThrow(() => assertSandboxNetwork(info as never, 'test'));
  assert.throws(() => assertSandboxNetwork({...info, Name: 'bridge'} as never, 'test'));
  assert.throws(() => assertSandboxNetwork({...info, EnableIPv6: true} as never, 'test'));
  assert.throws(() => assertSandboxNetwork({...info, Labels: {}} as never, 'test'));
});
