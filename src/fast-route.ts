import { config } from './config.js';
import type { StoredMessage } from './history.js';
import type { IncomingMessage } from './types.js';

const casual = /^(?:hi|hey|hello|lol|lmao|haha|thanks|thank you|ok|okay|bye|good morning|good night)[!.?]*$/i;
/** Deliberately narrow. Never classify arbitrary task text with a second model.
 * Prior nontrivial conversation can contain unfinished work, so it stays on main.
 */
export function fastRoute(history:StoredMessage[], incoming:IncomingMessage, hasPreparedMedia=false):boolean {
  return Boolean(config.fastModel && !incoming.isGroup && !incoming.replyContext &&
    !incoming.media?.length && !hasPreparedMedia && casual.test(incoming.text.trim()) &&
    history.every(message=>casual.test(message.text.trim())));
}
export const casualTools = ['send_message','react','end_turn'] as const;
