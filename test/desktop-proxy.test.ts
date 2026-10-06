import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { DesktopAccess } from '../src/desktop-access.js';

async function probe(trustedProxies: Set<string>, headers: Record<string, string>) {
  const gateway = new DesktopAccess({ publicBaseUrl: 'https://vnc.kamakura.kobosh.com', trustedProxies,
    isAuthorized: id => id === 'owner', resolveTarget: async () => { throw new Error('Bootstrap must not resolve backend'); } });
  try {
    const link = new URL(gateway.issue('owner', 'a'.repeat(64)));
    assert.equal(link.origin, 'https://vnc.kamakura.kobosh.com');
    await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
    const address = gateway.server.address(); assert(address && typeof address !== 'string');
    return await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: link.pathname + link.search, headers }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!));
      });
      req.once('error', reject); req.end();
    });
  } finally { gateway.close(); }
}

test('untrusted forwarded headers cannot alter configured origin or grant authentication', async () => {
  assert.equal(await probe(new Set(), { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '127.0.0.1' }), 303);
  assert.equal(await probe(new Set(['10.0.0.1']), { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' }), 303);
});
test('only exact trusted socket peer may supply matching external scheme/host', async () => {
  const trusted = new Set(['127.0.0.1']);
  assert.equal(await probe(trusted, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'vnc.kamakura.kobosh.com' }), 303);
  assert.equal(await probe(trusted, { 'x-forwarded-proto': 'http' }), 403);
  assert.equal(await probe(trusted, { 'x-forwarded-host': 'evil.example' }), 403);
  assert.equal(await probe(trusted, { 'x-forwarded-proto': 'https,http' }), 403);
});
test('proxy wildcard CIDR and hostname trust entries fail closed', () => {
  for (const value of ['*', '127.0.0.0/8', 'localhost']) assert.throws(() => new DesktopAccess({
    publicBaseUrl: 'https://vnc.example', trustedProxies: new Set([value]), isAuthorized: () => true,
    resolveTarget: async () => ({ ip: '10.0.0.2', authorization: 'Basic YQ==' }),
  }), /exact IP/);
});
