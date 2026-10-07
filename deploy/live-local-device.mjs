// Isolated real-core / real-CLI TLS fixture. Never reads production dotenv or pairs a host.
// Run after npm run build: node deploy/live-local-device.mjs [path-to-kama-linux-amd64]
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'kama-real-core-'));
const binary = resolve(process.argv[2] ?? '/home/kit/kama-cli-build/kama-linux-amd64');
const owner = '6612253937', other = 'fixture-other-owner';
const command = "printf 'isolated-kama-roundtrip'";
const configHome = join(dir, 'config');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { LocalDevices } = await import('../dist/local-devices.js');
class MemoryStore {
  pairs = new Map(); devices = new Map(); audits = [];
  async putPair(r) { this.pairs.set(r.codeHash, { ...r }); }
  async consumePair(h, now) { const r = this.pairs.get(h); if (!r || r.expiresAt <= now) return null; this.pairs.delete(h); return r; }
  async putDevice(r) { this.devices.set(r.deviceId, { ...r }); }
  async byToken(h) { return [...this.devices.values()].find(r => r.tokenHash === h && !r.revoked) ?? null; }
  async get(o, id) { const r = this.devices.get(id); return r?.ownerId === o && !r.revoked ? r : null; }
  async list(o) { return [...this.devices.values()].filter(r => r.ownerId === o && !r.revoked); }
  async revoke(o, id) { const r = await this.get(o, id); if (!r) return false; r.revoked = true; return true; }
  async audit(r) { this.audits.push(r); }
}
const store = new MemoryStore();
const core = new LocalDevices({ dataDir: dir, store, authorized: o => [owner, other].includes(o), requestTtlMs: 5000 });
let tls, env, started = false, approvalCount = 0;
const cli = (args, input = '') => new Promise((resolveCommand, reject) => {
  const child = spawn(binary, args, { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; });
  // Deliberately do not log stderr, stdin, config, or any credentials on failure.
  child.stderr.resume(); child.stdin.end(input);
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolveCommand(output) : reject(new Error(`CLI ${args[0]} failed (${code})`)));
});
async function until(check, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  // Ephemeral private test CA, trusted only by this connector's environment.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt'), '-days', '1', '-subj', '/CN=kama-fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  const transport = core.createServer();
  tls = createServer({ key: await readFile(join(dir, 'tls.key')), cert: await readFile(join(dir, 'tls.crt')) }, (req, res) => transport.emit('request', req, res));
  tls.on('upgrade', (req, socket, head) => transport.emit('upgrade', req, socket, head));
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
  env = { ...process.env, XDG_CONFIG_HOME: configHome, KAMA_CORE_URL: `https://127.0.0.1:${tls.address().port}`, SSL_CERT_FILE: join(dir, 'tls.crt') };
  const { code } = await core.issuePairCode(owner);
  await cli(['auth'], `${code}\n`);
  await assert.rejects(core.pair(code, 'replay', 'linux'), /expired or consumed/);
  const config = JSON.parse(await readFile(join(configHome, 'kama/config.json'), 'utf8'));
  assert.equal(config.ownerId, owner);
  assert.equal((await stat(join(configHome, 'kama/config.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(configHome, 'kama'))).mode & 0o777, 0o700);
  assert(!JSON.stringify([...store.devices.values()]).includes(config.token));
  assert.equal((await core.list(other)).length, 0);
  await cli(['start']); started = true;
  await until(async () => (await core.list(owner))[0]?.connected, 'paused connection');
  assert.equal((await core.list(owner))[0].paused, true);
  await until(async () => /connected=true, paused=true/.test(await cli(['status'])), 'CLI connected status');
  await assert.rejects(core.execute(owner, config.deviceId, 'shell', { command }), /paused/);
  assert.equal(approvalCount, 0);
  core.setApprovalNotifier(async (o, n) => {
    assert.equal(o, owner); assert.equal(n.deviceId, config.deviceId); assert.equal(n.action, 'shell');
    assert.deepEqual(JSON.parse(n.preview), { command });
    assert.equal(await core.approve(other, n.approvalId, true), false);
    approvalCount++;
    assert.equal(await core.approve(owner, n.approvalId, true), true);
    assert.equal(await core.approve(owner, n.approvalId, true), false);
  });
  await cli(['resume']);
  await until(async () => !(await core.list(owner))[0]?.paused, 'resume');
  await assert.rejects(core.execute(other, config.deviceId, 'shell', { command }), /unavailable/);
  const result = await core.execute(owner, config.deviceId, 'shell', { command });
  assert.equal(result.output, 'isolated-kama-roundtrip'); assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, false); assert.equal(approvalCount, 1);
  assert(!JSON.stringify(store.audits).includes(command));
  await cli(['pause']);
  await until(async () => (await core.list(owner))[0]?.paused, 'pause');
  await assert.rejects(core.execute(owner, config.deviceId, 'shell', { command }), /paused/);
  assert.equal(await core.revoke(other, config.deviceId), false);
  await cli(['resume']);
  await until(async () => !(await core.list(owner))[0]?.paused, 'second resume');
  assert.equal(await core.revoke(owner, config.deviceId), true);
  await until(async () => (await cli(['status'])).includes('connected=false'), 'revoked disconnect');
  assert.equal((await core.list(owner)).length, 0);
  await assert.rejects(core.execute(owner, config.deviceId, 'shell', { command }), /unavailable/);
  await cli(['stop']); started = false;
  assert.match(await cli(['status']), /Stopped/);
  console.log('PASS real LocalDevices + real kama CLI TLS pairing, paused start, exact single-use owner approval, harmless shell, pause, owner isolation, revoke disconnect and stop; isolated credentials cleaned.');
} finally {
  if (started) await cli(['stop']).catch(() => undefined);
  await core.close();
  if (tls) { tls.closeAllConnections(); await new Promise(r => tls.close(r)); }
  await rm(dir, { recursive: true, force: true });
}
