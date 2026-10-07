import { pino } from 'pino';
import { config } from './config.js';
import { redactStoredCredentials } from './credentials.js';
const scrubText = (text: string): string => redactStoredCredentials(text).replace(/\b[a-f0-9]{64}\b/gi, '[capability redacted]');
const scrub = (value: unknown): unknown => {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
};
export const logger = pino({ level: config.logLevel, redact: ['apiKey', 'authorization', 'creds', 'text'], formatters: { log: object => scrub(object) as Record<string, unknown> }, hooks: { logMethod(args, method) { method.apply(this, args.map(arg => typeof arg === 'string' ? scrubText(arg) : arg) as typeof args); } } });
// Errors can contain provider response bodies, message text, or credentials.
// Log only their type, not the raw object or message.
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
