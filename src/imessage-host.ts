import { config } from './config.js';
import { IMessageTransport } from './transports/imessage.js';
import { errorType, logger } from './logger.js';
import pLimit from 'p-limit';

if (config.bridgeToken.length < 32) throw new Error('BRIDGE_TOKEN must match the core, at least 32 random characters');
const url = new URL(config.bridgeUrl);
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Host bridge must use a loopback core URL');
const headers = { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type': 'application/json' };
const host = new IMessageTransport();
const uploads = pLimit(1);
await host.start(message => {
  void uploads(async () => {
    const body = JSON.stringify({ ...message, media: message.media?.map(m => ({ kind: m.kind, mime: m.mime, base64: m.data.toString('base64') })) });
    // Safe to retry incoming uploads: the core deduplicates by message GUID.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(new URL('/incoming', url), { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Core rejected upload');
        return;
      } catch (error) {
        if (attempt === 2) logger.error({ err: errorType(error) }, 'host upload failed; message not delivered');
        else await new Promise(r => setTimeout(r, 2000));
      }
    }
  });
});
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(new URL('/outgoing',url), { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Core rejected poll');
    const items = await response.json() as { chat: string; text: string }[];
    for (const item of items) await host.send(item.chat,item.text);
  } catch (error) { logger.error({ err: errorType(error) }, 'host outgoing poll/send failed; no resend after uncertain send'); }
  finally { busy = false; }
}, 1000);
const stop = async () => { clearInterval(timer); await host.stop(); process.exit(0); };
process.once('SIGINT',stop);
process.once('SIGTERM',stop);
