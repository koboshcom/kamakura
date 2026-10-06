import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { transcribeWav } from '../src/transcription.js';
import { config } from '../src/config.js';

function mockClient(result: unknown = { text: ' hello shrine cat ' }, status = 200): OpenAI {
  return new OpenAI({
    apiKey: 'test-only-not-a-real-key', maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options?.method, 'POST');
      const body = options?.body as FormData;
      assert.ok(body instanceof FormData);
      assert.equal(body.get('model'), config.transcriptionModel);
      assert.equal(body.get('response_format'), 'json');
      const audio = body.get('file') as File;
      assert.equal(audio.name, 'audio.wav');
      assert.equal(audio.type, 'audio/wav');
      assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'fixture');
      assert.deepEqual([...body.keys()].sort(), ['file', 'model', 'response_format']);
      assert.ok(options?.signal);
      return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });
    },
  });
}

test('WAV transcription uses audio/transcriptions multipart file and configured model', async () => {
  assert.equal(await transcribeWav(Buffer.from('fixture'), mockClient()), 'hello shrine cat');
  assert.equal(await transcribeWav(Buffer.from('fixture'), mockClient({ text: '' })), '');
  assert.equal((await transcribeWav(Buffer.from('fixture'), mockClient({ text: 'a'.repeat(20000) }))).length, 16000);
});

test('transcription rejects malformed response, API failures and invalid audio size without fallback', async () => {
  await assert.rejects(transcribeWav(Buffer.from('fixture'), mockClient({ text: 4 })), /invalid text/);
  await assert.rejects(transcribeWav(Buffer.from('fixture'), mockClient({ error: { message: 'not available', type: 'invalid_request_error' } }, 400)), OpenAI.BadRequestError);
  await assert.rejects(transcribeWav(Buffer.alloc(0), mockClient()), /empty or too large/);
  await assert.rejects(transcribeWav(Buffer.alloc(config.maxMediaBytes + 1), mockClient()), /empty or too large/);
});
