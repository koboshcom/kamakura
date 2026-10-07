import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from "baileys";
import { pino } from "pino";
import { collection, hash } from "../mongo.js";
import { redactCredentials } from "../credentials.js";
import { privateAuth } from "../whatsapp-auth.js";
import { whatsappConfig, type WhatsAppConfig } from "../whatsapp-config.js";
import type { IncomingMessage, Transport, MediaInput } from "../types.js";
export interface ClaimStore {
  claim(id: string): Promise<boolean>;
}
export class MongoWhatsAppClaims implements ClaimStore {
  constructor(private session: string) {}
  async claim(id: string) {
    try {
      await (
        await collection<{ _id: string; at: Date }>("whatsapp_claims")
      ).insertOne({ _id: hash(this.session + ":" + id), at: new Date() });
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }
}
export const reconnectDelay = (attempt: number) =>
  Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
export class WhatsAppTransport implements Transport {
  readonly name = "whatsapp" as const;
  private socket?: WASocket;
  private auth?: Awaited<ReturnType<typeof privateAuth>>;
  private stopped = true;
  private connected = false;
  private timer?: NodeJS.Timeout;
  private attempts = 0;
  private queue = Promise.resolve();
  private pending = 0;
  private destinations = new Map<string, string>();
  private accepted = new Map<string, WAMessageKey>();
  private closing?: Promise<void>;
  private quotes = new Map<string, { message: WAMessage; expires: number }>();
  private onMessage?: (m: IncomingMessage) => void;
  constructor(
    private cfg: WhatsAppConfig = whatsappConfig(),
    private store: ClaimStore = new MongoWhatsAppClaims(cfg.authDir),
    private factory: typeof makeWASocket = makeWASocket,
    private operatorEvent: (
      event: "auth-persistence-failed",
    ) => void = () => {},
  ) {}
  async start(onMessage: (m: IncomingMessage) => void) {
    if (!this.cfg.enabled) return;
    if (this.closing) await this.closing;
    if (!this.stopped) throw new Error("Already started");
    this.auth = await privateAuth(this.cfg.authDir, false, {
      onFatal: () => {
        try {
          this.operatorEvent("auth-persistence-failed");
        } catch {}
        void this.stop().catch(() => {});
      },
    });
    if (!this.auth.state.creds.registered) {
      await this.auth.close();
      this.auth = undefined;
      throw new Error("Explicit terminal pairing required");
    }

    this.stopped = false;
    this.onMessage = onMessage;
    try {
      this.connect();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private connect() {
    if (this.stopped || !this.auth) return;
    const socket = this.factory({
      auth: this.auth.state,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.socket = socket;
    socket.ev.on("creds.update", () => {
      if (this.stopped || this.socket !== socket) return;
      void this.auth?.saveCreds().catch(() => {
        void this.stop().catch(() => {});
      });
    });
    socket.ev.on("connection.update", (u) => {
      if (this.stopped || this.socket !== socket) return;
      if (u.qr) {
        void this.stop().catch(() => {});
        return;
      }
      if (u.connection === "open") {
        this.connected = true;
        this.attempts = 0;
      }
      if (u.connection === "close") {
        if (this.timer) return;
        this.connected = false;
        const code = (
          u.lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        if (
          code === DisconnectReason.loggedOut ||
          code === DisconnectReason.badSession ||
          ++this.attempts > 8
        ) {
          void this.stop().catch(() => {});
          return;
        }
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            try {
              this.connect();
            } catch {
              void this.stop().catch(() => {});
            }
          },
          reconnectDelay(this.attempts - 1),
        );
      }
    });
    socket.ev.on("messages.upsert", (event) => {
      if (event.type !== "notify" || this.socket !== socket) return;
      for (const msg of event.messages) {
        if (this.pending >= 32 || this.stopped) break;
        this.pending++;
        this.queue = this.queue
          .then(() => this.receive(msg, socket))
          .catch(() => {})
          .finally(() => {
            this.pending--;
          });
      }
    });
  }
  /** Trusted upstream WhatsApp envelope mapping via Baileys only, not independent cryptographic PN ownership proof. Message-body PN hints are ignored. */
  async receive(msg: WAMessage, socket: WASocket = this.socket!) {
    const current = () =>
      !this.stopped && (!this.socket || this.socket === socket);
    if (!current() || !socket || msg.key.fromMe || msg.key.participant) return;
    const remote = msg.key.remoteJid;
    if (!remote || !msg.key.id || !msg.message) return;
    let pn: string | null = remote.endsWith("@lid")
      ? await socket.signalRepository.lidMapping.getPNForLID(remote)
      : remote;
    if (!current() || !pn || !pn.endsWith("@s.whatsapp.net")) return;
    pn = jidNormalizedUser(pn);
    const owner = this.cfg.owners.get(pn);
    if (!owner) return;
    if (this.destinations.size >= 256 && !this.destinations.has(remote)) return;
    this.destinations.set(remote, pn);
    const timestamp = Number(msg.messageTimestamp) * 1000;
    if (
      !Number.isFinite(timestamp) ||
      Date.now() - timestamp > this.cfg.maxAgeMs ||
      timestamp > Date.now() + 30000
    )
      return;
    const m = msg.message; // No wrapper unwrapping: view-once, ephemeral and edits are deferred.
    const context =
      m.extendedTextMessage?.contextInfo ??
      m.imageMessage?.contextInfo ??
      m.audioMessage?.contextInfo ??
      m.videoMessage?.contextInfo;
    const text =
      m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      "";
    const attachment = m.imageMessage ?? m.audioMessage ?? m.videoMessage;
    const kind: MediaInput["kind"] | undefined = m.imageMessage
      ? "image"
      : m.audioMessage
        ? "audio"
        : m.videoMessage
          ? "video"
          : undefined;
    if (!text && !attachment) return;
    if (text.length > 8000) return;
    if (!current()) return;
    if (!(await this.store.claim(remote + ":" + msg.key.id)) || !current())
      return;
    const media: MediaInput[] = [];
    let suffix = "";
    if (attachment)
      suffix =
        " [Media inspection is disabled on this transport. No attachment was downloaded.]";
    if (!current()) return;
    const direct = Boolean(text && !attachment && !context);
    const id = msg.key.id;
    this.accepted.set(remote + ":" + id, { ...msg.key });
    for (const [key, entry] of this.quotes)
      if (entry.expires <= Date.now()) this.quotes.delete(key);
    this.quotes.set(remote + ":" + id, {
      message: {
        key: { ...msg.key },
        message: { conversation: redactCredentials(text).slice(0, 2000) },
        messageTimestamp: msg.messageTimestamp,
      },
      expires: Date.now() + 300000,
    });
    while (this.quotes.size > 256)
      this.quotes.delete(this.quotes.keys().next().value!);
    while (this.accepted.size > 256)
      this.accepted.delete(this.accepted.keys().next().value!);
    this.onMessage?.({
      transport: "whatsapp",
      chatId: remote,
      id,
      sender: owner,
      senderId: owner,
      isGroup: false,
      addressed: true,
      timestamp,
      text: (text || "[" + kind + " attachment]") + suffix,
      media,
      learningEligible: direct,
      credentialEligible: direct,
      ...(context?.stanzaId && context.quotedMessage
        ? {
            replyContext: {
              id: context.stanzaId.slice(0, 200),
              text: redactCredentials(
                context.quotedMessage.conversation ??
                  context.quotedMessage.extendedTextMessage?.text ??
                  "",
              ).slice(0, 2000),
            },
          }
        : {}),
    });
  }
  private destination(chat: string) {
    if (!/^[0-9]+(?::[0-9]+)?@(s[.]whatsapp[.]net|lid)$/.test(chat))
      throw new Error("Private destination required");
    if (
      this.stopped ||
      !this.connected ||
      !this.socket ||
      !this.cfg.owners.has(
        this.destinations.get(chat) ?? jidNormalizedUser(chat),
      )
    )
      throw new Error("WhatsApp destination unavailable");
    return this.socket;
  }
  async send(chat: string, text: string, options?: { replyTo?: string }) {
    const quoted = this.quote(chat, options?.replyTo);
    if (text.length > 16000) throw new Error("Outbound cap");
    const chunks = Array.from(
      { length: Math.ceil(text.length / 3500) },
      (_, i) => text.slice(i * 3500, (i + 1) * 3500),
    );
    for (const chunk of chunks)
      await this.destination(chat).sendMessage(
        chat,
        { text: chunk },
        quoted ? { quoted } : {},
      );
  }
  private quote(chat: string, id?: string) {
    if (!id) return;
    const entry = this.quotes.get(chat + ":" + id);
    if (!entry || entry.expires <= Date.now())
      throw new Error("Reply target unavailable");
    return entry.message;
  }
  async sendVoice(chat: string, audio: Buffer, options?: { replyTo?: string }) {
    const quoted = this.quote(chat, options?.replyTo);
    if (audio.length > this.cfg.maxMediaBytes) throw new Error("Audio cap");
    const ogg =
      audio.subarray(0, 4).toString() === "OggS" &&
      audio.includes(Buffer.from("OpusHead"));
    await this.destination(chat).sendMessage(
      chat,
      ogg
        ? { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }
        : {
            document: audio,
            mimetype: "application/octet-stream",
            fileName: "reply.audio",
          },
      quoted ? { quoted } : {},
    );
  }
  async react(m: IncomingMessage, emoji: string) {
    const key = this.accepted.get(m.chatId + ":" + m.id);
    if (!key || m.transport !== "whatsapp" || emoji.length > 16)
      throw new Error("Unaccepted reaction");
    await this.destination(m.chatId).sendMessage(m.chatId, {
      react: { key, text: emoji },
    });
  }
  startTyping(chat: string) {
    let done = false;
    void this.destination(chat)
      .sendPresenceUpdate("composing", chat)
      .catch(() => {});
    return () => {
      if (done) return;
      done = true;
      if (!this.stopped)
        void this.socket?.sendPresenceUpdate("paused", chat).catch(() => {});
    };
  }
  async stop() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    const auth = this.auth;
    this.auth = undefined;
    this.closing = (async () => {
      try {
        try {
          socket?.end(undefined);
          await this.queue;
        } finally {
          await auth?.close();
        }
      } finally {
        this.accepted.clear();
        this.quotes.clear();
        this.destinations.clear();
      }
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}
