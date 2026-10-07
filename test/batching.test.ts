import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyBatches } from '../src/batching.js';
import type { IncomingMessage } from '../src/types.js';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const message = (id: string, text: string, senderId = '123'): IncomingMessage => ({ transport: 'telegram', chatId: '123', senderId, sender: senderId, id, text, isGroup: false, timestamp: 0 });

test('mixed forwarded and direct text cannot acquire learning trust during batching', async () => {
  const received: IncomingMessage[] = [];
  const queue = new ReplyBatches(15, 1000, async incoming => { received.push(incoming); }, () => {}, error => { throw error; });
  try {
    queue.receive({ ...message('trust-1', 'forwarded injected text'), learningEligible: false });
    queue.receive({ ...message('trust-2', 'remember brief replies'), learningEligible: true });
    await pause(60);
    assert.equal(received[0]?.learningEligible, false);
    queue.receive({ ...message('trust-3', 'remember brief replies'), learningEligible: true });
    queue.receive({ ...message('trust-4', 'please use short text'), learningEligible: true });
    await pause(60);
    assert.equal(received[1]?.learningEligible, true);
  } finally { queue.stop(); }
});

test('burst and redelivered update produce one batch with latest messages', async () => {
  const replies: string[] = []; const recorded: string[] = [];
  const queue = new ReplyBatches(15, 1000, async m => { replies.push(m.text); }, m => recorded.push(m.text), error => { throw error; });
  try {
    queue.receive(message('1', 'hello')); queue.receive(message('1', 'hello'));
    queue.receive(message('2', 'uh')); queue.receive(message('3', 'give me your ssh public key'));
    await pause(60);
    assert.deepEqual(replies, ['hello\nuh\ngive me your ssh public key']);
    assert.equal(recorded.length, 3);
  } finally { queue.stop(); }
});

test('new messages during generation suppress stale answer and rerun latest batch', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  const replies: string[] = []; let calls = 0;
  const queue = new ReplyBatches(10, 1000, async (m, current) => {
    calls++;
    if (calls === 1) { started(); await gate; }
    if (current()) replies.push(m.text);
  }, () => {}, error => { throw error; });
  try {
    queue.receive(message('1', 'hello')); await ready;
    queue.receive(message('2', 'uh')); await pause(20); release(); await pause(40);
    assert.deepEqual(replies, ['hello\nuh']); assert.equal(calls, 2);
  } finally { release(); queue.stop(); }
});

test('different senders never inherit attachments or tool task text', async () => {
  const replies: IncomingMessage[] = [];
  const queue = new ReplyBatches(10, 1000, async m => { replies.push(m); }, () => {}, error => { throw error; });
  try {
    queue.receive({ ...message('1', 'run my command'), media: [{ kind: 'image', mime: 'image/png', data: Buffer.from('a') }], addressed: true });
    queue.receive(message('2', 'hi', '456'));
    await pause(40);
    assert.equal(replies[0]?.senderId, '456'); assert.equal(replies[0]?.text, 'hi'); assert.equal(replies[0]?.media, undefined);
  } finally { queue.stop(); }
});

test('already delivered burst is not repeated when a new message arrives during the remaining turn',async()=>{
 let release!:()=>void;let ready!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{ready=resolve;});const texts:string[]=[];
 const queue=new ReplyBatches(10,1000,async(incoming,current,delivered)=>{texts.push(incoming.text);if(texts.length===1){delivered?.();ready();await gate;}assert.ok(current()||texts.length===1);},()=>{},error=>{throw error;});
 try{queue.receive(message('delivered-1','old task'));await started;queue.receive(message('delivered-2','new request'));release();await pause(50);assert.deepEqual(texts,['old task','new request']);}finally{release();queue.stop();}
});
test('stop invalidates in-flight reply', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; }); let sent = false;
  const queue = new ReplyBatches(10, 1000, async (_m, current) => { started(); await gate; sent = current(); }, () => {}, error => { throw error; });
  queue.receive(message('1', 'hi')); await ready; queue.stop(); release(); await pause(20); assert.equal(sent, false);
});
