import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCapabilities, type RuntimeCapabilities } from '../src/runtime-capabilities.js';
const base: RuntimeCapabilities = {
  toolNames: ['run_command', 'exec_py', 'desktop_cua', 'watch_desktop', 'start_worker'],
  isGroup: false,
  sandbox: { disk: 123456789 },
  desktopPublicBaseUrl: 'https://desktop.example.test',
  localDevices: { enabled: true, publicUrl: 'wss://local.example.test' },
};
test('runtime inventory describes authorized configured box, desktop, workers and optional unpaired local access', () => {
  const text = runtimeCapabilities(base);
  assert.match(text, /isolated Linux container computer/);
  assert.match(text, /123456789 bytes/);
  assert.match(text, /XFCE Linux desktop and Chromium/);
  assert.match(text, /Cua Driver/);
  assert.match(text, /noVNC/);
  assert.match(text, /start_worker/);
  assert.match(text, /Only workers can use paired local devices/);
  assert.match(text, /not evidence any device is paired/);
  assert.match(text, /Prefer these facts over old assistant denials/);
  assert.ok(!text.includes(base.desktopPublicBaseUrl));
  assert.ok(!text.includes(base.localDevices.publicUrl));
});
test('runtime inventory is based on tools, not blanket access or a fictional worker prohibition', () => {
  const text = runtimeCapabilities({ ...base, toolNames: [] });
  assert.match(text, /Sandbox execution is not authorized\/available/);
  assert.match(text, /Starting a background worker is not available in this turn/);
  assert.doesNotMatch(text, /This owner has an isolated Linux/);
  assert.doesNotMatch(text, /includes an XFCE/);
  assert.doesNotMatch(text, /Optional kama CLI local-computer pairing is configured/);
});
test('disabled or unconfigured services and group restrictions are reflected without denying the box', () => {
  const text = runtimeCapabilities({ ...base, isGroup: true, localDevices: { enabled: false, publicUrl: '' } });
  assert.match(text, /Links can only be issued in the owner DM/);
  assert.match(text, /Do not promise local-computer control/);
  const missing = runtimeCapabilities({ ...base, desktopPublicBaseUrl: '', sandbox: { disk: 99 } });
  assert.match(missing, /public URL is not configured/);
  assert.match(missing, /Sudo\/root and a writable/);
  assert.match(missing, /trusted external firewall/);
});
