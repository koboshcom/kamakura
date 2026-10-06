import { pino } from 'pino';
import { config } from './config.js';
export const logger = pino({ level: config.logLevel, redact: ['apiKey', 'authorization', 'creds', 'text'] });
// Errors can contain provider response bodies, message text, or credentials.
// Log only their type, not the raw object or message.
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
