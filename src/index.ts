import pLimit from 'p-limit';
import { think, reminders } from './brain.js';
import { prepareMedia } from './media.js';
import { config } from './config.js';
import { HistoryStore } from './history.js';
import { errorType, logger } from './logger.js';
import { parseReply } from './reply.js';
import { chatKey, type Transport } from './types.js';
import { TelegramTransport } from './transports/telegram.js';
import { sandboxes } from './sandbox.js';
import { startWorkers, stopWorkers } from './worker.js';
import { ReplyBatches } from './batching.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const history = new HistoryStore(config.dataDir, config.historyLimit);
const limit = pLimit(config.concurrency);
const transports = new Map<string, Transport>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const batches = new ReplyBatches(config.debounceMs, config.maxInputChars, async (message, current) => {
  const key = chatKey(message);
  const transport = transports.get(message.transport)!;
  const raw = await limit(async () => {
    if (!current()) return '<skip>';
    const media = message.media?.length ? await prepareMedia(message.media) : undefined;
    if (!current()) return '<skip>';
    return think(history.get(key), message, media);
  });
  // A new message during generation invalidates the old answer. Retry the whole
  // latest batch rather than sending a stale answer and a second correction.
  if (!current()) return;
  const reply = parseReply(raw, config.maxReplyMessages, config.maxReplyChars);
  if (reply.skip) return;
  if (reply.reaction && config.reactions && transport.react) await transport.react(message, reply.reaction);
  if (!current()) return;
  const text = reply.messages.join('\n\n').slice(0, 4000);
  if (text) {
    await transport.send(message.chatId, text);
    history.add(key, { role: 'assistant', text, at: Date.now() });
  }
}, message => {
  history.add(chatKey(message), { role: 'user', sender: message.sender, text: message.text, at: message.timestamp });
}, error => logger.error({ err: errorType(error) }, 'reply failed'));

transports.set('telegram', new TelegramTransport());
startWorkers(async (job, text) => {
  const transport = transports.get(job.incoming.transport);
  if (!transport) throw new Error('Worker transport unavailable');
  // Unlike short chat replies, retain long worker reports instead of slicing paragraphs.
  const cleaned = text.replace(/<react:[^>\n]*>|<skip>/gi, '').trim();
  const chunkSize = Math.max(config.maxReplyChars, 1200);
  const messages: string[] = [];
  for (let offset = 0; offset < cleaned.length; offset += chunkSize) messages.push(cleaned.slice(offset, offset + chunkSize));
  if (!messages.length) messages.push('the worker finished without a written result.');
  for (const [index, message] of messages.entries()) {
    if (index) await sleep(config.messageDelayMs);
    await transport.send(job.incoming.chatId, message);
    history.add(chatKey(job.incoming), { role: 'assistant', text: message, at: Date.now() });
  }
});
for (const transport of transports.values()) await transport.start(message => batches.receive(message));
sandboxes.start();

reminders.start(async item => {
  const transport = transports.get(item.transport);
  if (!transport) throw new Error('transport unavailable');
  await transport.send(item.chat, item.text);
  history.add(`${item.transport}:${item.chat}`, { role: 'assistant', text: item.text, at: Date.now() });
});

const shutdown = async () => {
  batches.stop();
  stopWorkers();
  reminders.stop();
  sandboxes.stop();
  for (const transport of transports.values()) await transport.stop().catch(() => undefined);
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
logger.info({ transports: [...transports.keys()], model: config.model }, 'kamakura awake');
