import makeWASocket, { DisconnectReason } from "baileys";
import { pino } from "pino";
import qr from "qrcode-terminal";
import { privateAuth } from "./whatsapp-auth.js";
import { pathToFileURL } from "node:url";
import { whatsappConfig } from "./whatsapp-config.js";
// Explicit local terminal command only. No QR is ever emitted by runtime startup.
export async function pair(
  options: {
    interactive?: boolean;
    factory?: typeof makeWASocket;
    auth?: Awaited<ReturnType<typeof privateAuth>>;
    authFactory?: typeof privateAuth;
    renderQR?: (value: string) => void;
  } = {},
) {
  if (!(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)))
    throw new Error("Interactive terminal required");
  const cfg = whatsappConfig();
  if (!cfg.enabled) throw new Error("Enable WhatsApp explicitly");

  let socket: ReturnType<typeof makeWASocket> | undefined;
  let ended = false;
  let restarts = 0;
  let settled = false;
  let settle!: (e?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (e) => {
      if (settled) return;
      settled = true;
      if (e) reject(e);
      else resolve();
    };
  });
  const fatal = () => settle(new Error("Pairing auth persistence failed"));
  const auth =
    options.auth ??
    (await (options.authFactory ?? privateAuth)(cfg.authDir, true, {
      onFatal: fatal,
    }));
  const unsubscribe = auth.subscribeFatal?.(fatal);
  const connect = () => {
    const current = (options.factory ?? makeWASocket)({
      auth: auth.state,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    });
    socket = current;
    current.ev.on("creds.update", () => {
      if (ended || socket !== current) return;
      void auth.saveCreds().catch(() => settle(new Error("Auth save failed")));
    });
    current.ev.on("connection.update", (u) => {
      if (ended || settled || socket !== current) return;
      if (u.qr) {
        if (options.renderQR) options.renderQR(u.qr);
        else qr.generate(u.qr, { small: true });
      }
      if (u.connection === "open") settle();
      if (u.connection === "close") {
        const code = (
          u.lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        if (code === DisconnectReason.restartRequired && restarts++ < 2) {
          try {
            connect();
          } catch {
            settle(new Error("Pairing construction failed"));
          }
        } else settle(new Error("Pairing connection closed"));
      }
    });
  };
  const stop = () => settle(new Error("Pairing cancelled"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(stop, 180000);
  try {
    try {
      connect();
    } catch {
      settle(new Error("Pairing construction failed"));
    }
    await done;
    await auth.saveCreds();
  } finally {
    ended = true;
    unsubscribe?.();
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      socket?.end(undefined);
    } finally {
      try {
        await auth.close();
      } catch {
        throw new Error("Pairing auth cleanup failed");
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void pair().catch(() => {
    process.stderr.write(
      "WhatsApp pairing failed. Check private volume and authorization configuration.",
    );
    process.exitCode = 1;
  });
