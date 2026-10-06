import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxManager } from '../src/sandbox.js';
import { config } from '../src/config.js';
import type Docker from 'dockerode';

const settings = { ...config.sandbox, allowed: new Set(['42']), instance: 'test', volumeMode: 'loopback', allowSoftQuota: false };
const missing = () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
function mock(volume?: object) {
  const calls: Docker.ContainerCreateOptions[] = [];
  let volumeCreates = 0;
  const docker = {
    getContainer: () => ({ inspect: async () => missing() }),
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({}) }),
    getVolume: () => ({ inspect: async () => volume ?? missing() }),
    createVolume: async () => { volumeCreates++; },
    createContainer: async (options: Docker.ContainerCreateOptions) => { calls.push(options); return { start: async () => undefined }; },
  } as unknown as Docker;
  const manager = new SandboxManager(settings, docker);
  // Test creation in isolation from exec streaming.
  const create = () => (manager as unknown as { container(id: string): Promise<unknown> }).container('42');
  return { create, calls, volumeCreates: () => volumeCreates };
}
const validVolume = {
  Driver: 'local',
  Labels: { 'kamakura.owner': '42', 'kamakura.sandbox': 'test', 'kamakura.disk': String(settings.disk), 'kamakura.quota': 'loopback-ext4' },
  Options: { type: 'ext4', device: '/dev/loop7', o: 'rw,nosuid,nodev' },
};
test('missing hard-cap volume fails closed without an unbounded fallback', async () => {
  const m = mock();
  await assert.rejects(m.create(), /No unbounded fallback/);
  assert.equal(m.volumeCreates(), 0);
  assert.equal(m.calls.length, 0);
});
test('provisioned loopback named volume is attached to the user container', async () => {
  const m = mock(validVolume);
  await m.create();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]!.HostConfig!.Mounts![0]!.Source, 'kamakura-test-data-u42');
  assert.equal(m.volumeCreates(), 0);
});
test('ordinary local volume is rejected even with correct ownership', async () => {
  const m = mock({ ...validVolume, Options: {} });
  await assert.rejects(m.create(), /host-provisioned ext4/);
  assert.equal(m.calls.length, 0);
});
test('wrong disk cap is rejected without resizing or deleting data', async () => {
  const m = mock({ ...validVolume, Labels: { ...validVolume.Labels, 'kamakura.disk': '1' } });
  await assert.rejects(m.create(), /disk limit differs/);
  assert.equal(m.volumeCreates(), 0);
});
