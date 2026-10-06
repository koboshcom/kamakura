import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorType, logger } from './logger.js';

export interface Reminder {
  id: number;
  transport: string;
  chat: string;
  owner: string;
  text: string;
  due: number;
  state: string;
}

export class Reminders {
  private readonly db: Database.Database;
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY, transport TEXT NOT NULL, chat TEXT NOT NULL, owner TEXT NOT NULL,
      text TEXT NOT NULL, due INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');`);
  }
  schedule(transport: string, chat: string, owner: string, text: string, due: number): number {
    if (!Number.isSafeInteger(due) || due < Date.now() + 1000 || due > Date.now() + 366 * 86400000) throw new Error('Due time must be within the next year');
    if (!text.trim() || text.length > 1200) throw new Error('Reminder must be 1-1200 characters');
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE chat=? AND state='pending'").get(chat) as { n: number };
    if (count.n >= 100) throw new Error('This chat has 100 pending reminders');
    return Number(this.db.prepare('INSERT INTO reminders (transport,chat,owner,text,due) VALUES (?,?,?,?,?)').run(transport,chat,owner,text,due).lastInsertRowid);
  }
  list(chat: string, owner: string): Reminder[] {
    return this.db.prepare("SELECT * FROM reminders WHERE chat=? AND owner=? AND state='pending' ORDER BY due").all(chat, owner) as Reminder[];
  }
  cancel(chat: string, owner: string, id: number): boolean {
    return Boolean(this.db.prepare("UPDATE reminders SET state='cancelled' WHERE id=? AND chat=? AND owner=? AND state='pending'").run(id,chat,owner).changes);
  }
  start(deliver: (reminder: Reminder) => Promise<void>): void {
    // At most once: an uncertain send stays claimed, including across crashes. Never auto-resend.
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        const due = this.db.prepare("SELECT * FROM reminders WHERE due<=? AND state='pending' ORDER BY due LIMIT 10").all(Date.now()) as Reminder[];
        for (const item of due) {
          if (!this.db.prepare("UPDATE reminders SET state='claimed' WHERE id=? AND state='pending'").run(item.id).changes) continue;
          try {
            await deliver(item);
            this.db.prepare("UPDATE reminders SET state='sent' WHERE id=?").run(item.id);
          } catch (error) {
            logger.error({ err: errorType(error), reminderId: item.id }, 'reminder send uncertain; not retrying');
          }
        }
      } finally { this.busy = false; }
    };
    this.timer = setInterval(() => void tick(), 1000);
    void tick();
  }
  stop(): void { clearInterval(this.timer); }
  close(): void { this.stop(); this.db.close(); }
}
