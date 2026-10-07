import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { collection, namespace, hash } from '../src/mongo.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FactsStore } from '../src/facts.ts';
import { Reminders } from '../src/reminders.ts';
import { jpeg, prepareMedia } from '../src/media.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

test('facts survive restart, isolate chats/users, and cannot select paths', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-test-'));
  try {
    const store = new FactsStore(dir);
    await store.update('chat-a','../../escape','likes fish');
    assert.deepEqual(await new FactsStore(dir).read('chat-a','../../escape'), ['likes fish']);
    assert.deepEqual(await store.read('chat-b','../../escape'), []);
    assert.deepEqual(await store.read('chat-a','other'), []);
    const rows = await (await collection('facts')).find({ ns: namespace(dir) }).toArray();
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.scope, /^[a-f0-9]{64}$/);
    assert.equal(rows[0]!._id, `${namespace(dir)}:${hash(JSON.stringify(['chat-a','../../escape']))}`);
    assert.deepEqual(rows[0]!.facts, ['likes fish']);
    assert.deepEqual(await store.update('chat-a','../../escape','likes fish',true), []);
  } finally { rmSync(dir,{ recursive:true,force:true }); }
});

test('persisted reminders isolate owners and fire once', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-test-'));
  const path = join(dir,'reminders.sqlite');
  let reminders = new Reminders(path);
  try {
    await reminders.ready();
    const id = await reminders.schedule('whatsapp','group','alice','get fish',Date.now()+1100);
    assert.equal(await reminders.cancel('group','bob',id),false);
    assert.equal((await reminders.list('group','bob')).length,0);
    await reminders.close();
    reminders = new Reminders(path);
    assert.equal((await reminders.list('group','alice')).length,1);
    let sent = 0;
    reminders.start(async item => { assert.equal(item.text,'get fish'); sent++; });
    await new Promise(r => setTimeout(r,2500));
    assert.equal(sent,1);
    assert.equal((await reminders.list('group','alice')).length,0);
    const buckets=await (await collection('reminders')).find({ns:namespace(dir),chat:'group'}).toArray();
    assert.equal(buckets.length,1);assert.equal(buckets[0]!.items[0].state,'sent');
    await assert.rejects(() => reminders.schedule('whatsapp','group','alice','bad',Date.now()-1));
  } finally { await reminders.close(); rmSync(dir,{ recursive:true,force:true }); }
});

test('silent video yields bounded frames without a transcription call', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-video-test-'));
  try {
    const path = join(dir,'clip.mp4');
    await promisify(execFile)('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','color=c=blue:s=64x64:r=5','-t','2','-an',path]);
    const media = await prepareMedia([{kind:'video',mime:'video/mp4',data:readFileSync(path)}]);
    assert.equal(media.images.length,2);
    assert.match(media.text,/first 20 seconds only/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('incoming photo becomes a bounded JPEG', async () => {
  const png = await sharp({ create: { width:1600,height:900,channels:3,background:'red' } }).png().toBuffer();
  const converted = await jpeg({ kind:'image',mime:'image/png',data:png });
  const meta = await sharp(converted).metadata();
  assert.equal(meta.format,'jpeg');
  assert.equal(meta.width,1280);
});
