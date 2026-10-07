import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { registerDesktopCapability } from './credentials.js';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const newKey = () => digest(randomBytes(32).toString('hex'));
const sessionDigest = (owner: string, value: string) => digest(JSON.stringify([owner, value]));

export interface DesktopAccessOptions {
  publicBaseUrl: string;
  isAuthorized: (ownerId: string) => boolean;
  /** Must inspect this exact container and confirm it still belongs to ownerId. */
  resolveTarget: (ownerId: string, containerId: string) => Promise<{ ip: string; authorization: string }>;
  /** Exact socket peer IPs only, never inferred from forwarding headers. */
  trustedProxies?: ReadonlySet<string>;
  ttlMs?: number;
  maxTokens?: number;
  now?: () => number;
}
interface Grant { ownerId: string; containerId: string; redeemed: boolean; sessionHash?: string; expires: number; sockets: Set<Socket> }

export function validateDesktopTarget(ip: string): string {
  if (isIP(ip) !== 4) throw new Error('Desktop target must be a private bridge IPv4 address');
  const [a, b] = ip.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168))) throw new Error('Desktop target must be private');
  return ip;
}

export class DesktopAccess {
  readonly server = createServer((req, res) => { void this.handleHttp(req, res); });
  private readonly base: URL;
  private readonly grants = new Map<string, Grant>();
  private readonly ttl: number;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: DesktopAccessOptions) {
    this.base = new URL(options.publicBaseUrl);
    if (this.base.protocol !== 'https:' || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error('Desktop public URL must be an HTTPS origin');
    for (const ip of options.trustedProxies ?? []) if (!isIP(ip)) throw new Error('Trusted proxies must be exact IP addresses');
    this.ttl = options.ttlMs ?? 3_600_000;
    this.limit = options.maxTokens ?? 128;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 86_400_000 || !Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 4096) throw new Error('Invalid desktop access limits');
    this.now = options.now ?? Date.now;
    this.server.on('upgrade', (req, socket, head) => { void this.handleUpgrade(req, socket as Socket, head); });
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
  }

  issue(ownerId: string, containerId: string): string {
    this.sweep();
    if (!this.options.isAuthorized(ownerId) || !/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('Desktop access denied');
    if (this.grants.size >= this.limit) throw new Error('Desktop access capacity reached');
    const key = newKey();
    // Store only the capability digest. The plaintext path exists only in the issued URL.
    this.grants.set(digest(key), { ownerId, containerId, redeemed: false, expires: this.now() + this.ttl, sockets: new Set() });
    registerDesktopCapability(key, Date.now() + this.ttl);
    return `${this.base.origin}/${key}`;
  }

  revokeOwner(ownerId: string): void {
    for (const [id, grant] of this.grants) if (grant.ownerId === ownerId) this.remove(id, grant);
  }
  close(): void {
    clearInterval(this.timer);
    for (const [id, grant] of this.grants) this.remove(id, grant);
    this.server.close();
  }
  private remove(id: string, grant: Grant): void {
    for (const socket of grant.sockets) socket.destroy();
    this.grants.delete(id);
  }
  private sweep(): void {
    for (const [id, grant] of this.grants) if (grant.expires <= this.now() || !this.options.isAuthorized(grant.ownerId)) this.remove(id, grant);
  }
  private parse(req: IncomingMessage) {
    // Forwarded headers never choose link origins, owners, authorization or backends.
    // Ignore them from untrusted peers. Only configured peers may describe the
    // external scheme/host, and even then they must match the fixed public origin.
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer && this.options.trustedProxies?.has(peer)) {
      const proto = req.headers['x-forwarded-proto'];
      const host = req.headers['x-forwarded-host'];
      if ((proto !== undefined && proto !== 'https') || (host !== undefined && host !== this.base.host)) throw new Error('Invalid proxy origin');
    }
    const raw = req.url ?? '';
    // Reject ambiguous encoding and traversal before URL normalization can hide it.
    if (!raw.startsWith('/') || /[%\\\x00-\x20\x7f]/.test(raw.split('?')[0]!) || raw.split('?')[0]!.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid desktop path');
    const url = new URL(raw, this.base);
    const match = /^\/([a-f0-9]{64})(\/[^?]*)?$/.exec(url.pathname);
    if (!match || url.origin !== this.base.origin) throw new Error('Invalid desktop path');
    this.sweep();
    const id = match[1]!;
    const grant = this.grants.get(digest(id));
    if (!grant) throw new Error('Desktop access expired');
    const cookies = (req.headers.cookie ?? '').split(';').map(p => p.trim());
    const cookie = cookies.find(p => p.startsWith('desktop_access='))?.slice('desktop_access='.length);
    return { id, grant, url, path: match[2] ?? '', cookie };
  }
  private matches(secret: string | undefined, grant: Grant): boolean {
    return !!secret && !!grant.sessionHash && /^[a-f0-9]{64}$/.test(secret) && timingSafeEqual(Buffer.from(sessionDigest(grant.ownerId, secret), 'hex'), Buffer.from(grant.sessionHash, 'hex'));
  }
  private async target(grant: Grant): Promise<{ ip: string; authorization: string }> {
    const target = await this.options.resolveTarget(grant.ownerId, grant.containerId);
    const ip = validateDesktopTarget(target.ip);
    if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(target.authorization)) throw new Error('Invalid desktop backend authentication');
    if (grant.expires <= this.now() || !this.options.isAuthorized(grant.ownerId) || ![...this.grants.values()].includes(grant)) throw new Error('Desktop access expired');
    return { ip, authorization: target.authorization };
  }
  private secureHeaders(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.secureHeaders(res);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Error('Method denied');
      const { id, grant, url, path, cookie } = this.parse(req);
      if (path === '') {
        if (req.method !== 'GET' || url.search || grant.redeemed) throw new Error('Access denied');
        // Inspect the exact owner/container before redemption; recheck after the await
        // so simultaneous bootstrap requests cannot both mint a session.
        await this.target(grant);
        if (grant.redeemed) throw new Error('Access denied');
        const session = newKey();
        registerDesktopCapability(session, Date.now() + Math.max(0, grant.expires - this.now()));
        grant.sessionHash = sessionDigest(grant.ownerId, session);
        grant.redeemed = true;
        res.setHeader('Set-Cookie', `desktop_access=${session}; Path=/${id}/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((grant.expires - this.now()) / 1000))}`);
        res.writeHead(303, { Location: `/${id}/vnc.html?autoconnect=1&path=${id}/websockify` });
        res.end();
        return;
      }
      if (!this.matches(cookie, grant)) throw new Error('Access denied');
      const { ip, authorization } = await this.target(grant);
      // Only server-owned backend auth is forwarded, never incoming credentials.
      const upstream = httpRequest({ hostname: ip, port: 6080, path, method: req.method, headers: { Authorization: authorization }, timeout: 10_000 }, response => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'content-length']) { const value = response.headers[name]; if (typeof value === 'string') headers[name] = value; }
        res.writeHead(response.statusCode ?? 502, headers);
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      upstream.end();
    } catch { if (!res.headersSent) res.writeHead(403); res.end('Desktop access unavailable'); }
  }
  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    try {
      const { grant, path, cookie, url } = this.parse(req);
      if (path !== '/websockify' || url.search || !this.matches(cookie, grant) || req.headers.origin !== this.base.origin || req.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Upgrade denied');
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') throw new Error('Invalid websocket');
      if (grant.sockets.size >= 16) throw new Error('Desktop connection capacity reached');
      socket.on('error', () => socket.destroy());
      const { ip, authorization } = await this.target(grant);
      if (socket.destroyed || grant.sockets.size >= 16) throw new Error('Desktop connection unavailable');
      const upstream = httpRequest({ hostname: ip, port: 6080, path: '/websockify', headers: { Authorization: authorization, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'binary' }, timeout: 10_000 });
      grant.sockets.add(socket);
      socket.once('close', () => { grant.sockets.delete(socket); upstream.destroy(); });
      upstream.on('upgrade', (response, backend, backendHead) => {
        if (grant.expires <= this.now() || !this.options.isAuthorized(grant.ownerId) || ![...this.grants.values()].includes(grant)) { backend.destroy(); socket.destroy(); return; }
        grant.sockets.add(backend);
        backend.once('close', () => { grant.sockets.delete(backend); socket.destroy(); });
        backend.on('error', () => socket.destroy());
        socket.on('error', () => backend.destroy());
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
        if (backendHead.length) socket.write(backendHead);
        if (head.length) backend.write(head);
        backend.pipe(socket); socket.pipe(backend);
      });
      upstream.on('response', response => { response.resume(); socket.destroy(); });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      upstream.end();
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  }
}
