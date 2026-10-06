import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { DesktopAccess, validateDesktopTarget } from '../src/desktop-access.js';

const container = 'a'.repeat(64);
const base = 'https://desktop.example';
function make(extra: Partial<ConstructorParameters<typeof DesktopAccess>[0]> = {}) {
  return new DesktopAccess({ publicBaseUrl: base, isAuthorized: id => id === 'owner', resolveTarget: async () => '172.18.0.2', ...extra });
}
async function listen(gateway: DesktopAccess) {
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const address = gateway.server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}
async function get(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} }, res => {
      let body = ''; res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('HTTPS origin, private bridge target and limits fail closed', () => {
  for (const publicBaseUrl of ['http://desktop.example', 'https://u:p@desktop.example', 'https://desktop.example/path', 'https://desktop.example/?a=1']) assert.throws(() => make({ publicBaseUrl }));
  for (const ttlMs of [0, 900001, NaN]) assert.throws(() => make({ ttlMs }));
  for (const ip of ['127.0.0.1', '169.254.169.254', '8.8.8.8', 'localhost', '172.18.0.2:123', 'http://172.18.0.2', '::1', '10.0.0.1/path']) assert.throws(() => validateDesktopTarget(ip));
  for (const ip of ['172.18.0.2', '10.1.2.3', '192.168.1.2']) assert.equal(validateDesktopTarget(ip), ip);
});

test('issuance is authorized, bounded and bound to valid container ids', () => {
  const gateway = make({ maxTokens: 1 });
  try {
    assert.throws(() => gateway.issue('other', container));
    assert.throws(() => gateway.issue('owner', 'arbitrary-host'));
    const url = new URL(gateway.issue('owner', container));
    assert.match(url.searchParams.get('access')!, /^[a-f0-9]{64}$/);
    assert.throws(() => gateway.issue('owner', container));
    gateway.revokeOwner('owner');
    assert.doesNotThrow(() => gateway.issue('owner', container));
  } finally { gateway.close(); }
});

test('bootstrap strips token and sets secured scoped cookie; expiry and permission revocation deny access', async () => {
  let now = 1000; let allowed = true;
  const gateway = make({ now: () => now, ttlMs: 10000, isAuthorized: () => allowed });
  const port = await listen(gateway);
  try {
    const link = new URL(gateway.issue('owner', container));
    const bootstrap = await get(port, link.pathname + link.search);
    assert.equal(bootstrap.status, 303);
    assert(!bootstrap.headers.location!.includes('access='));
    assert(bootstrap.headers.location!.includes('path=desktop/'));
    const cookie = bootstrap.headers['set-cookie']![0]!;
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(bootstrap.headers['cache-control'], 'no-store');
    assert.equal(bootstrap.headers['referrer-policy'], 'no-referrer');
    assert.equal((await get(port, link.pathname)).status, 403);
    assert.equal((await get(port, link.pathname + '?access=' + 'b'.repeat(64))).status, 403);
    now = 11000;
    assert.equal((await get(port, link.pathname + link.search)).status, 403);
    const second = new URL(gateway.issue('owner', container));
    allowed = false;
    assert.equal((await get(port, second.pathname + second.search)).status, 403);
  } finally { gateway.close(); }
});

test('ambiguous paths, unknown grants and invalid upgrade origins fail before resolver', async () => {
  let calls = 0;
  const gateway = make({ resolveTarget: async () => { calls++; return '172.18.0.2'; } });
  const port = await listen(gateway);
  try {
    const link = new URL(gateway.issue('owner', container));
    const prefix = link.pathname.replace('vnc.html', '');
    for (const path of [prefix + '../vnc.html', prefix + '%2e%2e/vnc.html', prefix + '\\vnc.html', '//evil.example/', '/desktop/' + 'f'.repeat(32) + '/vnc.html']) assert.equal((await get(port, path)).status, 403);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${prefix}websockify HTTP/1.1\r\nHost: desktop.example\r\nOrigin: https://evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: desktop_access=${link.searchParams.get('access')}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
    });
    assert.match(response, /403 Forbidden/);
    assert.equal(calls, 0);
  } finally { gateway.close(); }
});

test('target resolver rechecks authorization after async inspection and rejects public addresses', async () => {
  let allowed = true;
  const gateway = make({ isAuthorized: () => allowed, resolveTarget: async () => { allowed = false; return '172.18.0.2'; } });
  const port = await listen(gateway);
  try {
    const link = new URL(gateway.issue('owner', container));
    assert.equal((await get(port, link.pathname, `desktop_access=${link.searchParams.get('access')}`)).status, 403);
  } finally { gateway.close(); }
  const other = make({ resolveTarget: async () => '169.254.169.254' });
  const otherPort = await listen(other);
  try {
    const link = new URL(other.issue('owner', container));
    assert.equal((await get(otherPort, link.pathname, `desktop_access=${link.searchParams.get('access')}`)).status, 403);
  } finally { other.close(); }
});

test('real HTTP and websocket tunnel strips credentials and revocation closes active sockets', async t => {
  const ip = Object.values(networkInterfaces()).flat().find(address => {
    if (!address || address.family !== 'IPv4') return false;
    try { validateDesktopTarget(address.address); return true; } catch { return false; }
  })?.address;
  if (!ip) { t.skip('No private test interface'); return; }
  const backend = createServer((req, res) => {
    assert.equal(req.url, '/vnc.html');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Set-Cookie', 'bad=1');
    res.end('noVNC fixture');
  });
  backend.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/websockify');
    assert.equal(req.headers.cookie, undefined);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
    socket.on('error', () => socket.destroy());
    socket.on('data', data => socket.write(data));
  });
  try {
    await new Promise<void>((resolve, reject) => { backend.once('error', reject); backend.listen(6080, ip, resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') { t.skip('Fixture port busy'); return; }
    throw error;
  }
  const gateway = make({ resolveTarget: async (owner, boundContainer) => { assert.equal(owner, 'owner'); assert.equal(boundContainer, container); return ip; } });
  const port = await listen(gateway);
  try {
    const link = new URL(gateway.issue('owner', container));
    const cookie = `desktop_access=${link.searchParams.get('access')}`;
    const response = await get(port, link.pathname + '?ignored=secret', cookie);
    assert.equal(response.body, 'noVNC fixture');
    assert.equal(response.headers['set-cookie'], undefined);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${link.pathname.replace('vnc.html', 'websockify')} HTTP/1.1\r\nHost: desktop.example\r\nOrigin: ${base}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Tunnel test timeout')); });
      let upgraded = false;
      socket.on('data', chunk => {
        if (!upgraded) { assert.match(chunk.toString(), /101 Switching Protocols/); upgraded = true; socket.write('echo'); }
        else { assert.equal(chunk.toString(), 'echo'); gateway.revokeOwner('owner'); }
      });
      socket.on('close', () => { assert(upgraded); resolve(); });
      socket.on('error', reject);
    });
  } finally { gateway.close(); backend.close(); }
});
