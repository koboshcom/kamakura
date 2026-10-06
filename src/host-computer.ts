import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const coord = z.number().int().min(0).max(16383);
const key = z.string().regex(/^(?:[a-z0-9]|enter|tab|space|backspace|delete|escape|esc|up|down|left|right|home|end|pageup|pagedown|shift|ctrl|alt|option|command|win|f(?:[1-9]|1[0-2]))$/);
export const hostInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }).strict(),
  z.object({ action: z.literal('click'), x: coord, y: coord, button: z.enum(['left', 'right', 'middle']).default('left') }).strict(),
  z.object({ action: z.literal('move'), x: coord, y: coord }).strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(2000).regex(/^[\x20-\x7e]+$/) }).strict(),
  z.object({ action: z.literal('press'), keys: z.array(key).min(1).max(4) }).strict(),
]);
export type HostInput = z.infer<typeof hostInputSchema>;
export type HostResult = { text: string; images: string[] };
const idSchema = z.string().regex(/^[1-9]\d{0,15}$/);
function endpointValid(value: string): boolean {
  try {
    const u = new URL(value);
    const parts = u.hostname.split('.');
    return u.protocol === 'http:' && u.port === '8765' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
      /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname) && parts.every(p => String(Number(p)) === p && Number(p) <= 255) && Number(parts[1]) >= 64 && Number(parts[1]) <= 127 &&
      value === `http://${u.hostname}:8765`;
  } catch { return false; }
}
const configSchema = z.array(z.object({ telegramUserId: idSchema, endpoint: z.string().refine(endpointValid), secret: z.string().min(32).max(256).regex(/^[\x21-\x7e]+$/) }).strict()).max(100);
type Entry = z.infer<typeof configSchema>[number];
const MAX_RESPONSE = 6 * 1024 * 1024;
export class HostComputers {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, { nonce: string; input: HostInput; expires: number }>();
  constructor(path = process.env.HOST_COMPUTER_CONFIG_FILE, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!path) return;
    let entries: Entry[];
    try {
      const raw = readFileSync(path);
      if (raw.length > 65536) throw new Error();
      entries = configSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch { throw new Error('Invalid host computer config'); }
    for (const entry of entries) {
      if (this.entries.has(entry.telegramUserId)) throw new Error('Duplicate host computer user');
      this.entries.set(entry.telegramUserId, entry);
    }
  }
  available(userId: string): boolean { return this.entries.has(userId); }
  async request(userId: string, input: HostInput): Promise<HostResult> {
    if (!this.available(userId)) return { text: 'Host computer is not enabled for this user.', images: [] };
    const parsed = hostInputSchema.parse(input);
    if (parsed.action === 'screenshot') return this.execute(userId, parsed);
    const nonce = randomBytes(16).toString('hex');
    this.pending.set(userId, { nonce, input: parsed, expires: this.now() + 60000 });
    const summary = parsed.action === 'type' ? `type ${parsed.text.length} characters` : parsed.action === 'press' ? `press ${parsed.keys.join('+')}` : `${parsed.action} at (${parsed.x}, ${parsed.y})`;
    return { text: `Host computer would ${summary}. Send exactly confirm ${nonce} within 60 seconds to approve. This replaces any earlier pending action.`, images: [] };
  }
  async confirm(userId: string, message: string): Promise<HostResult | undefined> {
    if (!/^confirm [a-f0-9]{32}$/.test(message)) return undefined;
    const item = this.pending.get(userId);
    if (!item || message !== `confirm ${item.nonce}`) return { text: 'No matching host action for this user.', images: [] };
    this.pending.delete(userId); // Consume before I/O; never retry an uncertain mutation.
    if (this.now() >= item.expires) return { text: 'Host confirmation expired. Request the action again.', images: [] };
    return this.execute(userId, item.input);
  }
  private async execute(userId: string, input: HostInput): Promise<HostResult> {
    const entry = this.entries.get(userId)!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetcher(`${entry.endpoint}/v1/action`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${entry.secret}`, 'X-Telegram-User-Id': userId, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = z.object({ text: z.string().max(300), images: z.array(z.string().max(MAX_RESPONSE)).max(1) }).strict().parse(data);
      if (result.images.some(image => !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || !Buffer.from(image, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))) throw new Error();
      // Do not expose arbitrary remote text, which could contain credentials.
      return { text: input.action === 'screenshot' ? 'Host screenshot captured.' : 'Host action completed.', images: result.images };
    } catch { return { text: 'Host request failed or timed out. A mutation may already have happened; inspect before requesting another.', images: [] }; }
    finally { clearTimeout(timer); }
  }
}
