import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from './types.js';

export interface WorkJob { id: string; task: string; incoming: IncomingMessage; }
type Runner = (job: WorkJob, signal: AbortSignal) => Promise<string>;
type Deliver = (job: WorkJob, text: string) => Promise<void>;

// Minimal in-process handoff. No unbounded queue, one active job per owner.
// Jobs are never persisted/replayed because they can have external side effects.
export class BackgroundJobs {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopped = false;
  constructor(private readonly run: Runner, private readonly deliver: Deliver,
    private readonly authorize: (incoming: IncomingMessage) => boolean,
    private readonly settings = { concurrency: 2, timeoutMs: 600000 },
    private readonly reportDeliveryFailure: (error: unknown) => void = () => {}) {}

  start(incoming: IncomingMessage, task: string): { id: string; status: 'started' } {
    if (this.stopped) throw new Error('Workers are shutting down');
    if (!this.authorize(incoming)) throw new Error('Background work requires an authorized private chat');
    if (!task.trim() || task.length > 8000) throw new Error('Worker task must be 1-8000 characters');
    const owner = incoming.senderId!;
    if (this.active.has(owner)) throw new Error('You already have a worker running');
    if (this.active.size >= this.settings.concurrency) throw new Error('Workers are busy, try again later');
    // Copy trusted routing fields. The model never chooses another owner/chat.
    const job: WorkJob = { id: randomUUID(), task, incoming: { ...incoming, media: undefined } };
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve() };
    this.active.set(owner, entry);
    entry.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
      let text: string;
      try {
        if (!this.authorize(job.incoming)) throw new Error('Authorization revoked');
        controller.signal.throwIfAborted();
        const result = await this.run(job, controller.signal);
        controller.signal.throwIfAborted();
        text = result.trim() || 'the worker finished without a written result.';
      } catch {
        // Never send provider/tool error bodies, which may contain secrets.
        text = controller.signal.aborted ? 'the worker stopped before finishing. a command already running may still finish.' : 'the worker failed before finishing. some actions may already have completed.';
      } finally { clearTimeout(timer); }
      try {
        if (!this.stopped && this.authorize(job.incoming)) await this.deliver(job, text.slice(0, 12000));
      } catch (error) { this.reportDeliveryFailure(error); }
      finally { this.active.delete(owner); }
    });
    return { id: job.id, status: 'started' };
  }

  async drain(): Promise<void> { await Promise.all([...this.active.values()].map(entry => entry.done)); }
  stop(): void {
    this.stopped = true;
    for (const entry of this.active.values()) entry.controller.abort();
  }
}
