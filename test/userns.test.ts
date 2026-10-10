import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxOptions } from '../src/sandbox.js';
import { config } from '../src/config.js';

test('owner full sudo is writable on the ordinary daemon, without networking or host privileges', () => {
  const options = sandboxOptions('42', config.sandbox, '/srv/work/42', 'a'.repeat(64));
  assert.equal(options.User, '1000:1000'); assert.equal(options.WorkingDir, '/work');
  assert.equal(options.HostConfig!.ReadonlyRootfs, false);
  assert.deepEqual(options.HostConfig!.CapDrop, ['ALL']);
  assert(options.HostConfig!.CapAdd!.includes('SETUID'));
  for (const cap of ['SYS_ADMIN', 'NET_ADMIN', 'NET_RAW', 'SYS_PTRACE', 'SYS_MODULE']) assert(!options.HostConfig!.CapAdd!.includes(cap));
  assert.deepEqual(options.HostConfig!.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(options.HostConfig!.Mounts!.length, 1);
  assert.equal(options.HostConfig!.Mounts![0]!.Target, '/work');
  assert.equal(options.HostConfig!.Privileged, false);
  assert.deepEqual(options.HostConfig!.Devices, []);
  assert.equal(options.HostConfig!.PidMode, undefined);
  assert.equal(options.HostConfig!.UsernsMode, undefined);
  assert.equal(options.HostConfig!.NetworkMode, 'container:' + 'a'.repeat(64));
  assert.equal(options.HostConfig!.Sysctls, undefined);
});
