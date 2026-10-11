import OpenAI, { toFile } from 'openai';
import { config } from './config.js';
import {validateProvider,providerFetch} from './provider-settings.js';

export function transcriptionClient(options: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}): OpenAI {
  const settings=transcriptionSettings();
  return new OpenAI({ ...options,baseURL:settings.baseUrl,apiKey:settings.apiKey,adminAPIKey:null,webhookSecret:null,organization:null,project:null,logLevel:'off',maxRetries:options.maxRetries??1,timeout:config.mediaTimeoutMs,fetch:options.fetch?((input,init)=>options.fetch!(input,{...init,redirect:'error'})):providerFetch });
}

export function transcriptionSettings(){return validateProvider('transcription',{baseUrl:config.transcriptionBaseUrl,apiKey:config.transcriptionApiKey,model:config.transcriptionModel});}

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
