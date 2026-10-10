import test from 'node:test';
import assert from 'node:assert/strict';
import { rootPolicy, assertRootStorage, sandboxOptions } from '../src/sandbox.js';
import { assertPortableNetwork, networkName, guardOptions, deniedAddresses } from '../src/egress.js';
import { config } from '../src/config.js';
test('ordinary Docker Desktop root is writable without an unsupported quota claim', () => {
  const old = process.env.SANDBOX_ROOTFS_SIZE;
  delete process.env.SANDBOX_ROOTFS_SIZE;
  try {
    assert.equal(rootPolicy().writable, true);
    const opts = sandboxOptions('42', config.sandbox, '/work42', 'a'.repeat(64));
    assert.equal(opts.HostConfig!.ReadonlyRootfs, false);
    assert.equal(opts.HostConfig!.StorageOpt, undefined);
    assert.doesNotThrow(() => assertRootStorage({Driver:'overlayfs'}, false));
    assert.throws(() => sandboxOptions('42', config.sandbox, '/work42', 'bridge'), /verified egress/);
  } finally { if (old !== undefined) process.env.SANDBOX_ROOTFS_SIZE = old; }
});
test('optional root quota retains XFS fail-closed enforcement', () => {
  const old = process.env.SANDBOX_ROOTFS_SIZE;
  process.env.SANDBOX_ROOTFS_SIZE = '8G';
  try {
    assert.deepEqual(sandboxOptions('42', config.sandbox, '/work42', 'a'.repeat(64)).HostConfig!.StorageOpt, {size:'8G'});
    assert.throws(() => assertRootStorage({Driver:'overlayfs'}, true), /XFS/);
    assert.doesNotThrow(() => assertRootStorage({Driver:'overlay2',DriverStatus:[['Backing Filesystem','xfs']]}, true));
  } finally { if (old === undefined) delete process.env.SANDBOX_ROOTFS_SIZE; else process.env.SANDBOX_ROOTFS_SIZE = old; }
});
test('portable network rejects legacy bridge attestations; a bridge alone never authorizes an owner', () => {
  const info = {Name:networkName('test'),Driver:'bridge',Internal:false,Labels:{'kamakura.network-policy':'guard-v2','kamakura.sandbox':'test'}};
  assert.doesNotThrow(() => assertPortableNetwork(info as never,'test'));
  for (const patch of [{Name:'bridge'},{Internal:true},{Labels:{}},{Labels:{...info.Labels,'kamakura.network-policy':'public-only-v1'}},{Options:{'com.docker.network.bridge.enable_icc':'false'}}]) {
    assert.throws(() => assertPortableNetwork({...info,...patch} as never,'test'));
  }
});
test('guard is external to owner authority, has no host mounts, APIs or autorestart', () => {
  const options = guardOptions('guard','image','test','42',['172.30.0.1'],[]);
  assert.deepEqual(options.HostConfig!.CapAdd,['NET_ADMIN']);
  assert.equal(options.HostConfig!.Privileged,false);
  assert.equal(options.HostConfig!.ReadonlyRootfs,true);
  assert.deepEqual(options.HostConfig!.Mounts,[]);
  assert.deepEqual(options.HostConfig!.SecurityOpt,['no-new-privileges:true']);
  assert.deepEqual(options.HostConfig!.RestartPolicy,{Name:'no'});
  assert.equal(options.HostConfig!.PidMode,undefined);
  assert.equal(options.HostConfig!.PortBindings,undefined);
  assert.throws(() => guardOptions('g','i','test','42',['x; flush ruleset'],[]), /Invalid egress/);
});
test('public host deny addresses are numeric, not untrusted nft expressions', () => {
  const old = process.env.SANDBOX_DENIED_IPS;
  try {
    process.env.SANDBOX_DENIED_IPS='1.2.3.4,2001:4860::1,1.2.3.4';
    assert.deepEqual(deniedAddresses(),['1.2.3.4','2001:4860::1']);
    process.env.SANDBOX_DENIED_IPS='1.2.3.4;accept';
    assert.throws(deniedAddresses,/numeric/);
  } finally { if (old === undefined) delete process.env.SANDBOX_DENIED_IPS; else process.env.SANDBOX_DENIED_IPS=old; }
});
