import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { jpeg, prepareMedia } from '../src/media.js';
import { config } from '../src/config.js';
import type { MediaInput } from '../src/types.js';

function image(data: Buffer, mime = 'application/octet-stream'): MediaInput {
  return { kind: 'image', data, mime };
}
function container(major: string, compatible = ''): Buffer {
  const data = Buffer.alloc(16 + compatible.length);
  data.writeUInt32BE(data.length);
  data.write('ftyp', 4);
  data.write(major, 8);
  data.write(compatible, 16);
  return data;
}
const rejection = /disabled for resource safety.*JPEG, PNG or WebP/;

test('HEIC/HEIF MIME types reject before decoding even non-container bytes', async () => {
  for (const mime of ['image/heic', 'image/heif', 'image/heic-sequence', 'IMAGE/HEIF;foo=bar']) {
    await assert.rejects(jpeg(image(Buffer.from('not an image'), mime)), rejection);
  }
});

test('ISO-BMFF images reject regardless of MIME, major or compatible brands', async () => {
  for (const data of [container('heic'), container('heix'), container('mif1', 'heic'), container('xxxx', 'hevc'), container('avif'), container('xxxx'), Buffer.from('\x00\x00\x00\x00ftyp')]) {
    await assert.rejects(jpeg(image(data, 'image/jpeg')), rejection);
  }
});

test('AVIF MIME is explicitly fail closed as well', async () => {
  await assert.rejects(jpeg(image(Buffer.from('not an image'), 'image/avif')), rejection);
});

test('direct jpeg callers enforce attachment byte limit before decoding', async () => {
  await assert.rejects(jpeg(image(Buffer.alloc(config.maxMediaBytes + 1))), /Attachment too large/);
});

test('regular JPEG, PNG and WebP still prepare as bounded JPEGs', async () => {
  const raw = sharp({ create: { width: 1600, height: 100, channels: 3, background: '#abcdef' } });
  const inputs = [image(await raw.clone().jpeg().toBuffer(), 'image/jpeg'), image(await raw.clone().png().toBuffer(), 'image/png'), image(await raw.clone().webp().toBuffer(), 'image/webp')];
  const prepared = await prepareMedia(inputs);
  assert.equal(prepared.images.length, 3);
  assert.equal(prepared.text, '');
  for (const data of prepared.images) {
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.ok(metadata.width! <= 1280 && metadata.height! <= 1280);
  }
});

test('ordinary image pixel guard still rejects images above 20 million pixels', async () => {
  const png = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(jpeg(image(png, 'image/png')), /pixel limit/);
});

test('prepareMedia rejects HEIC and retains four attachment cap', async () => {
  await assert.rejects(prepareMedia([image(container('heic'))]), rejection);
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  const result = await prepareMedia([...Array.from({ length: 4 }, () => image(png, 'image/png')), image(container('heic'))]);
  assert.equal(result.images.length, 4);
});
