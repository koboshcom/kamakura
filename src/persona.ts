import { readFileSync } from 'node:fs';
import { config } from './config.js';

/** Operator presentation only. Immutable runtime rules are appended separately. */
export function personaPrompt(): string {
  const base = config.systemPrompt || (config.systemPromptPath ? readFileSync(config.systemPromptPath, 'utf8') : '')
    || config.personaText || readFileSync(config.persona, 'utf8');
  return [base.trim().replaceAll('{{BOT_NAME}}', config.botName),
    config.personality, 'Your configured display name is ' + JSON.stringify(config.botName) + '.'].filter(Boolean).join('\n');
}
export function customChatStyle(): string {
  return config.chatStyleText || (config.chatStylePath ? readFileSync(config.chatStylePath, 'utf8').trim() : '');
}
