// Reference-counted chat activity, shared by chat generation and background work.
export class TypingActivity {
  private active = new Map<string, { count: number; timer?: NodeJS.Timeout; busy: boolean; controller: AbortController }>();
  constructor(private readonly send: (chatId: string, signal: AbortSignal) => Promise<unknown>, private readonly intervalMs = 4000) {}
  start(chatId: string): () => void {
    let entry = this.active.get(chatId);
    if (!entry) {
      entry = { count: 0, busy: false, controller: new AbortController() };
      this.active.set(chatId, entry);
      const current = entry;
      const tick = async () => {
        if (current.busy || this.active.get(chatId) !== current) return;
        current.busy = true;
        try { await this.send(chatId, current.controller.signal); }
        catch { if (this.active.get(chatId) === current) this.clear(chatId); }
        finally { current.busy = false; }
      };
      current.timer = setInterval(() => void tick(), this.intervalMs);
      current.timer.unref();
      void tick();
    }
    entry.count++;
    const current = entry;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (this.active.get(chatId) === current && --current.count === 0) this.clear(chatId);
    };
  }
  private clear(chatId: string): void {
    const entry = this.active.get(chatId);
    if (!entry) return;
    clearInterval(entry.timer);
    entry.controller.abort();
    this.active.delete(chatId);
  }
  stop(): void { for (const chatId of this.active.keys()) this.clear(chatId); }
}
