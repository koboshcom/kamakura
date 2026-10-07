import type { Message } from 'grammy/types';
import { config } from './config.js';

// Only unforwarded direct messages from the owner can control local pairing.
// Quoted commands, channel posts, groups and model-generated messages never qualify.
export function trustedLocalOwner(message: Message): string | undefined {
  const from = message.from;
  if (!from || from.is_bot || message.sender_chat || message.chat.type !== 'private'
    || String(message.chat.id) !== String(from.id) || message.forward_origin || message.via_bot
    || message.quote || message.external_reply) return;
  const owner = String(from.id);
  return config.telegramAllowed.has(owner) && config.sandbox.allowed.has(owner) ? owner : undefined;
}
