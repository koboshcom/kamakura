import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function number(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
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
export function allowed(allowlist: Set<string>, chatId: string): boolean { return allowlist.has('*') || allowlist.has(chatId); }
function list(name: string): Set<string> { return new Set((process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean)); }
export function sizeBytes(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([kmgt])?(?:i?b)?$/i);
  if (!match) throw new Error('Invalid byte size');
  const bytes = Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3, t: 4 }[match[2]?.toLowerCase() ?? ''] ?? 0);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid byte size');
  return bytes;
}
const cpus = Number(process.env.SANDBOX_CPUS ?? 2);
if (!Number.isFinite(cpus) || cpus < 0.1 || cpus > 32) throw new Error('SANDBOX_CPUS must be 0.1-32');
const groupMode = process.env.TELEGRAM_GROUP_MODE || 'ambient';
if (!['ambient', 'mentions'].includes(groupMode)) throw new Error('TELEGRAM_GROUP_MODE must be ambient or mentions');
const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function parseReasoningEffort(value = 'xhigh'): typeof reasoningEfforts[number] {
  if (!(reasoningEfforts as readonly string[]).includes(value)) throw new Error('OPENAI_REASONING_EFFORT must be none, low, medium, high, xhigh or max');
  return value as typeof reasoningEfforts[number];
}
export const config = {
  model: process.env.OPENAI_MODEL || 'gpt-6-luna',
  reasoningEffort: parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowed: list('TELEGRAM_ALLOWED_CHATS'),
  groupMode,
  reactions: flag('ENABLE_REACTIONS', true),
  dataDir: expandPath(process.env.DATA_DIR || './data'),
  persona: expandPath(process.env.PERSONA_PATH || './persona.md'),
  historyLimit: number('HISTORY_LIMIT', 40, 2, 200),
  debounceMs: number('DEBOUNCE_MS', 4000, 100, 60000),
  messageDelayMs: number('MESSAGE_DELAY_MS', 800, 0, 10000),
  maxReplyMessages: number('MAX_REPLY_MESSAGES', 3, 1, 10),
  maxReplyChars: number('MAX_REPLY_CHARS', 1200, 100, 4000),
  maxInputChars: number('MAX_INPUT_CHARS', 8000, 100, 50000),
  maxOutputTokens: number('MAX_OUTPUT_TOKENS', 512, 64, 4096),
  concurrency: number('MAX_CONCURRENT_REQUESTS', 2, 1, 10),
  timeoutMs: number('REQUEST_TIMEOUT_MS', 120000, 1000, 300000),
  logLevel: process.env.LOG_LEVEL || 'info',
  webSearch: flag('ENABLE_WEB_SEARCH', true),
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  maxMediaBytes: number('MAX_MEDIA_BYTES', 20971520, 1024, 20971520),
  mediaTimeoutMs: number('MEDIA_TIMEOUT_MS', 90000, 1000, 300000),
  videoSeconds: number('VIDEO_MAX_SECONDS', 20, 1, 20),
  audioSeconds: number('AUDIO_MAX_SECONDS', 300, 1, 1200),
  sandbox: {
    allowed: list('SANDBOX_ALLOWED_USERS'),
    image: process.env.SANDBOX_IMAGE || 'kamakura-sandbox:local',
    socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    instance: process.env.SANDBOX_INSTANCE || 'default',
    cpus, memory: sizeBytes(process.env.SANDBOX_MEMORY || '3g'),
    disk: sizeBytes(process.env.SANDBOX_DISK || '35G'),
    pids: number('SANDBOX_PIDS', 256, 16, 1024),
    network: flag('SANDBOX_NETWORK'),
    tailscale: flag('SANDBOX_TAILSCALE'),
    idleMs: number('SANDBOX_IDLE_SECONDS', 1800, 60, 86400) * 1000,
    commandMs: number('SANDBOX_COMMAND_TIMEOUT_SECONDS', 30, 1, 120) * 1000,
    maxOutput: number('SANDBOX_MAX_OUTPUT_BYTES', 16000, 1024, 100000),
    maxContainers: number('SANDBOX_MAX_CONTAINERS', 4, 1, 100),
    root: expandPath(process.env.SANDBOX_ROOT || './sandboxes'),
    rootView: process.env.SANDBOX_ROOT_VIEW ? expandPath(process.env.SANDBOX_ROOT_VIEW) : undefined,
    allowSoftQuota: flag('SANDBOX_ALLOW_SOFT_QUOTA'),
  },
};
if (config.sandbox.tailscale && !config.sandbox.network) throw new Error('SANDBOX_TAILSCALE requires SANDBOX_NETWORK=true');
if (!/^[a-z0-9-]{1,32}$/.test(config.sandbox.instance)) throw new Error('SANDBOX_INSTANCE must be 1-32 lowercase letters, numbers or hyphens');
