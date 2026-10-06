import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { allowed, config } from '../config.js';
import type { IncomingMessage, Transport } from '../types.js';

const inputSchema = z.object({
  chatId: z.string().min(1).max(300), id: z.string().min(1).max(300),
  sender: z.string().max(300), senderId: z.string().max(300).optional(),
  text: z.string().max(50000), isGroup: z.boolean(), timestamp: z.number(),
  media: z.array(z.object({ kind: z.enum(['image','video','audio']), mime: z.string().max(200), base64: z.string().max(30000000) })).max(4).optional(),
});

/** The macOS host polls this server. No container-to-host public callback needed. */
export class BridgeTransport implements Transport {
  readonly name = 'imessage' as const;
  private server?: Server;
  private db?: Database.Database;

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (config.bridgeToken.length < 32) throw new Error('BRIDGE_TOKEN must contain at least 32 random characters');
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const db = this.db = new Database(join(config.dataDir, 'bridge.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS outgoing (id INTEGER PRIMARY KEY, chat TEXT, text TEXT, claimed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER);`);
    this.server = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const a = Buffer.from(token), b = Buffer.from(config.bridgeToken);
      if (a.length !== b.length || !timingSafeEqual(a,b)) { res.writeHead(401).end(); return; }
      try {
        if (req.method === 'GET' && req.url === '/outgoing') {
          // Claim before returning. Never duplicate a send after an uncertain HTTP result.
          const items = db.transaction(() => {
            const rows = db.prepare('SELECT id,chat,text FROM outgoing WHERE claimed=0 ORDER BY id LIMIT 10').all();
            for (const row of rows as { id: number }[]) db.prepare('UPDATE outgoing SET claimed=1 WHERE id=?').run(row.id);
            return rows;
          })();
          res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(items)); return;
        }
        if (req.method !== 'POST' || req.url !== '/incoming') { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > config.maxMediaBytes * 2 + 100000) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(chunk);
        }
        const parsed = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (!allowed(config.imessageAllowed, parsed.chatId)) { res.writeHead(403).end(); return; }
        const media = parsed.media?.map(m => ({ kind: m.kind, mime: m.mime, data: Buffer.from(m.base64, 'base64') }));
        if (media?.some(m => m.data.length > config.maxMediaBytes)) { res.writeHead(413).end(); return; }
        const fresh = db.prepare('INSERT OR IGNORE INTO seen (id,at) VALUES (?,?)').run(parsed.id, Date.now()).changes;
        if (fresh) onMessage({ ...parsed, media, transport: 'imessage' });
        db.prepare('DELETE FROM seen WHERE at < ?').run(Date.now() - 30 * 86400000);
        res.writeHead(204).end();
      } catch { if (!res.headersSent) res.writeHead(400).end(); }
    });
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve,reject) => { this.server!.once('error',reject); this.server!.listen(config.bridgePort,config.bridgeHost,resolve); });
  }
  async send(chatId: string, text: string): Promise<void> {
    if (!allowed(config.imessageAllowed, chatId)) throw new Error('Chat not authorized');
    this.db!.prepare('INSERT INTO outgoing (chat,text) VALUES (?,?)').run(chatId,text);
  }
  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.db?.close();
  }
}
