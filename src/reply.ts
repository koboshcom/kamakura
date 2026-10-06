export interface ParsedReply {
  skip: boolean;
  reaction?: string;
  messages: string[];
}

const reactionPattern = /<react:([^>\n]{1,16})>/u;
const emojiPattern = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;

export function parseReply(raw: string, maxMessages: number, maxChars: number): ParsedReply {
  let text = raw.trim();
  if (/^<skip>\s*$/i.test(text)) return { skip: true, messages: [] };
  const match = text.match(reactionPattern);
  const reaction = match?.[1]?.trim();
  text = text.replace(new RegExp(reactionPattern, 'gu'), '').replace(/<skip>/gi, '').trim();
  const messages = text
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, maxMessages)
    .map(part => part.slice(0, maxChars));
  return {
    skip: messages.length === 0 && !reaction,
    reaction: reaction && emojiPattern.test(reaction) ? reaction : undefined,
    messages,
  };
}
