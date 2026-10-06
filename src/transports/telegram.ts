import { Bot } from 'grammy';
import { TypingActivity } from '../typing.js';
import type { Message, ReactionTypeEmoji } from 'grammy/types';
import { config, allowed } from '../config.js';
import { logger, errorType } from '../logger.js';
import type { IncomingMessage, MediaInput, Transport } from '../types.js';

export function isAddressed(message: Message, botId: number, username: string): boolean {
  if (message.reply_to_message?.from?.id === botId) return true;
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  return entities.some(e => (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`)
    || (e.type === 'text_mention' && e.user.id === botId)
    || (e.type === 'bot_command' && text.slice(e.offset, e.offset + e.length).toLowerCase().endsWith(`@${username.toLowerCase()}`)));
}

export class TelegramTransport implements Transport {
  private readonly token: string;
  readonly name = 'telegram' as const;
  readonly bot: Bot;
  private readonly typing: TypingActivity;
  constructor(token = config.telegramToken) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.token = token;
    this.bot = new Bot(token);
    this.typing = new TypingActivity((chatId, signal) => this.bot.api.sendChatAction(chatId, 'typing', {},
      signal as unknown as Parameters<typeof this.bot.api.sendChatAction>[3]));
  }
  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    await this.bot.init();
    this.bot.on('message', async ctx => {
      const message = ctx.message;
      // Only real user IDs can own workspaces. Anonymous admins/channel posts are ignored.
      if (!message.from || message.from.is_bot || message.sender_chat) return;
      const chatId = String(message.chat.id);
      if (!allowed(config.telegramAllowed, chatId)) return;
      const isGroup = message.chat.type !== 'private';
      const addressed = !isGroup || isAddressed(message, this.bot.botInfo.id, this.bot.botInfo.username);
      if (isGroup && config.groupMode === 'mentions' && !addressed) return;
      const text = message.text ?? message.caption ?? '';
      const media: MediaInput[] = [];
      const photo = message.photo?.at(-1);
      const file = photo ?? message.voice ?? message.audio ?? message.video ?? message.video_note ?? message.animation ?? message.document;
      let kind: MediaInput['kind'] | undefined;
      let mime = 'application/octet-stream';
      if (photo) { kind = 'image'; mime = 'image/jpeg'; }
      else if (message.voice || message.audio) { kind = 'audio'; mime = message.voice?.mime_type ?? message.audio?.mime_type ?? 'audio/ogg'; }
      else if (message.video || message.video_note || message.animation) { kind = 'video'; mime = message.video?.mime_type ?? message.animation?.mime_type ?? 'video/mp4'; }
      else if (message.document) {
        mime = message.document.mime_type ?? 'application/octet-stream';
        if (mime.startsWith('image/') || /\.hei[cf]$/i.test(message.document.file_name ?? '')) kind = 'image';
        else if (mime.startsWith('audio/')) kind = 'audio';
        else if (mime.startsWith('video/')) kind = 'video';
      }
      if (!text && !kind) return;
      let attachmentError = '';
      if (file && kind) {
        try {
          if ((file.file_size ?? 0) > config.maxMediaBytes) throw new Error('Attachment too large');
          const remote = await this.bot.api.getFile(file.file_id);
          if (!remote.file_path || (remote.file_size ?? 0) > config.maxMediaBytes) throw new Error('Attachment unavailable');
          const url = new URL(`https://api.telegram.org/file/bot${this.token}/${remote.file_path}`);
          const response = await fetch(url, { signal: AbortSignal.timeout(config.mediaTimeoutMs), redirect: 'error' });
          if (!response.ok || !response.body) throw new Error('Attachment download failed');
          const chunks: Buffer[] = [];
          let bytes = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > config.maxMediaBytes) { await reader.cancel(); throw new Error('Attachment too large'); }
              chunks.push(Buffer.from(value));
            }
          } finally { reader.releaseLock(); }
          media.push({ kind, mime, data: Buffer.concat(chunks) });
        } catch (error) {
          logger.warn({ err: errorType(error) }, 'Telegram attachment unavailable');
          attachmentError = '\n[Attachment unavailable or over the download limit. Do not pretend to have seen or heard it.]';
        }
      }
      onMessage({ transport: 'telegram', chatId, id: String(message.message_id), senderId: String(message.from.id),
        sender: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        text: (text || `[${kind} attachment]`) + attachmentError, media, isGroup, addressed, timestamp: message.date * 1000 });
    });
    this.bot.catch(error => logger.error({ err: errorType(error.error) }, 'Telegram update failed'));
    // start() resolves when polling stops, so do not await it during initialization.
    void this.bot.start({ allowed_updates: ['message'], drop_pending_updates: true }).catch(error => {
      logger.fatal({ err: errorType(error) }, 'Telegram polling stopped');
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
  }
  async send(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  }
  async react(message: IncomingMessage, emoji: string): Promise<void> {
    // Telegram can reject a valid emoji if chat reactions are disabled; text still sends.
    try { await this.bot.api.setMessageReaction(message.chatId, Number(message.id), [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]); }
    catch (error) { logger.warn({ err: errorType(error) }, 'Telegram reaction unavailable'); }
  }
  startTyping(chatId: string): () => void { return this.typing.start(chatId); }
  async stop(): Promise<void> { this.typing.stop(); if (this.bot.isRunning()) await this.bot.stop(); }
}
