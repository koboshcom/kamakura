import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredMessage {
  role: 'user' | 'assistant';
  sender?: string;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = {};
    }
  }

  get(key: string): StoredMessage[] {
    return [...(this.data[key] ?? [])];
  }

  add(key: string, message: StoredMessage): void {
    this.data[key] = [...(this.data[key] ?? []), message].slice(-this.limit);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
