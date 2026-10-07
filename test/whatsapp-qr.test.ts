import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateAuth } from "../src/whatsapp-auth.js";
import { whatsappConfig } from "../src/whatsapp-config.js";
import {
  WhatsAppTransport,
  reconnectDelay,
} from "../src/transports/whatsapp.js";
const env = {
  WHATSAPP_ENABLED: "true",
  WHATSAPP_AUTH_DIR: "/run/private/wa",
  WHATSAPP_OWNER_NUMBERS:
    "{" +
    String.fromCharCode(34) +
    "+15551234567" +
    String.fromCharCode(34) +
    ":" +
    String.fromCharCode(34) +
    "6612253937" +
    String.fromCharCode(34) +
    "}",
  WHATSAPP_ALLOWED_NUMBERS: "+15551234567",
  SANDBOX_ALLOWED_USERS: "6612253937",
};
test("disabled requires no credentials and strict owner authorization", () => {
  assert.equal(whatsappConfig({}).enabled, false);
  assert.equal(whatsappConfig(env).owners.size, 1);
  assert.equal(whatsappConfig(env).lidBindings.size, 0);
  assert.equal(whatsappConfig({...env,WHATSAPP_LID_BINDINGS:'{"123@lid":"+15551234567"}'}).lidBindings.get('123@lid'),'15551234567@s.whatsapp.net');
  for (const change of [
    { WHATSAPP_LID_BINDINGS: '{"123@lid":"+15559876543"}' },
    { WHATSAPP_LID_BINDINGS: '{"123@lid":"15551234567@s.whatsapp.net"}' },
    { WHATSAPP_LID_BINDINGS: '{"123@g.us":"+15551234567"}' },
    { WHATSAPP_LID_BINDINGS: '[]' },
    { WHATSAPP_LID_BINDINGS: '{"123@lid":6612253937}' },
    { SANDBOX_ALLOWED_USERS: "*" },
    { WHATSAPP_ALLOWED_NUMBERS: "*" },
    { WHATSAPP_OWNER_NUMBERS: '{"+15551234567":"123"}' },
    { WHATSAPP_AUTH_DIR: process.cwd() + "/data" },
  ])
    assert.throws(() => whatsappConfig({ ...env, ...change }));
});
test("auth atomic private buffers, app state, restart, lock, symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-auth-"));
  const dir = join(root, "secret");
  try {
    let auth = await privateAuth(dir, true);
    await assert.rejects(privateAuth(dir, true));
    await auth.state.keys.set({
      session: { abc: Buffer.from("secret") },
      "app-state-sync-key": { abc: { keyData: Buffer.from("abc") } },
    });
    auth.state.creds.registered = true;
    await Promise.all([auth.saveCreds(), auth.saveCreds()]);
    assert.equal((await stat(dir)).mode & 511, 448);
    assert.equal((await stat(join(dir, "state.json"))).mode & 511, 384);
    await auth.close();
    auth = await privateAuth(dir);
    assert.deepEqual(
      (await auth.state.keys.get("session", ["abc"])).abc,
      Buffer.from("secret"),
    );
    assert.deepEqual(
      Buffer.from(
        (await auth.state.keys.get("app-state-sync-key", ["abc"])).abc!
          .keyData!,
      ),
      Buffer.from("abc"),
    );
    await auth.close();
    await symlink(dir, join(root, "link"));
    await assert.rejects(privateAuth(join(root, "link")));
    assert.ok(
      (await readFile(join(dir, "state.json"), "utf8")).includes("creds"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("authorization precedes claims, forwards provenance, stale history, duplicates and Mongo fail closed", async () => {
  const cfg = whatsappConfig(env);
  const seen = new Set<string>();
  let claims = 0;
  const received: any[] = [];
  const transport: any = new WhatsAppTransport(cfg, {
    claim: async (id) => {
      claims++;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
  });
  transport.stopped = false;
  transport.onMessage = (m: any) => received.push(m);
  const socket: any = {
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
  };
  const msg: any = {
    key: { remoteJid: "15551234567@s.whatsapp.net", id: "1" },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  for (const key of [
    { remoteJid: "other@g.us" },
    { remoteJid: "status@broadcast" },
    { remoteJid: "123@lid" },
    { remoteJid: "19999999999@s.whatsapp.net" },
    { fromMe: true },
    { participant: "15551234567@s.whatsapp.net" },
  ])
    await transport.receive({ ...msg, key: { ...msg.key, ...key } }, socket);
  assert.equal(claims, 0);
  await transport.receive({ ...msg, messageTimestamp: 1 }, socket);
  assert.equal(claims, 0);
  await transport.receive(msg, socket);
  await transport.receive(msg, socket);
  assert.equal(received.length, 1);
  assert.equal(received[0].senderId, "6612253937");
  assert.equal(received[0].credentialEligible, true);
  await transport.receive(
    {
      ...msg,
      key: { ...msg.key, id: "2" },
      message: {
        extendedTextMessage: {
          text: "forward",
          contextInfo: { isForwarded: true },
        },
      },
    },
    socket,
  );
  assert.equal(received[1].learningEligible, false);
  transport.store = {
    claim: async () => {
      throw new Error("offline");
    },
  };
  await assert.rejects(
    transport.receive({ ...msg, key: { ...msg.key, id: "3" } }, socket),
  );
  assert.equal(received.length, 2);
  transport.stopped = true;
  await transport.receive(msg, socket);
  assert.equal(received.length, 2);
});
test("capped reconnect, chunks sequential, uncertain sends never retried", async () => {
  assert.equal(reconnectDelay(100), 30000);
  const cfg = whatsappConfig(env);
  const t: any = new WhatsAppTransport(cfg);
  t.stopped = false;
  t.connected = true;
  t.destinations.set("15551234567@s.whatsapp.net","15551234567@s.whatsapp.net");
  let calls = 0;
  t.socket = {
    sendMessage: async () => {
      calls++;
      throw new Error("uncertain");
    },
  };
  await assert.rejects(t.send("15551234567@s.whatsapp.net", "a".repeat(7000)));
  assert.equal(calls, 1);
  await assert.rejects(t.send("stranger@s.whatsapp.net", "hi"));
  await assert.rejects(
    t.react(
      { transport: "whatsapp", chatId: "15551234567@s.whatsapp.net", id: "x" },
      "x",
    ),
  );
});
test("oversized media rejected before download and never trusted", async () => {
  const t: any = new WhatsAppTransport(whatsappConfig(env), {
    claim: async () => true,
  });
  const got: any[] = [];
  t.stopped = false;
  t.onMessage = (m: any) => got.push(m);
  await t.receive(
    {
      key: { remoteJid: "15551234567@s.whatsapp.net", id: "media" },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        imageMessage: {
          fileLength: 20971521,
          directPath: "/invalid",
          caption: "photo",
        },
      },
    },
    {} as any,
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].media.length, 0);
  assert.equal(got[0].learningEligible, false);
  assert.match(got[0].text, /disabled/);
});

test("quoted replies redact cached text, expire, and reject group destinations", async () => {
  const t: any = new WhatsAppTransport(whatsappConfig(env), {
    claim: async () => true,
  });
  t.stopped = false;
  t.connected = true;
  const sent: any[] = [];
  t.socket = { sendMessage: async (...args: any[]) => sent.push(args) };
  await t.receive(
    {
      key: { remoteJid: "15551234567@s.whatsapp.net", id: "q" },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: "password=abcdefghi" },
    },
    t.socket,
  );
  await t.send("15551234567@s.whatsapp.net", "answer", { replyTo: "q" });
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0][2]).includes("abcdefghi"));
  await assert.rejects(t.send("15551234567@g.us", "hi"));
  t.quotes.get("15551234567@s.whatsapp.net:q").expires = 0;
  await assert.rejects(
    t.send("15551234567@s.whatsapp.net", "late", { replyTo: "q" }),
  );
});
test("concurrent stop closes auth once and failed factory releases lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-life-"));
  const dir = join(root, "secret");
  try {
    const a = await privateAuth(dir, true);
    a.state.creds.registered = true;
    await a.saveCreds();
    await Promise.all([a.close(), a.close()]);
    const cfg = { ...whatsappConfig(env), authDir: dir };
    const t = new WhatsAppTransport(cfg, undefined, (() => {
      throw new Error("factory failure");
    }) as any);
    await assert.rejects(t.start(() => {}));
    const again = await privateAuth(dir);
    await again.close();
    const fake: any = new WhatsAppTransport(cfg);
    let closes = 0;
    fake.auth = {
      close: async () => {
        closes++;
      },
    };
    await Promise.all([fake.stop(), fake.stop()]);
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mock socket reconnect eight retries, duplicate close and stale creds", async (c) => {
  c.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: any[] = [];
  let saves = 0,
    closes = 0;
  const factory: any = () => {
    const handlers = new Map();
    const socket = {
      ev: { on: (k: any, v: any) => handlers.set(k, v) },
      emit: (k: any, v: any) => handlers.get(k)?.(v),
      end: () => {},
    };
    sockets.push(socket);
    return socket;
  };
  const t: any = new WhatsAppTransport(whatsappConfig(env), undefined, factory);
  t.stopped = false;
  t.auth = {
    state: {},
    saveCreds: async () => {
      saves++;
    },
    close: async () => {
      closes++;
    },
  };
  t.connect();
  sockets[0].emit("connection.update", { connection: "close" });
  sockets[0].emit("connection.update", { connection: "close" });
  assert.equal(t.attempts, 1);
  c.mock.timers.tick(1000);
  sockets[0].emit("creds.update", {});
  assert.equal(saves, 0);
  sockets.at(-1).emit("connection.update", { connection: "open" });
  assert.equal(t.attempts, 0);
  for (let n = 0; n < 8; n++) {
    sockets.at(-1).emit("connection.update", { connection: "close" });
    c.mock.timers.tick(reconnectDelay(n));
  }
  assert.equal(t.attempts, 8);
  assert.equal(sockets.length, 10);
  sockets.at(-1).emit("connection.update", { connection: "close" });
  await t.stop();
  assert.equal(closes, 1);
  c.mock.timers.tick(30000);
  assert.equal(sockets.length, 10);
});

test("media is explicitly deferred without invoking network", async () => {
  const tr: any = new WhatsAppTransport(whatsappConfig(env), {
    claim: async () => true,
  });
  tr.stopped = false;
  const got: any[] = [];
  tr.onMessage = (m: any) => got.push(m);
  await tr.receive(
    {
      key: { remoteJid: "15551234567@s.whatsapp.net", id: "disabled" },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { imageMessage: { fileLength: 10, directPath: "/remote" } },
    },
    {},
  );
  assert.equal(got[0].media.length, 0);
  assert.match(got[0].text, /disabled/);
  assert.equal(got[0].credentialEligible, false);
  await tr.stop();
});
test("signal key write fsync rename failures trigger one fatal event and require restart", async () => {
  for (const stage of ["write", "fsync", "rename"] as const) {
    const root = await mkdtemp(join(tmpdir(), "wa-fault-"));
    const dir = join(root, "private");
    try {
      const first = await privateAuth(dir, true);
      await first.state.keys.set({ session: { old: Buffer.from("durable") } });
      await first.close();
      let fatal = 0;
      const auth = await privateAuth(dir, false, {
        onFatal: () => {
          fatal++;
        },
        fault: (current) => {
          if (current === stage) throw new Error("secret disk failure");
        },
      });
      await assert.rejects(
        auth.state.keys.set({ session: { new: Buffer.from("mutated") } }),
      );
      assert.equal(fatal, 1);
      await assert.rejects(auth.saveCreds());
      await assert.rejects(auth.state.keys.get("session", ["new"]));
      await Promise.allSettled([auth.close(), auth.close()]);
      assert.equal(
        (await (await import("node:fs/promises")).readdir(dir)).filter((name) =>
          name.startsWith(".state-"),
        ).length,
        0,
      );
      const restarted = await privateAuth(dir);
      assert.deepEqual(
        (await restarted.state.keys.get("session", ["old"])).old,
        Buffer.from("durable"),
      );
      assert.equal(
        (await restarted.state.keys.get("session", ["new"])).new,
        undefined,
      );
      await restarted.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
test("auth cleanup survives socket end throw and queue rejection", async () => {
  for (const mode of ["socket", "queue"]) {
    const tr: any = new WhatsAppTransport(whatsappConfig(env));
    let closes = 0;
    tr.auth = {
      close: async () => {
        closes++;
      },
    };
    if (mode === "socket")
      tr.socket = {
        end: () => {
          throw new Error("socket end");
        },
      };
    else {
      tr.queue = Promise.reject(new Error("queue failure"));
      tr.queue.catch(() => {});
    }
    await assert.rejects(tr.stop());
    assert.equal(closes, 1);
    assert.equal(tr.auth, undefined);
  }
});
test("all supported inbound media never fetch and captions stay untrusted", async (c) => {
  let fetched = 0;
  c.mock.method(globalThis, "fetch", async () => {
    fetched++;
    throw new Error("network forbidden");
  });
  const tr: any = new WhatsAppTransport(whatsappConfig(env), {
    claim: async () => true,
  });
  tr.stopped = false;
  const got: any[] = [];
  tr.onMessage = (m: any) => got.push(m);
  for (const field of ["imageMessage", "audioMessage", "videoMessage"]) {
    for (const caption of [undefined, "caption password=example"]) {
      await tr.receive(
        {
          key: {
            remoteJid: "15551234567@s.whatsapp.net",
            id: field + String(caption),
          },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: {
            [field]: {
              fileLength: 10,
              directPath: "/remote",
              url: "https://example.com/remote",
              caption,
            },
          },
        },
        {},
      );
    }
  }
  assert.equal(fetched, 0);
  assert.equal(got.length, 6);
  for (const m of got) {
    assert.match(m.text, /No attachment was downloaded/);
    assert.equal(m.learningEligible, false);
    assert.equal(m.credentialEligible, false);
    assert.equal(m.media.length, 0);
  }
  await tr.stop();
});
test("group writable and service-owned sticky ancestors are rejected", async () => {
  const { chmod } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "wa-chain-"));
  try {
    await chmod(root, 0o770);
    await assert.rejects(
      privateAuth(join(root, "secret"), true),
      /Untrusted auth ancestor/,
    );
    await chmod(root, 0o1777);
    await assert.rejects(
      privateAuth(join(root, "secret"), true),
      /Untrusted auth ancestor/,
    );
    await chmod(root, 0o700);
    const auth = await privateAuth(join(root, "secret"), true);
    await auth.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("pairing initial/restart construction and end failures always close auth", async () => {
  const { pair } = await import("../src/whatsapp-pair.js");
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    for (const mode of ["initial", "restart", "end", "concurrent"]) {
      let closes = 0,
        calls = 0;
      const auth: any = {
        state: {},
        saveCreds: async () => {},
        close: async () => {
          closes++;
        },
      };
      const factory: any = () => {
        calls++;
        if (mode === "initial" || (mode === "restart" && calls === 2))
          throw new Error("factory");
        const handlers = new Map();
        const socket: any = {
          ev: { on: (k: any, v: any) => handlers.set(k, v) },
          end: () => {
            if (mode === "end") throw new Error("end");
          },
        };
        setImmediate(() => {
          if (mode === "restart")
            handlers.get("connection.update")({
              connection: "close",
              lastDisconnect: { error: { output: { statusCode: 515 } } },
            });
          else {
            handlers.get("connection.update")({ connection: "open" });
            handlers.get("connection.update")({ connection: "close" });
          }
        });
        return socket;
      };
      const task = pair({
        interactive: true,
        auth,
        factory,
        renderQR: () => {},
      });
      if (mode === "concurrent") await task;
      else await assert.rejects(task);
      assert.equal(closes, 1);
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
test("inflight PN and operator-bound LID claims are rejected after socket replacement", async () => {
  for (const mode of ["claim", "lid"]) {
    let release: any;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let claims = 0;
    const tr: any = new WhatsAppTransport(whatsappConfig(env), {
      claim: async () => {
        claims++;
        await held;
        return true;
      },
    });
    if(mode === "lid")tr.cfg.lidBindings.set("999@lid","15551234567@s.whatsapp.net");
    const original: any = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => {
            await held;
            return "15551234567@s.whatsapp.net";
          },
        },
      },
      end: () => {},
    };
    tr.socket = original;
    tr.stopped = false;
    let delivered = 0;
    tr.onMessage = () => {
      delivered++;
    };
    const receive = tr.receive(
      {
        key: {
          remoteJid: mode === "lid" ? "999@lid" : "15551234567@s.whatsapp.net",
          id: mode,
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "hello" },
      },
      original,
    );
    await new Promise((resolve) => setImmediate(resolve));
    tr.socket = { end: () => {} };
    release();
    await receive;
    assert.equal(delivered, 0);
    assert.equal(claims, 1);
    await tr.stop();
  }
});
test("voice disabled, text quotes are chat bound and reply cache capped", async () => {
  const tr: any = new WhatsAppTransport(whatsappConfig(env), {
    claim: async () => true,
  });
  tr.stopped = false;
  tr.connected = true;
  const sent: any[] = [];
  tr.socket = {
    end: () => {},
    sendMessage: async (...args: any[]) => sent.push(args),
  };
  for (let n = 0; n < 257; n++)
    await tr.receive(
      {
        key: { remoteJid: "15551234567@s.whatsapp.net", id: String(n) },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "text" },
      },
      tr.socket,
    );
  assert.equal(tr.quotes.size, 256);
  await assert.rejects(
    tr.sendVoice("15551234567@s.whatsapp.net", Buffer.from("audio"), {
      replyTo: "0",
    }),
  );
  await assert.rejects(
    tr.sendVoice("19999999999@s.whatsapp.net", Buffer.from("audio"), {
      replyTo: "256",
    }),
  );
  await assert.rejects(tr.sendVoice("15551234567@s.whatsapp.net", Buffer.from("audio"), {replyTo:"256"}),/voice disabled/);
  assert.equal(sent.length,0);
  await tr.send("15551234567@s.whatsapp.net", "text", {replyTo:"256"});
  assert.equal(sent[0][2].quoted.key.id, "256");
  await tr.stop();
});
test(
  "foreign UID ancestor rejected when ownership test is available",
  { skip: process.getuid?.() !== 0 },
  async () => {
    const { chown } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "wa-foreign-"));
    try {
      await chown(root, 65534, 65534);
      await assert.rejects(
        privateAuth(join(root, "secret"), true),
        /Untrusted auth ancestor/,
      );
    } finally {
      await chown(root, 0, 0);
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "pre-open pairing key write fsync rename failure promptly rejects and releases lock",
  { timeout: 3000 },
  async () => {
    const { pair } = await import("../src/whatsapp-pair.js");
    const before = { ...process.env };
    try {
      for (const stage of ["write", "fsync", "rename"] as const) {
        const root = await mkdtemp(join(tmpdir(), "wa-pair-fatal-"));
        const dir = join(root, "private");
        Object.assign(process.env, env, { WHATSAPP_AUTH_DIR: dir });
        let ends = 0;
        let auth: any;
        let update: any;
        try {
          const task = pair({
            interactive: true,
            authFactory: async (path, allow, opts) => {
              auth = await privateAuth(path, allow, {
                ...opts,
                fault: (current) => {
                  if (current === stage) throw new Error("secret path error");
                },
              });
              return auth;
            },
            factory: ((config: any) => {
              setImmediate(() => {
                void config.auth.keys
                  .set({ session: { test: Buffer.from("private") } })
                  .catch(() => {});
              });
              return {
                ev: {
                  on: (name: any, handler: any) => {
                    if (name === "creds.update") update = handler;
                  },
                },
                end: () => {
                  ends++;
                },
              };
            }) as any,
          });
          await assert.rejects(task);
          assert.equal(ends, 1);
          assert.equal(
            (await (await import("node:fs/promises")).readdir(dir)).includes(
              "process.lock",
            ),
            false,
          );
          let saves = 0;
          auth.saveCreds = async () => {
            saves++;
          };
          update({});
          assert.equal(saves, 0);
          const next = await privateAuth(dir, true);
          await next.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  },
);

test("fatal observers are independently exception isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-observer-"));
  const dir = join(root, "private");
  try {
    const auth = await privateAuth(dir, true, {
      onFatal: () => {
        throw new Error("observer");
      },
      fault: () => {
        throw new Error("disk");
      },
    });
    let notifications = 0;
    auth.subscribeFatal(() => {
      throw new Error("subscriber");
    });
    auth.subscribeFatal(() => {
      notifications++;
    });
    await assert.rejects(
      auth.state.keys.set({ session: { test: Buffer.from("x") } }),
    );
    assert.equal(notifications, 1);
    assert.doesNotThrow(() =>
      auth.subscribeFatal(() => {
        throw new Error("late");
      }),
    );
    auth.subscribeFatal(() => {
      notifications++;
    });
    assert.equal(notifications, 2);
    await assert.rejects(auth.close());
    const next = await privateAuth(dir, true);
    await next.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
