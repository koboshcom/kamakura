import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundJobs } from '../src/jobs.js';
import type { IncomingMessage } from '../src/types.js';

const incoming = (id = '123'): IncomingMessage => ({ transport: 'telegram', chatId: id, senderId: id, sender: 'owner', id: '1', text: 'do the task', isGroup: false, timestamp: 0 });
const authorize = (m: IncomingMessage) => !m.isGroup && m.chatId === m.senderId;

test('handoff returns before runner, snapshots owner, sends result and releases slot', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let ran = false;
  const sent: string[] = [];
  const jobs = new BackgroundJobs(async job => { ran = true; await wait; assert.equal(job.incoming.chatId, '123'); return 'done'; }, async (job, text) => { sent.push(`${job.incoming.chatId} ${text}`); }, authorize);
  const source = incoming();
  assert.equal(jobs.start(source, 'task').status, 'started');
  source.chatId = '999';
  assert.equal(ran, false);
  assert.throws(() => jobs.start(incoming(), 'task'), /already/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, true);
  release();
  await jobs.drain();
  assert.deepEqual(sent, ['123 done']);
  jobs.start(incoming(), 'another');
  await jobs.drain();
});

test('bounded concurrency, authorization and task validation', async () => {
  const jobs = new BackgroundJobs(async () => 'ok', async () => {}, authorize, { concurrency: 1, timeoutMs: 100 });
  assert.throws(() => jobs.start({ ...incoming(), isGroup: true }, 'task'), /authorized/);
  assert.throws(() => jobs.start(incoming(), ''), /characters/);
  assert.throws(() => jobs.start(incoming(), 'x'.repeat(8001)), /characters/);
  jobs.start(incoming(), 'task');
  assert.throws(() => jobs.start(incoming('456'), 'task'), /busy/);
  await jobs.drain();
});

test('failed runner hides error bodies; delivery failure releases slot', async () => {
  const sent: string[] = [];
  const errors: unknown[] = [];
  const jobs = new BackgroundJobs(async () => { throw new Error('secret'); }, async (_job, text) => { sent.push(text); throw new Error('delivery'); }, authorize, { concurrency: 1, timeoutMs: 100 }, error => errors.push(error));
  jobs.start(incoming(), 'task'); await jobs.drain();
  assert.match(sent[0]!, /failed/); assert.ok(!sent[0]!.includes('secret'));
  assert.equal(errors.length, 1);
  jobs.start(incoming(), 'task'); await jobs.drain();
});

test('timeout aborts and notifies; shutdown rejects new work and does not send', async () => {
  const sent: string[] = [];
  const jobs = new BackgroundJobs(async (_job, signal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), async (_job, text) => { sent.push(text); }, authorize, { concurrency: 1, timeoutMs: 10 });
  jobs.start(incoming(), 'task'); await jobs.drain();
  assert.match(sent[0]!, /stopped/);
  jobs.start(incoming(), 'task'); jobs.stop(); await jobs.drain();
  assert.equal(sent.length, 1);
  assert.throws(() => jobs.start(incoming(), 'task'), /shutting down/);
});

test('authorization revoked after start prevents execution and delivery', async () => {
  let permitted = true;
  let ran = false;
  const jobs = new BackgroundJobs(async () => { ran = true; return 'ok'; }, async () => assert.fail('must not deliver'), () => permitted);
  jobs.start(incoming(), 'task'); permitted = false; await jobs.drain();
  assert.equal(ran, false);
});
