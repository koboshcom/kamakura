import Database from 'better-sqlite3';
import { IMessageSDK } from '@photon-ai/imessage-kit';
import { NSAttributedString, Unarchiver } from '@parseaple/typedstream';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowed, config } from '../config.js';
import { errorType, logger } from '../logger.js';
import type { IncomingMessage, Transport } from '../types.js';

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  body: Buffer | null;
  handle: string | null;
  chat_guid: string;
  style: number;
  date: number;
}

const appleEpochMs = Date.UTC(2001, 0, 1);

function decode(body: Buffer | null): string | null {
  if (!body?.length) return null;
  try {
    const root = Unarchiver.open(body, Unarchiver.BinaryDecoding.decodable).decodeSingleRoot();
    return root instanceof NSAttributedString ? root.string : null;
  } catch {
    return null;
  }
}

export class IMessageTransport implements Transport {
  readonly name = 'imessage' as const;
  private db?: Database.Database;
  private timer?: NodeJS.Timeout;
  private sdk?: IMessageSDK;
  private readonly cursorPath = join(config.dataDir, 'imessage-cursor.json');
  private cursor = 0;

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('iMessage only runs on macOS');
    this.db = new Database(config.imessageDb, { readonly: true, fileMustExist: true });
    this.sdk = new IMessageSDK({ databasePath: config.imessageDb, maxConcurrentSends: 1 });
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.cursor = JSON.parse(readFileSync(this.cursorPath, 'utf8')).rowid;
    } catch {
      // On first start, ignore old messages instead of replying to the whole archive.
      this.cursor = (this.db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS id FROM message').get() as { id: number }).id;
    }
    const query = this.db.prepare(`
      SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody AS body, h.id AS handle,
             c.guid AS chat_guid, c.style, m.date
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.item_type = 0
        AND COALESCE(m.associated_message_type, 0) = 0
      ORDER BY m.ROWID LIMIT 200`);
    const poll = () => {
      try {
        const rows = query.all(this.cursor) as Row[];
        for (const row of rows) {
          this.cursor = row.rowid;
          const text = (row.text || decode(row.body))?.replace(/\uFFFC/g, '').trim();
          if (!text || !allowed(config.imessageAllowed, row.chat_guid)) continue;
          onMessage({
            transport: 'imessage',
            chatId: row.chat_guid,
            id: row.guid,
            sender: row.handle ?? 'unknown',
            text,
            isGroup: row.style === 43,
            timestamp: appleEpochMs + Math.floor(row.date / 1e6),
          });
        }
        if (rows.length) writeFileSync(this.cursorPath, JSON.stringify({ rowid: this.cursor }), { mode: 0o600 });
      } catch (error) {
        logger.error({ err: errorType(error) }, 'imessage poll failed');
      }
    };
    poll();
    this.timer = setInterval(poll, config.imessagePollMs);
    logger.info('imessage polling started');
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.sdk?.send({ to: chatId, text });
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.sdk?.close();
    this.db?.close();
  }
}
