import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from './types.js';

export interface WorkJob {
  id: string; task: string; incoming: IncomingMessage;
  takeMessages?: () => string[];
  sendMessage?: (text: string) => Promise<{ sent: boolean }>;
}
type ActiveJob = { id: string; incoming: IncomingMessage; inbox: string[]; sent: number; controller: AbortController; done: Promise<void> };
type Runner = (job: WorkJob, signal: AbortSignal) => Promise<string>;
type Deliver = (job: WorkJob, text: string) => Promise<void>;

// Minimal in-process handoff. No unbounded queue, one active job per owner.
// Jobs are never persisted/replayed because they can have external side effects.
export class BackgroundJobs {
  private readonly active = new Map<string, ActiveJob>();
  private stopped = false;
  constructor(private readonly run: Runner, private readonly deliver: Deliver,
    private readonly authorize: (incoming: IncomingMessage) => boolean,
    private readonly settings = { concurrency: 2, timeoutMs: 600000 },
    private readonly reportDeliveryFailure: (error: unknown) => void = () => {},
    private readonly activity: (incoming: IncomingMessage) => (() => void) = () => () => {}) {}

  start(incoming: IncomingMessage, task: string): { id: string; status: 'started' } {
    if (this.stopped) throw new Error('Workers are shutting down');
    if (!this.authorize(incoming)) throw new Error('Background work requires an authenticated authorized owner and chat');
    if (!task.trim() || task.length > 8000) throw new Error('Worker task must be 1-8000 characters');
    const owner = incoming.senderId!;
    if (this.active.has(owner)) throw new Error('You already have a worker running');
    if (this.active.size >= this.settings.concurrency) throw new Error('Workers are busy, try again later');
    // Copy trusted routing fields. The model never chooses another owner/chat.
    const job: WorkJob = { id: randomUUID(), task, incoming: { ...incoming, media: undefined } };
    const controller = new AbortController();
    const entry: ActiveJob = { id: job.id, incoming: job.incoming, inbox: [], sent: 0, controller, done: Promise.resolve() };
    this.active.set(owner, entry);
    job.takeMessages = () => {
      controller.signal.throwIfAborted();
      if (!this.authorize(job.incoming)) throw new Error('Authorization revoked');
      return entry.inbox.splice(0);
    };
    job.sendMessage = async text => {
      controller.signal.throwIfAborted();
      if (this.stopped || !this.authorize(job.incoming)) throw new Error('Worker cannot send messages');
      if (!text.trim() || text.length > 2000 || entry.sent >= 4) throw new Error('Worker progress message limit reached');
      entry.sent++;
      await this.deliver(job, text.trim());
      return { sent: true };
    };
    entry.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const stopActivity = this.activity(job.incoming);
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
      finally { stopActivity(); this.active.delete(owner); }
    });
    return { id: job.id, status: 'started' };
  }

  private owned(incoming: IncomingMessage, id: string): ActiveJob {
    if (!this.authorize(incoming)) throw new Error('Background work requires an authenticated authorized owner and chat');
    const entry = this.active.get(incoming.senderId!);
    if (!entry || entry.id !== id || entry.incoming.chatId !== incoming.chatId) throw new Error('Worker not found for this owner');
    return entry;
  }
  status(incoming: IncomingMessage): { id: string; status: string; pendingMessages: number } | null {
    if (!this.authorize(incoming)) throw new Error('Background work requires an authenticated authorized owner and chat');
    const entry = this.active.get(incoming.senderId!);
    return entry ? { id: entry.id, status: entry.controller.signal.aborted ? 'stopping' : 'running', pendingMessages: entry.inbox.length } : null;
  }
  message(incoming: IncomingMessage, id: string, text: string): { queued: boolean } {
    const entry = this.owned(incoming, id);
    entry.controller.signal.throwIfAborted();
    if (!text.trim() || text.length > 2000 || entry.inbox.length >= 8) throw new Error('Worker inbox limit reached');
    entry.inbox.push(text.trim());
    return { queued: true };
  }
  cancel(incoming: IncomingMessage, id: string): { cancelled: boolean } {
    this.owned(incoming, id).controller.abort();
    return { cancelled: true };
  }

  async drain(): Promise<void> { await Promise.all([...this.active.values()].map(entry => entry.done)); }
  stop(): void {
    this.stopped = true;
    for (const entry of this.active.values()) entry.controller.abort();
  }
}
