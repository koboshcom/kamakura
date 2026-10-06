import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** No model-chosen paths. User facts remain scoped to the chat they were shared in. */
export class FactsStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private path(chat: string, user?: string): string {
    const id = createHash('sha256').update(JSON.stringify([chat, user ?? null])).digest('hex');
    return join(this.dir, `${id}.json`);
  }
  read(chat: string, user?: string): string[] {
    try { return JSON.parse(readFileSync(this.path(chat, user), 'utf8')).facts; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  }
  update(chat: string, user: string | undefined, fact: string, remove = false): string[] {
    if (!fact.trim() || fact.length > 500) throw new Error('Fact must be 1-500 characters');
    const facts = this.read(chat, user).filter(x => x !== fact);
    if (!remove) facts.push(fact);
    if (facts.length > 100) throw new Error('Fact limit reached; remove outdated facts first');
    const path = this.path(chat, user);
    writeFileSync(`${path}.tmp`, JSON.stringify({ facts }, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return facts;
  }
}
