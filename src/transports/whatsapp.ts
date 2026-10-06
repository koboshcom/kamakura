import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import { mkdirSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import { allowed, config } from '../config.js';
import { errorType, logger } from '../logger.js';
import type { IncomingMessage, Transport } from '../types.js';

type Socket = ReturnType<typeof makeWASocket>;

function textOf(message: WAMessage): string | undefined {
  const m = message.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? m?.videoMessage?.caption ?? undefined;
}

export class WhatsAppTransport implements Transport {
  readonly name = 'whatsapp' as const;
  private sock?: Socket;
  private stopping = false;
  private retryMs = 2000;

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    mkdirSync(config.authDir, { recursive: true, mode: 0o700 });
    await this.connect(onMessage);
  }

  private async connect(onMessage: (message: IncomingMessage) => void): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.macOS('Desktop'),
      logger: logger.child({ module: 'baileys' }, { level: 'warn' }) as never,
      markOnlineOnConnect: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) qrcode.generate(qr, { small: true });
      if (connection === 'open') {
        this.retryMs = 2000;
        logger.info('whatsapp connected');
      }
      if (connection === 'close' && !this.stopping) {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error(`whatsapp logged out; delete ${config.authDir} and scan again`);
          return;
        }
        const wait = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 60000);
        setTimeout(() => this.connect(onMessage).catch(e => logger.error({ err: errorType(e) }, 'reconnect failed')), wait);
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        const chatId = message.key.remoteJid;
        const text = textOf(message)?.trim();
        if (!chatId || message.key.fromMe || chatId === 'status@broadcast' || !text) continue;
        if (!allowed(config.whatsappAllowed, chatId)) {
          logger.info({ chatId }, 'ignored chat not on allowlist');
          continue;
        }
        const group = Boolean(isJidGroup(chatId));
        onMessage({
          transport: 'whatsapp',
          chatId,
          id: message.key.id ?? '',
          sender: message.pushName || message.key.participant || chatId,
          text,
          isGroup: group,
          timestamp: Number(message.messageTimestamp ?? 0) * 1000,
          reactionKey: message.key,
        });
      }
    });
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('whatsapp not connected');
    await this.sock.sendMessage(chatId, { text });
  }

  async react(message: IncomingMessage, emoji: string): Promise<void> {
    if (!this.sock || !message.reactionKey) return;
    await this.sock.sendMessage(message.chatId, { react: { text: emoji, key: message.reactionKey as WAMessageKey } });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}
