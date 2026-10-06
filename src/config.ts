import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function number(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function flag(name: string, fallback = false): boolean {
  const value = process.env[name]?.toLowerCase() ?? String(fallback);
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}
export function expandPath(path: string): string {
  return resolve(path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path);
}
export function allowed(allowlist: Set<string>, chatId: string): boolean {
  return allowlist.has('*') || allowlist.has(chatId);
}
function list(name: string): Set<string> {
  return new Set((process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean));
}
export const config = {
  model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  imessage: flag('ENABLE_IMESSAGE'),
  whatsapp: flag('ENABLE_WHATSAPP'),
  imessageAllowed: list('IMESSAGE_ALLOWED_CHATS'),
  whatsappAllowed: list('WHATSAPP_ALLOWED_CHATS'),
  imessageDb: expandPath(process.env.IMESSAGE_DB_PATH || '~/Library/Messages/chat.db'),
  imessagePollMs: number('IMESSAGE_POLL_MS', 1000, 250, 60000),
  authDir: expandPath(process.env.WHATSAPP_AUTH_DIR || './data/whatsapp-auth'),
  reactions: flag('ENABLE_WHATSAPP_REACTIONS', true),
  dataDir: expandPath(process.env.DATA_DIR || './data'),
  persona: expandPath(process.env.PERSONA_PATH || './persona.md'),
  historyLimit: number('HISTORY_LIMIT', 40, 2, 200),
  debounceMs: number('DEBOUNCE_MS', 4000, 100, 60000),
  messageDelayMs: number('MESSAGE_DELAY_MS', 800, 0, 10000),
  maxReplyMessages: number('MAX_REPLY_MESSAGES', 3, 1, 10),
  maxReplyChars: number('MAX_REPLY_CHARS', 1200, 100, 10000),
  maxInputChars: number('MAX_INPUT_CHARS', 8000, 100, 50000),
  maxOutputTokens: number('MAX_OUTPUT_TOKENS', 512, 64, 4096),
  concurrency: number('MAX_CONCURRENT_REQUESTS', 2, 1, 10),
  timeoutMs: number('REQUEST_TIMEOUT_MS', 45000, 1000, 180000),
  logLevel: process.env.LOG_LEVEL || 'info',
  webSearch: flag('ENABLE_WEB_SEARCH', true),
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  maxMediaBytes: number('MAX_MEDIA_BYTES', 20971520, 1024, 52428800),
  mediaTimeoutMs: number('MEDIA_TIMEOUT_MS', 90000, 1000, 300000),
  videoSeconds: number('VIDEO_MAX_SECONDS', 20, 1, 20),
  audioSeconds: number('AUDIO_MAX_SECONDS', 300, 1, 1200),
};
