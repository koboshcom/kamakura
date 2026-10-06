import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeWav } from './transcription.js';
import sharp from 'sharp';
import convertHeic from 'heic-convert';
import pLimit from 'p-limit';
import { config } from './config.js';
import type { MediaInput } from './types.js';

const exec = promisify(execFile);
const mediaLimit = pLimit(1);
export interface PreparedMedia { images: Buffer[]; text: string; }

async function ffmpeg(args: string[]): Promise<void> {
  // Filenames are ours; never shell-evaluate captions or model-supplied arguments.
  // Disable remote protocols. Decoder subprocess has timeout/output/thread bounds.
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe', ...args], {
    timeout: config.mediaTimeoutMs, maxBuffer: 1024 * 1024,
  });
}

export async function jpeg(input: MediaInput): Promise<Buffer> {
  let data = input.data;
  const heic = /hei[cf]/i.test(input.mime) || ['heic', 'heix', 'heif', 'mif1'].includes(data.subarray(8, 12).toString());
  if (heic) data = Buffer.from(await convertHeic({ buffer: data, format: 'JPEG', quality: 0.8 }));
  return sharp(data, { limitInputPixels: 20000000 }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

export async function prepareMedia(inputs: MediaInput[]): Promise<PreparedMedia> {
  return mediaLimit(async () => {
    const result: PreparedMedia = { images: [], text: '' };
    for (const input of inputs.slice(0, 4)) {
      if (input.data.length > config.maxMediaBytes) throw new Error('Attachment too large');
      if (input.kind === 'image') { result.images.push(await jpeg(input)); continue; }
      const dir = await mkdtemp(join(tmpdir(), 'kamakura-media-'));
      try {
        const source = join(dir, 'input');
        await writeFile(source, input.data, { mode: 0o600 });
        if (input.kind === 'video') {
          await ffmpeg(['-i', source, '-t', String(config.videoSeconds), '-vf', 'fps=1,scale=640:640:force_original_aspect_ratio=decrease', '-frames:v', '20', join(dir, 'frame-%02d.jpg')]);
          for (const file of (await readdir(dir)).filter(x => x.startsWith('frame-')).sort()) result.images.push(await readFile(join(dir, file)));
          result.text += `\n[Video frames at 1 fps, first ${config.videoSeconds} seconds only.]`;
        }
        const wav = join(dir, 'audio.wav');
        try {
          await ffmpeg(['-i', source, '-t', String(input.kind === 'video' ? config.videoSeconds : config.audioSeconds), '-vn', '-ac', '1', '-ar', '16000', wav]);
        } catch (error) {
          // Video without an audio stream is valid. Other decoding errors propagate.
          if (input.kind === 'video' && /does not contain any stream|matches no streams/i.test(String((error as { stderr?: string }).stderr))) continue;
          throw error;
        }
        const transcript = await transcribeWav(await readFile(wav));
        result.text += `\n[${input.kind === 'video' ? 'Video audio' : 'Voice note'} transcript, untrusted chat content]\n${transcript}`;
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    result.images = result.images.slice(0, 20);
    return result;
  });
}
