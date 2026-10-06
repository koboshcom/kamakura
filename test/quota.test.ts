import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { SandboxManager } from '../src/sandbox.js';
import { config } from '../src/config.js';
import { hardQuotaMount, checkWorkspace } from '../src/workspace.js';
import type Docker from 'dockerode';

const settings = { ...config.sandbox, usernsRoot: false, allowed: new Set(['42']), instance: 'test', root: '/opt/kamakura/sandboxes', rootView: undefined, allowSoftQuota: false };
function mock(hard: boolean, missing = false) {
  const calls: Docker.ContainerCreateOptions[] = [];
  const docker = {
    getContainer: () => ({ inspect: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } }),
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (options: Docker.ContainerCreateOptions) => { calls.push(options); return { start: async () => undefined }; },
  } as unknown as Docker;
  const checker: typeof checkWorkspace = async (root, id, _disk, soft) => {
    if (missing || (!hard && !soft)) throw new Error('Workspace not provisioned, no unbounded fallback');
    return { path: join(root, id), hard };
  };
  return { calls, docker, checker };
}
test('missing or unmounted workspace fails closed without creating a directory', async () => {
  for (const missing of [true, false]) {
    const m = mock(false, missing);
    const manager = new SandboxManager(settings, m.docker, m.checker);
    await assert.rejects((manager as unknown as { container(id: string): Promise<unknown> }).container('42'), /no unbounded fallback/);
    assert.equal(m.calls.length, 0);
  }
});
test('quota filesystem attaches as exactly one user host bind', async () => {
  const m = mock(true);
  const manager = new SandboxManager(settings, m.docker, m.checker);
  await (manager as unknown as { container(id: string): Promise<unknown> }).container('42');
  assert.equal(m.calls[0]!.HostConfig!.Mounts![0]!.Source, '/opt/kamakura/sandboxes/42');
  assert.equal(m.calls[0]!.HostConfig!.Mounts![0]!.Type, 'bind');
});
test('unmounted directory requires explicit soft quota', async () => {
  const m = mock(false);
  const manager = new SandboxManager({ ...settings, allowSoftQuota: true }, m.docker, m.checker);
  await (manager as unknown as { container(id: string): Promise<unknown> }).container('42');
  assert.equal(m.calls[0]!.Labels!['kamakura.quota'], 'soft');
});
test('Compose discovers real host root from core mount rather than container cwd', async () => {
  const calls: Docker.ContainerCreateOptions[] = [];
  let checkedRoot = '';
  const docker = {
    getContainer: (id: string) => ({ inspect: async () => {
      if (id === hostname()) return { Mounts: [{ Type: 'bind', Source: '/srv/real/sandboxes', Destination: '/app/sandboxes' }] };
      throw Object.assign(new Error('missing'), { statusCode: 404 });
    } }),
    listContainers: async () => [], getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (options: Docker.ContainerCreateOptions) => { calls.push(options); return { start: async () => undefined }; },
  } as unknown as Docker;
  const checker: typeof checkWorkspace = async (root, user) => {
    checkedRoot = root;
    return { path: join(root, user), hard: true };
  };
  const manager = new SandboxManager({ ...settings, rootView: '/app/sandboxes' }, docker, checker);
  await (manager as unknown as { container(id: string): Promise<unknown> }).container('42');
  assert.equal(checkedRoot, '/app/sandboxes');
  assert.equal(calls[0]!.HostConfig!.Mounts![0]!.Source, '/srv/real/sandboxes/42');
});

test('exact loopback mountpoint and bounded capacity are required', () => {
  const path = '/opt/sandboxes/42';
  const line = '71 23 7:0 / /opt/sandboxes/42 rw - ext4 /dev/loop0 rw';
  assert.ok(hardQuotaMount(line, path, 100n, 120));
  assert.ok(!hardQuotaMount(line, path + '/child', 100n, 120));
  assert.ok(!hardQuotaMount(line, path, 121n, 120));
  assert.ok(!hardQuotaMount(line.replace('/dev/loop0', '/dev/sda1'), path, 100n, 120));
  assert.ok(!hardQuotaMount(line.replace('7:0 / ', '7:0 /subdir '), path, 100n, 120));
  assert.ok(!hardQuotaMount(line.replace('ext4', 'tmpfs'), path, 100n, 120));
  assert.ok(hardQuotaMount(line.replace('/opt/sandboxes/42', '/opt/my\\040boxes/42'), '/opt/my boxes/42', 100n, 120));
});
test('real workspace checks reject missing mounts and symlinks, soft mode never creates files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-'));
  try {
    await assert.rejects(checkWorkspace(root, '42', settings.disk, true), /missing/);
    await mkdir(join(root, '42'));
    await assert.rejects(checkWorkspace(root, '42', settings.disk, false), /mountpoint/);
    assert.equal((await checkWorkspace(root, '42', settings.disk, true)).hard, false);
    await symlink(join(root, '42'), join(root, '43'));
    await assert.rejects(checkWorkspace(root, '43', settings.disk, true), /real directory/);
    await assert.rejects(checkWorkspace(root, '../42', settings.disk, true), /owner/);
  } finally { await rm(root, { recursive: true }); }
});
