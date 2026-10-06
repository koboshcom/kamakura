import OpenAI, { toFile } from 'openai';
import { config } from './config.js';

export async function transcribeWav(audio: Buffer, client = new OpenAI({ maxRetries: 1, timeout: config.mediaTimeoutMs })): Promise<string> {
  if (!audio.length || audio.length > config.maxMediaBytes) throw new Error('Transcription audio is empty or too large');
  const result = await client.audio.transcriptions.create({
    model: config.transcriptionModel,
    file: await toFile(audio, 'audio.wav', { type: 'audio/wav' }),
    response_format: 'json',
  }, { signal: AbortSignal.timeout(config.mediaTimeoutMs) });
  if (typeof result.text !== 'string') throw new Error('Transcription returned invalid text');
  return result.text.trim().slice(0, 16000);
}
