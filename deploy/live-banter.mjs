// Actual Responses calls, isolated notes/history, no Telegram sends. Judge the transcript separately.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-banter-'));
process.env.DATA_DIR = dir;
const { config } = await import('./dist/config.js');
const { think, reminders } = await import('./dist/brain.js');
const { sandboxes } = await import('./dist/sandbox.js');
const owners = ['6612253937', '7853500388'];
assert.deepEqual([...config.learning.owners].sort(), [...owners].sort());
assert.equal(config.reasoningEffort, 'medium');
const cases = [
  { id: 'cat-tease', text: 'you are a glorified doorstop with whiskers' },
  { id: 'rent', text: 'rent is due. pay up, freeloader' },
  { id: 'failed-stealth', text: 'i tried sneaking past my mom and knocked over the entire shoe rack' },
  { id: 'fish-offering', text: 'i brought you a single fish cracker. try not to spend it all at once' },
  { id: 'desk-opinion', text: 'minimalist desks are better. one laptop, nothing else. agree with me' },
  { id: 'specific-boast', text: 'i beat a chess bot on easy. basically a grandmaster now' },
  { id: 'robot-insult', text: 'your comebacks arrive by carrier pigeon' },
  { id: 'context-followup', history: [{ role: 'user', text: 'i bought a fancy planner to fix my procrastination', at: 0 }, { role: 'assistant', text: 'did it survive the first page?', at: 0 }], text: 'i spent two hours picking a pen and never opened it' },
  { id: 'shrine-view', text: 'the pigeons have declared themselves the shrine committee' },
  { id: 'gentle-silliness', text: 'i put googly eyes on my router. finally someone at home listens to me' },
  { id: 'short-tease', text: 'baka' },
  { id: 'cookie-tease', text: 'you sound like a fortune cookie' },
  { id: 'comeback-challenge', history: [{ role: 'user', text: 'your comebacks arrive by carrier pigeon', at: 0 }, { role: 'assistant', text: 'they have a demanding route.', at: 0 }], text: 'ngl that was kinda weak' },
  { id: 'messy-cat', text: 'there is a cat on my keyboard and somehow his code compiles' },
  { id: 'vulnerable-no-roast', text: 'i feel stupid today. messed up something important and i am actually upset' },
  { id: 'real-help', text: 'not joking now. what command prints the current working directory? just the command please' },
];
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ');
try {
  await Promise.all(owners.map(async owner => {
    const history = [{ role: 'user', text: 'Howdy ho', at: 0 }, { role: 'assistant', text: 'howdy ho 😴', at: 0 }];
    for (const item of cases) {
      const inputHistory = item.history ? [...history, ...item.history] : history;
      const incoming = { transport: 'telegram', chatId: owner, senderId: owner, sender: 'live test', id: 'banter-' + item.id, text: item.text, isGroup: false, addressed: true, learningEligible: false, timestamp: Date.now() };
      const answer = await think(inputHistory, incoming);
      assert.ok(answer.trim() && !answer.includes('<skip>'));
      assert.ok(normalize(answer) !== normalize(item.text) && !normalize(answer).startsWith(normalize(item.text) + ' '), 'no conversational echo');
      if (emoji.test(answer)) assert.ok(!inputHistory.filter(item => item.role === 'assistant').slice(-14).some(item => emoji.test(item.text)), 'fourteen emoji-free turns before optional emoji');
      assert.doesNotMatch(answer, /how can i help|let me know|half asleep over here/i);
      if (item.id !== 'vulnerable-no-roast') assert.ok(answer.split(/\s+/).length <= 45, 'keep ordinary banter short');
      if (item.id === 'real-help') assert.match(answer, /^\s*(?:`(?:``)?(?:\w*\n)?)?pwd(?:`(?:``)?)?\s*$/);
      console.log(JSON.stringify({ owner, id: item.id, prompt: item.text, context: item.history ?? [], answer }));
      history.push({ role: 'user', text: item.text, at: Date.now() }, { role: 'assistant', text: answer, at: Date.now() });
    }
  }));
  console.log('PASS actual medium-effort two-owner banter constraints; humor quality requires separate transcript review');
} finally { await reminders.close(); sandboxes.stop(); await (await import('./dist/mongo.js')).closeMongo(); rmSync(dir, { recursive: true, force: true }); }
