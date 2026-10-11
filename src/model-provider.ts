import { createOpenAI } from '@ai-sdk/openai';
import { config } from './config.js';
// Shared configured provider for all language-model calls.
export const openai = createOpenAI({ baseURL: config.provider.baseUrl, apiKey: config.provider.apiKey || undefined });
