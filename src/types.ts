export interface MediaInput {
  kind: 'image' | 'video' | 'audio';
  data: Buffer;
  mime: string;
}

export interface IncomingMessage {
  transport: 'telegram';
  addressed?: boolean;
  chatId: string;
  id: string;
  replyContext?: { id: string; text: string; senderId?: string };
  sender: string;
  senderId?: string;
  /** Set only by authenticated transport, false for forwards/quotes/media. */
  learningEligible?: boolean;
  /** Authenticated transport provenance, never inferred from message wording. */
  credentialEligible?: boolean;
  media?: MediaInput[];
  text: string;
  isGroup: boolean;
  timestamp: number;
  reactionKey?: unknown;
}

export interface Transport {
  name: IncomingMessage['transport'];
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  send(chatId: string, text: string, options?: { replyTo?: string }): Promise<void>;
  sendVoice?(chatId:string,audio:Buffer,options?:{replyTo?:string}):Promise<void>;
  react?(message: IncomingMessage, emoji: string): Promise<void>;
  startTyping?(chatId: string): () => void;
  stop(): Promise<void>;
}

export function chatKey(message: Pick<IncomingMessage, 'transport' | 'chatId'>): string {
  return `${message.transport}:${message.chatId}`;
}
