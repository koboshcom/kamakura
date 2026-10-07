import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { redactCredentials } from './credentials.js';

/** Delivery is awaited before a long tool can execute, including parallel calls. */
export function taskProgress(send?: (text: string) => Promise<void>, alreadySent:()=>boolean=()=>false, current?:()=>boolean, requireAnnouncement=false) {
  const check=()=>{if(current&&!current())throw new Error('Turn superseded before task dispatch');};
  let announcement: Promise<void> | undefined;
  const announce = tool({
    description: 'Only for genuinely long tasks, send a brief progress acknowledgment before starting. Quick lookups and checks use tools directly, then answer once. This is intent, not completion; continue work in this turn or start an authorized worker.',
    inputSchema: z.object({ text: z.string().trim().min(1).max(240) }),
    execute: async ({ text }) => {
      check();
      if (!announcement) announcement = Promise.resolve().then(() => send?.(redactCredentials(text).replace(/—/g, ', ')));
      await announcement;
      return { announced: true };
    },
  });
  return {
    tools: send ? { announce_task: announce } : {} as Record<string, never>,
    get announced() { return Boolean(announcement); },
    guard<T extends ToolSet>(tools: T): T {
      if (!send && !current) return tools;
      return Object.fromEntries(Object.entries(tools).map(([name, entry]) => [name, entry.execute ? {
        ...entry, execute: async (...args: Parameters<NonNullable<typeof entry.execute>>) => {
          check();
          if (requireAnnouncement && send && !announcement && !alreadySent()) throw new Error('Call announce_task with a short intended action before beginning this task.');
          await announcement;
          check();
          return entry.execute!(...args);
        },
      } : entry])) as T;
    },
  };
}
