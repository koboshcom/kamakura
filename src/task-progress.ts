import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { redactCredentials } from './credentials.js';

/** Delivery is awaited before a long tool can execute, including parallel calls. */
export function taskProgress(send?: (text: string) => Promise<void>, alreadySent:()=>boolean=()=>false) {
  let announcement: Promise<void> | undefined;
  const announce = tool({
    description: 'Before a task that needs tools or takes more than a few seconds, send one short natural line saying what you will do. This is intent, not a success claim. Call once before starting work, then report the verified result.',
    inputSchema: z.object({ text: z.string().trim().min(1).max(240) }),
    execute: async ({ text }) => {
      if (!announcement) announcement = Promise.resolve().then(() => send?.(redactCredentials(text).replace(/—/g, ', ')));
      await announcement;
      return { announced: true };
    },
  });
  return {
    tools: send ? { announce_task: announce } : {} as Record<string, never>,
    get announced() { return Boolean(announcement); },
    guard<T extends ToolSet>(tools: T): T {
      if (!send) return tools;
      return Object.fromEntries(Object.entries(tools).map(([name, entry]) => [name, entry.execute ? {
        ...entry, execute: async (...args: Parameters<NonNullable<typeof entry.execute>>) => {
          if (!announcement && !alreadySent()) throw new Error('Call announce_task with a short intended action before beginning this task.');
          await announcement;
          return entry.execute!(...args);
        },
      } : entry])) as T;
    },
  };
}
