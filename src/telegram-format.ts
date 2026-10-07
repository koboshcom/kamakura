import MarkdownIt from 'markdown-it';
type Token = ReturnType<ReturnType<typeof MarkdownIt>['parse']>[number];
import type { MessageEntity } from 'grammy/types';
import { redactCredentials } from './credentials.js';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
export function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'tg:', 'mailto:'].includes(url.protocol)) return '';
    for (const [key, content] of [...url.searchParams]) if (key.toLowerCase() === 'utm_source' && content.toLowerCase() === 'openai') url.searchParams.delete(key);
    return url.toString();
  } catch { return ''; }
}
export function telegramText(raw: string): { text: string; entities: MessageEntity[]; plain: string } {
  // Plain Telegram entity text needs no Markdown/HTML escaping.
  const input = redactCredentials(raw).replace(/—/g, ', ');
  let text = '';
  const entities: MessageEntity[] = [];
  const links: string[] = [];
  const stack: { tag: string; offset: number; type: 'bold' | 'italic' | 'strikethrough' | 'text_link'; url?: string }[] = [];
  const append = (value: string) => { text += value; };
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case 'inline': walk(token.children ?? []); break;
        case 'text': append(token.content.replace(/https?:\/\/[^\s<>]+/g, value=>cleanUrl(value)||value)); break;
        case 'softbreak': case 'hardbreak': append('\n'); break;
        case 'code_inline': { const offset=text.length; append(token.content); entities.push({type:'code',offset,length:token.content.length}); break; }
        case 'fence': case 'code_block': { const offset=text.length; append(token.content.replace(/\n$/, '')); entities.push({type:'pre',offset,length:text.length-offset}); append('\n'); break; }
        case 'strong_open': case 'em_open': case 's_open': case 'link_open': {
          const type = token.type === 'strong_open' ? 'bold' : token.type === 'em_open' ? 'italic' : token.type === 's_open' ? 'strikethrough' : 'text_link';
          const url = type === 'text_link' ? cleanUrl(String(token.attrGet('href') ?? '')) : undefined;
          stack.push({tag:token.type.replace('_open',''),offset:text.length,type,...(url ? {url} : {})});
          if(url) links.push(url);
          break;
        }
        case 'strong_close': case 'em_close': case 's_close': case 'link_close': {
          const entry=stack.pop();
          if(entry && text.length>entry.offset && (entry.type!=='text_link'||entry.url)) entities.push({type:entry.type,offset:entry.offset,length:text.length-entry.offset,...(entry.url?{url:entry.url}:{})} as MessageEntity);
          break;
        }
        case 'paragraph_close': case 'heading_close': append('\n'); break;
        case 'list_item_open': append('- '); break;
        case 'image': append(token.content); break;
        default: if(token.nesting===0 && token.content) append(token.content);
      }
    }
  };
  walk(markdown.parse(input,{}));
  text=text.trimEnd();
  const valid=entities.filter(entity=>entity.offset+entity.length<=text.length).sort((a,b)=>a.offset-b.offset||b.length-a.length);
  const missing=[...new Set(links)].filter(url=>!text.includes(url));
  return {text,entities:valid,plain:text+(missing.length?'\n'+missing.join('\n'):'')};
}
export function entityParseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure=error as {error_code?: number; description?: string};
  return failure.error_code===400 && /can't parse|cannot parse|entity|entities|unsupported start tag/i.test(failure.description ?? '');
}
