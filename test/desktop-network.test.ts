import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxManager, sandboxNetwork } from '../src/sandbox.js';
import { config } from '../src/config.js';

test('desktop chooses only attested dedicated network, never default bridge', async () => {
  const instance = 'desktop-test';
  const name = sandboxNetwork(instance).name;
  const manager = new SandboxManager({ ...config.sandbox, instance, allowed: new Set(['42']) }, {getContainer: () => ({inspect: async () => ({NetworkSettings: {Networks: networks}})})} as never);
  const networks: Record<string, {IPAddress:string}> = { [name]: { IPAddress: '172.30.0.2' }, bridge: { IPAddress: '172.29.0.2' } };
  const info = { Id: 'box', HostConfig:{NetworkMode:'container:guard'}, Config: { Env: ['KAMAKURA_DESKTOP_PASSWORD=' + 'a'.repeat(64)] } };
  (manager as unknown as { container: () => Promise<unknown> }).container = async () => ({ inspect: async () => info });
  assert.equal((await manager.desktopTarget('42')).url, 'http://172.30.0.2:6080');
  delete networks[name];
  await assert.rejects(manager.desktopTarget('42'), /network or authentication unavailable/);
  manager.stop();
});
