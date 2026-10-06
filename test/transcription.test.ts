import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { transcribeWav } from '../src/transcription.js';
import { config } from '../src/config.js';

function mockClient(status = 'completed', refuse = false): OpenAI {
  return new OpenAI({
    apiKey: 'test-only-not-a-real-key', maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(options?.method, 'POST');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, config.transcriptionModel);
      assert.equal(body.store, false);
      assert.equal(body.input[0].role, 'user');
      assert.deepEqual(body.input[0].content[0], { type: 'input_audio', input_audio: { data: Buffer.from('fixture').toString('base64'), format: 'wav' } });
      assert.ok(!body.tools && !body.reasoning);
      return new Response(JSON.stringify({
        id: 'resp-test', object: 'response', status,
        output: [{ type: 'message', id: 'msg-test', role: 'assistant', status: 'completed', content: [refuse ? { type: 'refusal', refusal: 'no' } : { type: 'output_text', text: 'hello shrine cat', annotations: [] }] }],
      }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
}

test('WAV transcription uses Responses input_audio and extracts text', async () => {
  assert.equal(await transcribeWav(Buffer.from('fixture'), mockClient()), 'hello shrine cat');
});

test('transcription rejects incomplete responses, refusals and invalid audio size', async () => {
  await assert.rejects(transcribeWav(Buffer.from('fixture'), mockClient('incomplete')), /did not complete/);
  await assert.rejects(transcribeWav(Buffer.from('fixture'), mockClient('completed', true)), /refused/);
  await assert.rejects(transcribeWav(Buffer.alloc(0), mockClient()), /empty or too large/);
  await assert.rejects(transcribeWav(Buffer.alloc(config.maxMediaBytes + 1), mockClient()), /empty or too large/);
});
