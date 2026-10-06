import OpenAI, { toFile } from 'openai';
import { config } from './config.js';

export function transcriptionClient(options: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}): OpenAI {
  // Never reuse a chat-provider base URL for speech. A custom speech host must
  // have its own credential, rather than accidentally forwarding the chat key.
  if (config.transcriptionBaseUrl && !config.transcriptionApiKey) throw new Error('OPENAI_TRANSCRIBE_API_KEY is required with a custom speech endpoint');
  return new OpenAI({ baseURL: config.transcriptionBaseUrl ?? 'https://api.openai.com/v1', apiKey: config.transcriptionApiKey ?? process.env.OPENAI_API_KEY, maxRetries: 1, timeout: config.mediaTimeoutMs, ...options });
}

export async function transcribeWav(audio: Buffer, client = transcriptionClient()): Promise<string> {
  if (!audio.length || audio.length > config.maxMediaBytes) throw new Error('Transcription audio is empty or too large');
  const result = await client.audio.transcriptions.create({
    model: config.transcriptionModel,
    file: await toFile(audio, 'audio.wav', { type: 'audio/wav' }),
    response_format: 'json',
  }, { signal: AbortSignal.timeout(config.mediaTimeoutMs) });
  if (typeof result.text !== 'string') throw new Error('Transcription returned invalid text');
  return result.text.trim().slice(0, 16000);
}
