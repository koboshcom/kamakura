import type { ParsedReply } from './reply.js';
import type { IncomingMessage, Transport } from './types.js';

export async function deliverReply(reply: ParsedReply, incoming: IncomingMessage, transport: Transport,
  current: () => boolean, record: (text: string) => void, delayMs: number,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<void> {
  for (const [index, text] of reply.messages.entries()) {
    if (!current()) return;
    if (index) {
      await pause(delayMs);
      if (!current()) return;
    }
    await transport.send(incoming.chatId, text);
    record(text);
  }
}
