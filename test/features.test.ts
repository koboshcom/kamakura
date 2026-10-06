import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FactsStore } from '../src/facts.ts';
import { Reminders } from '../src/reminders.ts';
import { jpeg } from '../src/media.ts';

test('facts survive restart, isolate chats/users, and cannot select paths', () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-test-'));
  try {
    const store = new FactsStore(dir);
    store.update('chat-a','../../escape','likes fish');
    assert.deepEqual(new FactsStore(dir).read('chat-a','../../escape'), ['likes fish']);
    assert.deepEqual(store.read('chat-b','../../escape'), []);
    assert.deepEqual(store.read('chat-a','other'), []);
    assert.match(readdirSync(dir)[0]!, /^[a-f0-9]{64}\.json$/);
    assert.deepEqual(store.update('chat-a','../../escape','likes fish',true), []);
  } finally { rmSync(dir,{ recursive:true,force:true }); }
});

test('persisted reminders isolate owners and fire once', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-test-'));
  const path = join(dir,'reminders.sqlite');
  let reminders = new Reminders(path);
  try {
    const id = reminders.schedule('whatsapp','group','alice','get fish',Date.now()+1100);
    assert.equal(reminders.cancel('group','bob',id),false);
    assert.equal(reminders.list('group','bob').length,0);
    reminders.close();
    reminders = new Reminders(path);
    assert.equal(reminders.list('group','alice').length,1);
    let sent = 0;
    reminders.start(async item => { assert.equal(item.text,'get fish'); sent++; });
    await new Promise(r => setTimeout(r,2500));
    assert.equal(sent,1);
    assert.equal(reminders.list('group','alice').length,0);
    assert.throws(() => reminders.schedule('whatsapp','group','alice','bad',Date.now()-1));
  } finally { reminders.close(); rmSync(dir,{ recursive:true,force:true }); }
});

test('incoming photo becomes a bounded JPEG', async () => {
  const png = await sharp({ create: { width:1600,height:900,channels:3,background:'red' } }).png().toBuffer();
  const converted = await jpeg({ kind:'image',mime:'image/png',data:png });
  const meta = await sharp(converted).metadata();
  assert.equal(meta.format,'jpeg');
  assert.equal(meta.width,1280);
});
