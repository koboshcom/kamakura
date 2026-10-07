import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";
/** One atomic snapshot for credentials AND keys. No swallowed corruption, no raw logs. */
export async function privateAuth(
  dir: string,
  allowNew = false,
  options: {
    onFatal?: () => void;
    fault?: (stage: "write" | "fsync" | "rename") => void;
  } = {},
) {
  // Reject symlink ancestors. Deployment must additionally keep this volume out of sandbox mounts.
  let parent = dir;
  while (parent !== parse(parent).root) {
    try {
      const st = await lstat(parent);
      if (
        ![0, process.getuid?.()].includes(st.uid) ||
        ((st.mode & 0o022) !== 0 &&
          !(parent === "/tmp" && st.uid === 0 && (st.mode & 0o1000) !== 0))
      )
        throw new Error("Untrusted auth ancestor");
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error("Unsafe auth directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    parent = dirname(parent);
  }
  const rootStat = await lstat(parse(dir).root);
  if (rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0)
    throw new Error("Untrusted root");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if ((st.mode & 0o777) !== 0o700 || st.uid !== process.getuid?.())
    throw new Error("Auth directory must be private and owned");
  const lock = await open(
    join(dir, "process.lock"),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const file = join(dir, "state.json");
  let keys: Record<string, unknown> = {};
  let creds = initAuthCreds();
  let tail = Promise.resolve();
  let closed = false;
  let failed = false;
  const fatalListeners = new Set<() => void>();
  let closing: Promise<void> | undefined;
  try {
    try {
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const s = await handle.stat();
        if (
          (s.mode & 0o777) !== 0o600 ||
          s.uid !== st.uid ||
          !s.isFile() ||
          s.size > 64 * 1024 * 1024
        )
          throw new Error("Unsafe auth state");
        const data = JSON.parse(
          await handle.readFile("utf8"),
          BufferJSON.reviver,
        );
        creds = data.creds;
        keys = data.keys;
        if (!creds || !keys || typeof keys !== "object")
          throw new Error("Invalid auth snapshot");
      } finally {
        await handle.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !allowNew) throw e;
    }
  } catch (e) {
    await lock.close();
    await unlink(join(dir, "process.lock"));
    throw e;
  }
  const serialize = (operation: () => Promise<void>) => {
    if (closed || failed) return Promise.reject(new Error("Auth closed"));
    const next = tail.then(operation);
    tail = next;
    void next.catch(() => {
      if (!failed) {
        failed = true;
        try {
          options.onFatal?.();
        } catch {}
        for (const listener of fatalListeners) {
          try {
            listener();
          } catch {}
        }
      }
    });
    return next;
  };
  const persist = async () => {
    const temp = join(dir, ".state-" + randomUUID());
    try {
      const h = await open(temp, "wx", 0o600);
      try {
        options.fault?.("write");
        await h.writeFile(JSON.stringify({ creds, keys }, BufferJSON.replacer));
        options.fault?.("fsync");
        await h.sync();
      } finally {
        await h.close();
      }
      options.fault?.("rename");
      await rename(temp, file);
      const d = await open(dir, "r");
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } finally {
      await unlink(temp).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      });
    }
  };
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (closed || failed) throw new Error("Auth closed");
        await tail;
        const out: Record<string, SignalDataTypeMap[typeof type]> = {};
        for (const id of ids) {
          let v = keys[JSON.stringify([type, id])];
          if (v && type === "app-state-sync-key")
            v = proto.Message.AppStateSyncKeyData.fromObject(
              v as Record<string, unknown>,
            );
          if (v) out[id] = v as SignalDataTypeMap[typeof type];
        }
        return out;
      },
      set: (data: SignalDataSet) =>
        serialize(async () => {
          for (const [type, rows] of Object.entries(data))
            for (const [id, v] of Object.entries(rows ?? {})) {
              const k = JSON.stringify([type, id]);
              if (v == null) delete keys[k];
              else keys[k] = v;
            }
          await persist();
        }),
    },
  };
  return {
    state,
    subscribeFatal: (listener: () => void) => {
      fatalListeners.add(listener);
      if (failed) {
        try {
          listener();
        } catch {}
      }
      return () => {
        fatalListeners.delete(listener);
      };
    },
    saveCreds: () => serialize(persist),
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          await tail;
        } finally {
          await lock.close();
          await unlink(join(dir, "process.lock"));
        }
      })();
      return closing;
    },
  };
}
