import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxOptions, SandboxManager, assertUsernsRuntime } from '../src/sandbox.js';
import { config } from '../src/config.js';

const settings = { ...config.sandbox, allowed: new Set(['42']), usernsRoot: true, rootView: undefined };
test('sudo root mode remains remapped limited and only work is bound', () => {
  assert.throws(() => assertUsernsRuntime({}, true), /refusing unisolated root/);
  assert.throws(() => assertUsernsRuntime({SecurityOptions: ['name=seccomp']}, true), /userns-remap/);
  assert.doesNotThrow(() => assertUsernsRuntime({SecurityOptions: ['name=userns']}, true));
  const options = sandboxOptions('42', settings, '/srv/work/42');
  assert.equal(options.User, '1000:1000'); assert.equal(options.WorkingDir, '/work');
  assert.equal(options.HostConfig!.ReadonlyRootfs, false);
  assert.deepEqual(options.HostConfig!.CapDrop, ['ALL']);
  assert(options.HostConfig!.CapAdd!.includes('SETUID'));
  assert(!options.HostConfig!.CapAdd!.includes('SYS_ADMIN'));
  assert.deepEqual(options.HostConfig!.SecurityOpt, []);
  assert.equal(options.HostConfig!.Mounts!.length, 1);
  assert.equal(options.HostConfig!.Mounts![0]!.Target, '/work');
  assert.equal(options.HostConfig!.Privileged, false);
  assert.deepEqual(options.HostConfig!.Devices, []);
});
test('unremapped sandbox daemon fails before container creation', async () => {
  let created = false;
  const docker = {info: async () => ({SecurityOptions: ['name=seccomp']}), createContainer: async () => {created = true;}};
  const manager = new SandboxManager(settings, docker as never);
  await assert.rejects((manager as unknown as {container(id: string): Promise<unknown>}).container('42'), /refusing unisolated root/);
  assert.equal(created, false);
});
