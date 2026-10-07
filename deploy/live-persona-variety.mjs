// Run in the built core via stdin. Actual Responses calls, no Telegram sends.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-persona-'));
process.env.DATA_DIR = dir;
const { config } = await import('./dist/config.js');
const { think, reminders } = await import('./dist/brain.js');
const { lessons, reflectOwner } = await import('./dist/learning-runtime.js');
const { learningScope } = await import('./dist/learning.js');
const { sandboxes } = await import('./dist/sandbox.js');
const owners = ['6612253937', '7853500388'];
assert.deepEqual([...config.learning.owners].sort(), [...owners].sort());
assert.equal(config.reasoningEffort, 'medium');
const inputs = ['Howdy ho', 'Wsg', 'hello there', 'morning', 'hey again', 'yo', 'back again', 'salutations', 'good evening', 'hiya', 'hello', 'just passing through', 'hey', 'got a minute', 'hi again'];
const pictograph = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/gu;
const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ');
try {
  await Promise.all(owners.map(async owner => {
    const incoming = { transport: 'telegram', chatId: owner, senderId: owner, sender: 'live test', id: 'variety', text: '', isGroup: false, addressed: true, learningEligible: false, timestamp: Date.now() };
    // Deliberately bad old style must not be imitated by the corrected model.
    const history = [{ role: 'user', sender: 'live test', text: 'Howdy ho', at: 0 }, { role: 'assistant', text: 'howdy ho 😴', at: 0 }, { role: 'user', sender: 'live test', text: 'Wsg', at: 0 }, { role: 'assistant', text: 'wsg. still half asleep over here 😴', at: 0 }];
    let emojiMessages = 0; let personaLines = 0; const symbols = new Set(); const answers = [];
    for (const text of inputs) {
      incoming.text = text;
      const answer = await think(history, incoming);
      const clean = normalize(answer);
      const source = normalize(text);
      assert.ok(answer.trim() && !answer.includes('<skip>'));
      assert.ok(clean !== source && !clean.startsWith(source + ' '), `echo for ${owner}: ${JSON.stringify(answer)}`);
      assert.doesNotMatch(answer, /how can i help|let me know|half asleep over here/i);
      const emoji = answer.match(pictograph) ?? [];
      if (emoji.length) {
        emojiMessages++;
        assert.ok(!history.filter(item => item.role === 'assistant').slice(-14).some(item => (item.text.match(pictograph) ?? []).length), 'emoji spacing');
        for (const symbol of new Set(emoji)) { assert.ok(!symbols.has(symbol), 'repeated emoji signature'); symbols.add(symbol); }
      }
      if (/sleep|sleepy|asleep|nap|judg|shrine/i.test(answer)) personaLines++;
      history.push({ role: 'user', sender: 'live test', text, at: Date.now() }, { role: 'assistant', text: answer, at: Date.now() });
      answers.push(answer);
      console.log('Response', owner, JSON.stringify(text), JSON.stringify(answer));
    }
    assert.ok(emojiMessages <= 1, 'emoji frequency');
    assert.ok(personaLines <= 2, 'recurring persona motif');
    assert.ok(new Set(answers.map(normalize)).size >= 10, 'fresh reply variety');
    console.log('PASS 15 actual medium-effort greetings with bad prior history, no echoes, rare emoji, varied replies', owner);
    for (const text of ['Howdy ho', 'Wsg', '😴']) await reflectOwner({ ...incoming, learningEligible: true, text });
    assert.deepEqual(await lessons.list(learningScope(incoming)), []);
    await reflectOwner({ ...incoming, learningEligible: true, text: 'Please remember I prefer concise replies.' });
    assert.ok((await lessons.list(learningScope(incoming))).some(lesson => /prefer concise replies/.test(lesson.text)));
    console.log('PASS actual reflection ignores greeting/emoji snippets but retains explicit teaching', owner);
  }));
} finally { await reminders.close(); sandboxes.stop(); await (await import('./dist/mongo.js')).closeMongo(); rmSync(dir, { recursive: true, force: true }); }
