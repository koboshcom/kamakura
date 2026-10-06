import { readFileSync } from 'node:fs';

export function loadTailscaleKeys(path?: string): Map<string, string> {
  const keys = new Map<string, string>();
  if (!path) return keys;
  try {
    const raw = readFileSync(path);
    if (raw.length > 65536) throw new Error();
    const data: unknown = JSON.parse(raw.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    for (const [id, key] of Object.entries(data)) {
      if (!/^[1-9]\d{0,15}$/.test(id) || typeof key !== 'string' || !/^tskey-auth-[A-Za-z0-9-]{10,250}$/.test(key)) throw new Error();
      keys.set(id, key);
    }
    return keys;
  } catch { throw new Error('Invalid per-user Tailscale auth-key file'); }
}
