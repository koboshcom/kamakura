import { config } from './config.js';
import { LocalDevices } from './local-devices.js';

export const localDevices = config.localDevices.enabled ? new LocalDevices({
  dataDir: config.dataDir,
  authorized: owner => config.telegramAllowed.has(owner) && config.sandbox.allowed.has(owner),
}) : undefined;
const server = localDevices?.createServer();
export async function startLocalDevices(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.localDevices.port, config.localDevices.host, resolve);
  });
}
export async function stopLocalDevices(): Promise<void> { await localDevices?.close(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
