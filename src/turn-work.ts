import type { ToolSet } from 'ai';

/** A delivered progress promise is not a completed answer. No task inference or dispatch. */
export function turnWork() {
  let pending = false;
  let attempted = false;
  const progressText = (text: string) => /\b(?:i['’]ll|i will|let me|going to)\s+(?:check|open|look|search|fetch|inspect|run|test|build|fix|install|start|work)\b/i.test(text);
  return {
    get pending() { return pending; },
    get needsWork() { return pending && !attempted; },
    progress() { pending = true; attempted = false; },
    sent(text: string, purpose?: string) {
      if (purpose === 'progress' || (!attempted && progressText(text))) { pending = true; attempted = false; }
      else if (pending && attempted) pending = false;
    },
    attempted() { if (pending) attempted = true; },
    canEnd() { return !pending; },
    guard<T extends ToolSet>(tools: T): T {
      return Object.fromEntries(Object.entries(tools).map(([name, entry]) => [name, entry.execute ? {
        ...entry, execute: async (...args: Parameters<NonNullable<typeof entry.execute>>) => {
          try { return await entry.execute!(...args); }
          finally { if (pending) attempted = true; }
        },
      } : entry])) as T;
    },
  };
}
