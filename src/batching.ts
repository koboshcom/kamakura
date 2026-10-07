import { chatKey, type IncomingMessage } from './types.js';

type Batch = { last: IncomingMessage; revision: number; due: number; busy: boolean; recording:Promise<void>; deliveredRevision?:number; timer?: NodeJS.Timeout };

/** Serialize each chat, and discard a generated answer if a newer message arrived. */
export class ReplyBatches {
  private batches = new Map<string, Batch>();
  private seen = new Set<string>();
  constructor(private readonly debounceMs: number, private readonly maxChars: number,
    private readonly reply: (message: IncomingMessage, current: () => boolean, delivered?:()=>void) => Promise<void>,
    private readonly record: (message: IncomingMessage) => void | Promise<void>,
    private readonly failed: (error: unknown) => void) {}

  receive(message: IncomingMessage): void {
    const key = chatKey(message);
    const id = `${key}:${message.id}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    const recording=Promise.resolve(this.record(message));
    message = { ...message, text: message.text.slice(0, this.maxChars) };
    void recording.catch(()=>undefined);
    const existing = this.batches.get(key);
    if (existing) {
      existing.recording=Promise.all([existing.recording,recording]).then(()=>undefined);
      void existing.recording.catch(()=>undefined);
      if (existing.last.senderId === message.senderId && existing.deliveredRevision !== existing.revision) {
        message = { ...message,
          text: `${existing.last.text}\n${message.text}`.slice(-this.maxChars),
          media: [...(existing.last.media ?? []), ...(message.media ?? [])].slice(-4),
          addressed: Boolean(message.addressed || existing.last.addressed),
          credentialEligible: message.credentialEligible === true && existing.last.credentialEligible === true,
          learningEligible: message.learningEligible === true && existing.last.learningEligible === true };
      }
      existing.last = message;
      existing.revision++;
      existing.due = Date.now() + this.debounceMs;
      this.arm(key, existing);
    } else {
      const batch: Batch = { last: message, revision: 1, due: Date.now() + this.debounceMs, busy: false, recording };
      this.batches.set(key, batch);
      this.arm(key, batch);
    }
  }

  private arm(key: string, batch: Batch): void {
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => void this.flush(key, batch), Math.max(0, batch.due - Date.now()));
  }
  private async flush(key: string, batch: Batch): Promise<void> {
    if (batch.busy || this.batches.get(key) !== batch) return;
    batch.busy = true;
    const revision = batch.revision;
    const current = () => this.batches.get(key) === batch && batch.revision === revision;
    try { await batch.recording; if(!current())return; await this.reply({ ...batch.last }, current,()=>{if(current())batch.deliveredRevision=revision;}); }
    catch (error) { this.failed(error); }
    finally {
      batch.busy = false;
      if (current()) { clearTimeout(batch.timer); this.batches.delete(key); }
      else if (this.batches.get(key) === batch) this.arm(key, batch);
    }
  }
  stop(): void {
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
  }
}
