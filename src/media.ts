import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeWav } from './transcription.js';
import sharp from 'sharp';
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
  const data = input.data;
  if (data.length > config.maxMediaBytes) throw new Error('Attachment too large');
  // Fail closed before either libheif or sharp sees ISO-BMFF image containers.
  // A JS heap cap does not bound native/WASM decoder allocations. Branding is
  // not a security boundary either: compatible brands and malformed headers can
  // select HEIF decoding. This also intentionally declines AVIF until decoding
  // has a killable, OS-enforced memory boundary. JPEG/PNG/WebP etc. are unchanged.
  if (/hei[cf]|avif/i.test(input.mime) || data.subarray(4, 8).toString('ascii') === 'ftyp') {
    throw new Error('HEIC/HEIF and AVIF images are disabled for resource safety. Please send JPEG, PNG or WebP instead.');
  }
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
