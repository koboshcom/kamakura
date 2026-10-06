import pLimit from 'p-limit';
import { think, reminders } from './brain.js';
import { prepareMedia } from './media.js';
import { config } from './config.js';
import { HistoryStore } from './history.js';
import { errorType, logger } from './logger.js';
import { parseReply } from './reply.js';
import { chatKey, type IncomingMessage, type Transport } from './types.js';
import { IMessageTransport } from './transports/imessage.js';
import { BridgeTransport } from './transports/bridge.js';
import { WhatsAppTransport } from './transports/whatsapp.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const history = new HistoryStore(config.dataDir, config.historyLimit);
const limit = pLimit(config.concurrency);
const pending = new Map<string, { timer: NodeJS.Timeout; last: IncomingMessage }>();
const busy = new Set<string>();
const transports = new Map<string, Transport>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function receive(message: IncomingMessage): void {
  const key = chatKey(message);
  history.add(key, { role: 'user', sender: message.sender, text: message.text.slice(0, config.maxInputChars), at: message.timestamp });
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    message.media = [...(existing.last.media ?? []), ...(message.media ?? [])].slice(0, 4);
  }
  pending.set(key, { last: message, timer: setTimeout(() => void flush(key), config.debounceMs) });
}

async function flush(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  // One reply at a time per chat; messages arriving meanwhile get a fresh debounce.
  if (busy.has(key)) {
    entry.timer = setTimeout(() => void flush(key), config.debounceMs);
    return;
  }
  pending.delete(key);
  busy.add(key);
  const message = entry.last;
  const transport = transports.get(message.transport)!;
  try {
    const raw = await limit(async () => {
      const media = message.media?.length ? await prepareMedia(message.media) : undefined;
      return think(history.get(key), message, media);
    });
    const reply = parseReply(raw, config.maxReplyMessages, config.maxReplyChars);
    if (reply.skip) return;
    if (reply.reaction && config.reactions && transport.react) await transport.react(message, reply.reaction);
    for (const [index, text] of reply.messages.entries()) {
      if (index) await sleep(config.messageDelayMs);
      await transport.send(message.chatId, text);
      history.add(key, { role: 'assistant', text, at: Date.now() });
    }
  } catch (error) {
    logger.error({ err: errorType(error), transport: message.transport }, 'reply failed');
  } finally {
    busy.delete(key);
  }
}

if (config.imessage) transports.set('imessage', config.imessageBridge ? new BridgeTransport() : new IMessageTransport());
if (config.whatsapp) transports.set('whatsapp', new WhatsAppTransport());
if (!transports.size) throw new Error('enable at least one transport');
for (const transport of transports.values()) await transport.start(receive);

reminders.start(async item => {
  const transport = transports.get(item.transport);
  if (!transport) throw new Error('transport unavailable');
  await transport.send(item.chat, item.text);
  history.add(`${item.transport}:${item.chat}`, { role: 'assistant', text: item.text, at: Date.now() });
});

const shutdown = async () => {
  reminders.stop();
  for (const transport of transports.values()) await transport.stop().catch(() => undefined);
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
logger.info({ transports: [...transports.keys()], model: config.model }, 'kamakura awake');
