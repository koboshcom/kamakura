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
export function parseReasoningEffort(value = 'low', name = 'OPENAI_REASONING_EFFORT'): typeof reasoningEfforts[number] {
  if (!(reasoningEfforts as readonly string[]).includes(value)) throw new Error(`${name} must be none, low, medium, high, xhigh or max`);
  return value as typeof reasoningEfforts[number];
}
export const config = {
  learning: {
    enabled: flag('ENABLE_LEARNING', true),
    owners: list('LEARNING_OWNER_IDS'),
    maxBytes: number('LEARNING_MAX_BYTES', 16384, 2048, 32768),
    maxLessons: number('LEARNING_MAX_LESSONS', 32, 1, 64),
    revisions: number('LEARNING_REVISIONS', 10, 1, 20),
    debounceMs: number('LEARNING_DEBOUNCE_MS', 15000, 100, 300000),
    intervalMs: number('LEARNING_INTERVAL_MS', 60000, 100, 3600000),
    timeoutMs: number('LEARNING_TIMEOUT_MS', 30000, 1000, 120000),
  },
  model: process.env.OPENAI_MODEL || 'gpt-6-luna',
  reasoningEffort: parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT ?? 'medium'),
  chatMaxSteps: number('CHAT_MAX_STEPS', 12, 2, 30),
  chatContextTokens: number('CHAT_CONTEXT_TOKENS', 256000, 4096, 2000000),
  workerContextTokens: number('WORKER_CONTEXT_TOKENS', 256000, 4096, 2000000),
  workerEffort: parseReasoningEffort(process.env.OPENAI_WORKER_EFFORT ?? 'high', 'OPENAI_WORKER_EFFORT'),
  workerTimeoutMs: number('WORKER_TIMEOUT_MS', 600000, 1000, 1800000),
  workerMaxOutputTokens: number('WORKER_MAX_OUTPUT_TOKENS', 4096, 512, 16384),
  workerMaxSteps: number('WORKER_MAX_STEPS', 24, 2, 30),
  workerConcurrency: number('WORKER_MAX_CONCURRENT', 2, 1, 10),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowed: list('TELEGRAM_ALLOWED_CHATS'),
  groupMode,
  reactions: flag('ENABLE_REACTIONS', true),
  dataDir: expandPath(process.env.DATA_DIR || './data'),
  persona: expandPath(process.env.PERSONA_PATH || './persona.md'),
  historyLimit: number('HISTORY_LIMIT', 40, 2, 200),
  historyContextMessages: number('HISTORY_CONTEXT_MESSAGES', 3, 0, 10),
  debounceMs: number('DEBOUNCE_MS', 4000, 100, 60000),
  messageDelayMs: number('MESSAGE_DELAY_MS', 800, 0, 10000),
  maxReplyMessages: number('MAX_REPLY_MESSAGES', 3, 1, 10),
  maxReplyChars: number('MAX_REPLY_CHARS', 1200, 100, 4000),
  maxInputChars: number('MAX_INPUT_CHARS', 8000, 100, 50000),
  maxOutputTokens: number('MAX_OUTPUT_TOKENS', 2048, 64, 4096),
  concurrency: number('MAX_CONCURRENT_REQUESTS', 2, 1, 10),
  timeoutMs: number('REQUEST_TIMEOUT_MS', 120000, 1000, 300000),
  logLevel: process.env.LOG_LEVEL || 'info',
  webSearch: flag('ENABLE_WEB_SEARCH', true),
  localDevices: {
    enabled: flag('LOCAL_DEVICES_ENABLED'),
    host: process.env.LOCAL_DEVICES_HOST ?? '0.0.0.0',
    port: number('LOCAL_DEVICES_PORT', 47943, 1024, 65535),
    publicUrl: process.env.LOCAL_DEVICES_PUBLIC_URL ?? '',
  },
  desktopPublicBaseUrl: process.env.NOVNC_PUBLIC_URL ?? process.env.DESKTOP_PUBLIC_BASE_URL ?? '',
  desktopPort: process.env.NOVNC_PORT !== undefined ? number('NOVNC_PORT', 47831, 1024, 65535) : number('DESKTOP_PORT', 47831, 1024, 65535),
  desktopHost: process.env.NOVNC_HOST ?? process.env.DESKTOP_HOST ?? '0.0.0.0',
  desktopTrustedProxies: list('NOVNC_TRUSTED_PROXIES'),
  desktopTtlMs: number('DESKTOP_TOKEN_TTL_MS', 3600000, 1000, 86400000),
  speech: {baseUrl:process.env.SPEECH_TTS_BASE_URL??'',apiKey:process.env.SPEECH_TTS_API_KEY??'',model:process.env.SPEECH_TTS_MODEL??'',voice:process.env.SPEECH_TTS_VOICE??''},
  transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
  transcriptionBaseUrl: process.env.OPENAI_TRANSCRIBE_BASE_URL || undefined,
  transcriptionApiKey: process.env.OPENAI_TRANSCRIBE_API_KEY || undefined,
  maxMediaBytes: number('MAX_MEDIA_BYTES', 20971520, 1024, 20971520),
  mediaTimeoutMs: number('MEDIA_TIMEOUT_MS', 90000, 1000, 300000),
  videoSeconds: number('VIDEO_MAX_SECONDS', 20, 1, 20),
  audioSeconds: number('AUDIO_MAX_SECONDS', 300, 1, 1200),
  sandbox: {
    allowed: list('SANDBOX_ALLOWED_USERS'),
    image: process.env.SANDBOX_IMAGE || 'kamakura-sandbox:local',
    socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    coreSocketPath: process.env.CORE_DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    usernsRoot: flag('SANDBOX_USERNS_ROOT'),
    instance: process.env.SANDBOX_INSTANCE || 'default',
    cpus, memory: sizeBytes(process.env.SANDBOX_MEMORY || '3g'),
    disk: sizeBytes(process.env.SANDBOX_DISK || '35G'),
    pids: number('SANDBOX_PIDS', 256, 16, 1024),
    network: flag('SANDBOX_NETWORK'),
    idleMs: number('SANDBOX_IDLE_SECONDS', 1800, 60, 86400) * 1000,
    commandMs: number('SANDBOX_COMMAND_TIMEOUT_SECONDS', 30, 1, 120) * 1000,
    maxOutput: number('SANDBOX_MAX_OUTPUT_BYTES', 16000, 1024, 100000),
    maxContainers: number('SANDBOX_MAX_CONTAINERS', 4, 1, 100),
    root: expandPath(process.env.SANDBOX_ROOT || './sandboxes'),
    rootView: process.env.SANDBOX_ROOT_VIEW ? expandPath(process.env.SANDBOX_ROOT_VIEW) : undefined,
    allowSoftQuota: flag('SANDBOX_ALLOW_SOFT_QUOTA'),
  },
};
if (!/^[a-z0-9-]{1,32}$/.test(config.sandbox.instance)) throw new Error('SANDBOX_INSTANCE must be 1-32 lowercase letters, numbers or hyphens');
