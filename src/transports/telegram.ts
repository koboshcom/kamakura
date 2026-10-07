import { telegramText, entityParseFailure } from '../telegram-format.js';
import { captureCredentials, redactCredentials } from '../credentials.js';
import { InputFile, InlineKeyboard } from 'grammy';
import { trustedLocalOwner } from '../local-device-telegram.js';
import { localDevices } from '../local-device-service.js';
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
    localDevices?.setApprovalNotifier(async (owner, request) => {
      await this.bot.api.sendMessage(owner,
        `Local device action approval\nDevice ${request.deviceId}\nAction ${request.action}\n${request.preview}\nRequest ${request.digest}\nApprove only if this exact action is yours.`,
        { reply_markup: new InlineKeyboard().text('Approve once', `local:yes:${request.approvalId}`).text('Deny', `local:no:${request.approvalId}`), link_preview_options: { is_disabled: true } });
    });
    this.bot.on('callback_query:data', async ctx => {
      const match = /^local:(yes|no):([a-f0-9-]{16,64})$/.exec(ctx.callbackQuery.data);
      const message = ctx.callbackQuery.message;
      const owner = String(ctx.from.id);
      const trusted = Boolean(message && message.chat.type === 'private' && String(message.chat.id) === owner
        && message.from?.id === this.bot.botInfo.id && config.telegramAllowed.has(owner) && config.sandbox.allowed.has(owner));
      const accepted = trusted && match && localDevices ? await localDevices.approve(owner, match[2]!, match[1] === 'yes') : false;
      await ctx.answerCallbackQuery({ text: accepted ? 'Recorded for this action only.' : 'Unavailable, expired or unauthorized.' });
      if (accepted) await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    });
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
      const localCommand = /^\/(pair|devices|revoke)(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/i.exec(text.trim());
      if (localCommand) {
        const owner = trustedLocalOwner(message);
        if (!owner) return;
        if (!localDevices) { await ctx.reply('Local devices are not enabled.'); return; }
        const command = localCommand[1]!.toLowerCase();
        try {
          if (command === 'pair') {
            if (localCommand[2]) { await ctx.reply('Use /pair without arguments.'); return; }
            const pairing = await localDevices.issuePairCode(owner);
            await ctx.reply(`One-time local device pairing code\n${pairing.code}\nExpires ${new Date(pairing.expiresAt).toISOString()}\nRun kama auth on your own computer. Never enter this code into a website or send it to anyone.${config.localDevices.publicUrl ? `\nKAMA_CORE_URL=${config.localDevices.publicUrl}` : '\nThe operator must configure the public WSS connector URL.'}`, { protect_content: true, link_preview_options: { is_disabled: true } });
          } else if (command === 'devices') {
            const devices = await localDevices.list(owner);
            await ctx.reply(devices.length ? devices.map(device => `${device.deviceId} ${device.name} ${device.connected ? 'connected' : 'offline'} ${device.paused ? 'paused' : 'ready'}`).join('\n') : 'No paired local devices.');
          } else {
            const id = localCommand[2]?.trim() ?? '';
            if (!/^[a-f0-9-]{16,64}$/.test(id)) { await ctx.reply('Use /revoke with a device ID from /devices.'); return; }
            await localDevices.revoke(owner, id);
            await ctx.reply('Device revoked. Any active connection and pending actions are stopped.');
          }
        } catch (error) { logger.warn({err:errorType(error)}, 'Local device control denied'); await ctx.reply('Local device command unavailable.'); }
        return;
      }
      captureCredentials(text);
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
      onMessage({ transport: 'telegram', chatId, id: String(message.message_id),
        ...(message.reply_to_message ? {replyContext:{id:String(message.reply_to_message.message_id),text:redactCredentials(message.reply_to_message.text??message.reply_to_message.caption??'').slice(0,2000),senderId:message.reply_to_message.from?String(message.reply_to_message.from.id):undefined}}:{}), senderId: String(message.from.id),
        sender: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        text: (text || `[${kind} attachment]`) + attachmentError, media, isGroup, addressed,
        credentialEligible: Boolean(config.sandbox.allowed.has(String(message.from.id)) && !message.forward_origin && !message.quote && !message.external_reply && !message.via_bot && !kind && !message.entities?.some(entity => entity.type === 'blockquote' || entity.type === 'expandable_blockquote')),
        learningEligible: Boolean(message.text && !message.forward_origin && !message.quote && !message.external_reply && !kind && !message.via_bot && !message.entities?.some(entity => entity.type === 'blockquote' || entity.type === 'expandable_blockquote' || entity.type === 'pre' || entity.type === 'code')),
        timestamp: message.date * 1000 });
    });
    this.bot.catch(error => logger.error({ err: errorType(error.error) }, 'Telegram update failed'));
    // start() resolves when polling stops, so do not await it during initialization.
    void this.bot.start({ allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }).catch(error => {
      logger.fatal({ err: errorType(error) }, 'Telegram polling stopped');
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
  }
  async send(chatId: string, text: string, options?: {replyTo?:string}): Promise<void> {
    const rendered = telegramText(text);
    try {
      await this.bot.api.sendMessage(chatId, rendered.text, { entities: rendered.entities, ...(options?.replyTo ? {reply_parameters:{message_id:Number(options.replyTo),allow_sending_without_reply:false}}:{}), link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (!entityParseFailure(error)) throw error;
      await this.bot.api.sendMessage(chatId, rendered.plain, { ...(options?.replyTo ? {reply_parameters:{message_id:Number(options.replyTo),allow_sending_without_reply:false}}:{}), link_preview_options: { is_disabled: true } });
    }
  }
  async sendVoice(chatId:string,audio:Buffer,options?:{replyTo?:string}):Promise<void>{
    await this.bot.api.sendVoice(chatId,new InputFile(audio,'reply.ogg'),options?.replyTo?{reply_parameters:{message_id:Number(options.replyTo),allow_sending_without_reply:false}}:{});
  }
  async react(message: IncomingMessage, emoji: string): Promise<void> {
    // Telegram can reject a valid emoji if chat reactions are disabled; text still sends.
    await this.bot.api.setMessageReaction(message.chatId, Number(message.id), [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]);
  }
  startTyping(chatId: string): () => void { return this.typing.start(chatId); }
  async stop(): Promise<void> { this.typing.stop(); if (this.bot.isRunning()) await this.bot.stop(); }
}
