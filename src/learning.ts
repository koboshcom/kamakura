import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { IncomingMessage } from './types.js';

export const lessonKinds = ['style', 'preference', 'correction', 'procedure'] as const;
const lessonSchema = z.object({ id: z.string().uuid(), kind: z.enum(lessonKinds), text: z.string().min(1).max(600), at: z.number().int(), source: z.enum(['teaching', 'reflection', 'execution']) }).strict();
export type Lesson = z.infer<typeof lessonSchema>;
const documentSchema = z.object({ revision: z.string().uuid(), at: z.number().int(), lessons: z.array(lessonSchema).max(100) }).strict();
type Document = z.infer<typeof documentSchema>;
const envelopeSchema = z.object({ current: documentSchema, history: z.array(documentSchema).max(30) }).strict();
export interface LearningLimits { maxBytes: number; maxLessons: number; revisions: number }
const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');

/** Reject before model calls and before disk writes, including bounded history. No credential values are returned. */
export function unsafeLesson(text: string, secrets = Object.entries(process.env).filter(([key, value]) => /key|token|secret|password|credential/i.test(key) && value && value.length >= 4).map(([, value]) => value!)): boolean {
  if (secrets.some(secret => text.includes(secret))) return true;
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[revision]');
  return /-----BEGIN|\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[a-zA-Z0-9_-]{8,}|\b\d{7,}:[a-zA-Z0-9_-]{20,}|bearer\s+\S+|(?:password|passwd|api[ _-]?key|access[ _-]?token|secret|cookie|authorization|private[ _-]?key|credential)\s*[:=]|https?:\/\/[^\s/@]+:[^\s/@]+@|https?:\/\/\S*[?&](?:key|token|secret|signature|auth|code|password)=|\b[A-Za-z0-9+/_=-]{32,}\b|[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/iu.test(text)
    || /(?:ignore|override|disable|bypass|change|replace|reveal|expose).{0,50}(?:rules|instructions|system|safety|permissions|allowlist|owners|secrets|credentials)|(?:system|developer)\s*(?:prompt|message)|<\/?(?:system|instructions|script)|(?:allowed|authorized)\s+(?:users|owners)|(?:follow|obey).{0,30}(?:web|page|file|tool output)/iu.test(text);
}
export function supportedExcerpt(evidence: string, excerpt: string): boolean {
  const clean = (text: string) => normalize(text).replace(/[.!?]+$/u, '');
  return evidence.split(/(?<=[.!?])\s+|\n/u).some(sentence => clean(sentence) === clean(excerpt));
}

// Bare conversational snippets are not durable style instructions. Contextual usage can
// still be learned without explicit teaching, but short snippets need teaching authority.
export function reusableStyle(text: string): boolean {
  return /\b(?:remember|learn|prefer|correction|correct|instead|stop|don't|do not|teach|means)\b/i.test(text)
    || text.trim().split(/\s+/u).length >= 6;
}

/** Only transport-marked direct owner text is eligible, never quoted/forwarded/media or old history. */
export function ownerEvidence(incoming: IncomingMessage, owners: Set<string>): string | undefined {
  if (incoming.transport !== 'telegram' || !incoming.senderId || !owners.has(incoming.senderId) || incoming.learningEligible !== true || incoming.media?.length) return;
  const text = incoming.text.trim();
  if (!text || text.length > 8000 || unsafeLesson(text) || /```|^\s*>|[“”"«»]|https?:\/\/|\b(?:webpage|website|attachment|transcript|tool output|file says|page says|quoted|forwarded)\b/imu.test(text)) return;
  return text;
}

/** Fixed hashed scope paths, synchronous atomic transactions avoid in-process lost writes. One core process owns this directory. */
export class LessonsStore {
  constructor(private readonly dir: string, private readonly limits: LearningLimits = { maxBytes: 16384, maxLessons: 32, revisions: 10 }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('Learning directory cannot be a symlink');
    chmodSync(dir, 0o700);
  }
  private path(scope: string): string { return join(this.dir, `${createHash('sha256').update(scope).digest('hex')}.json`); }
  private validate(document: Document): Document {
    documentSchema.parse(document);
    if (document.lessons.length > this.limits.maxLessons || document.lessons.some(lesson => unsafeLesson(lesson.text)) || Buffer.byteLength(JSON.stringify(document)) > this.limits.maxBytes) throw new Error('Unsafe or oversized lessons');
    return document;
  }
  private read(scope: string): z.infer<typeof envelopeSchema> {
    const path = this.path(scope);
    if (!existsSync(path)) return { current: { revision: randomUUID(), at: Date.now(), lessons: [] }, history: [] };
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > this.limits.maxBytes * (this.limits.revisions + 2)) throw new Error('Unsafe learning file');
    const envelope = envelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    this.validate(envelope.current);
    for (const version of envelope.history) this.validate(version);
    if (envelope.history.length > this.limits.revisions) throw new Error('History limit exceeded');
    return envelope;
  }
  list(scope: string): Lesson[] { return this.read(scope).current.lessons; }
  versions(scope: string): { revision: string; at: number; count: number }[] {
    const envelope = this.read(scope);
    return [envelope.current, ...envelope.history].map(version => ({ revision: version.revision, at: version.at, count: version.lessons.length }));
  }
  private save(scope: string, envelope: z.infer<typeof envelopeSchema>, lessons: Lesson[]): string {
    const current = this.validate({ revision: randomUUID(), at: Date.now(), lessons });
    const next = { current, history: [envelope.current, ...envelope.history].slice(0, this.limits.revisions) };
    const path = this.path(scope); const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path); chmodSync(path, 0o600);
    return current.revision;
  }
  add(scope: string, kind: Lesson['kind'], text: string, source: Lesson['source']): { id: string; revision?: string; duplicate: boolean } {
    const normalized = normalize(text);
    if (!normalized || normalized.length > 600 || unsafeLesson(normalized)) throw new Error('Unsafe lesson rejected');
    const envelope = this.read(scope);
    const duplicate = envelope.current.lessons.find(lesson => lesson.kind === kind && normalize(lesson.text).toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (duplicate) return { id: duplicate.id, duplicate: true };
    const lesson: Lesson = { id: randomUUID(), kind, text: normalized, at: Date.now(), source };
    const lessons = [...envelope.current.lessons, lesson].slice(-this.limits.maxLessons);
    while (Buffer.byteLength(JSON.stringify({ revision: randomUUID(), at: Date.now(), lessons })) > this.limits.maxBytes && lessons.length > 1) lessons.shift();
    return { id: lesson.id, revision: this.save(scope, envelope, lessons), duplicate: false };
  }
  remove(scope: string, id: string): string { const envelope = this.read(scope); return this.save(scope, envelope, envelope.current.lessons.filter(lesson => lesson.id !== id)); }
  rollback(scope: string, revision: string): string {
    const envelope = this.read(scope); const version = [envelope.current, ...envelope.history].find(version => version.revision === revision);
    if (!version) throw new Error('Revision unavailable');
    return this.save(scope, envelope, this.validate(version).lessons);
  }
}
export const learningScope = (incoming: IncomingMessage) => JSON.stringify([incoming.transport, incoming.chatId, incoming.senderId]);
export interface ToolObservation { tool: string; outcome: 'ok' | 'failed' | 'unknown'; recipe?: string }
/** Never retain output, URLs, arbitrary generated input or error messages. Direct owner commands can be reusable recipes. */
export function toolObservation(tool: string, input: unknown, output: unknown, evidence: string): ToolObservation | undefined {
  if (!/^[a-z_]{1,40}$/.test(tool) || /learn|lesson|worker|remember/.test(tool)) return;
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  let outcome: ToolObservation['outcome'] = 'unknown';
  if (typeof result.exitCode === 'number') outcome = result.exitCode === 0 && !result.timedOut ? 'ok' : 'failed';
  else if (result.error || result.timedOut) outcome = 'failed';
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = tool === 'run_command' && typeof args.command === 'string' ? normalize(args.command) : '';
  const recipe = command && command.length <= 180 && normalize(evidence).includes(command) && !/\b(?:never|not|don't|avoid|stop)\b/i.test(evidence) && !unsafeLesson(command) && !/[<>]|https?:\/\/|(?:\/home\/|\/work\/|\.ssh|\.env)|\b(?:curl|wget|ssh|export|env|printenv|sudo|rm|chmod|chown)\b/.test(command) ? command : undefined;
  return { tool, outcome, ...(recipe ? { recipe } : {}) };
}
export function executionLesson(observations: ToolObservation[]): string | undefined {
  if (!observations.length) return;
  const selected = observations.slice(0, 8).map(item => `${item.tool}${item.recipe ? ` (${item.recipe})` : ''} ${item.outcome}`);
  const render = () => `Observed tool execution sequence, not proof of overall task success: ${selected.join('; ')}. Recheck prerequisites and results before reuse; adapt to the current authorized request.`;
  while (render().length > 600 && selected.length > 1) selected.pop();
  return render();
}
