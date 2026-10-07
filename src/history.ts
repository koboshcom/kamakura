import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCredentials, redactCredentials } from './credentials.js';

export interface StoredMessage {
  role: 'user' | 'assistant';
  sender?: string;
  senderId?: string;
  /** Captured by authenticated transport; only retained in volatile history. */
  credentialEligible?: boolean;
  text: string;
  at: number;
}

export class HistoryStore {
  private readonly path: string;
  private data: Record<string, StoredMessage[]>;

  constructor(dir: string, private readonly limit: number) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'history.json');
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const messages of Object.values(this.data)) for (const item of messages) {
        captureCredentials(item.text);
        item.text = redactCredentials(item.text);
        item.credentialEligible = false;
      }
      this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = {};
    }
  }

  get(key: string): StoredMessage[] {
    return [...(this.data[key] ?? [])];
  }

  add(key: string, message: StoredMessage): void {
    captureCredentials(message.text);
    this.data[key] = [...(this.data[key] ?? []), message].slice(-this.limit);
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const persisted = Object.fromEntries(Object.entries(this.data).map(([chat, messages]) => [chat,
      messages.map(item => ({ ...item, credentialEligible: false, text: redactCredentials(item.text) }))]));
    writeFileSync(tmp, JSON.stringify(persisted), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
