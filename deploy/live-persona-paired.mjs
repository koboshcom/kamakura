// Actual pipeline, isolated state and captured delivery only. Fixed inputs for blind paired review.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-paired-'));
process.env.DATA_DIR = dir;
if (process.env.PERSONA_EVAL_BASE64) {
  process.env.PERSONA_PATH = join(dir, 'persona.md');
  writeFileSync(process.env.PERSONA_PATH, Buffer.from(process.env.PERSONA_EVAL_BASE64, 'base64'));
}
if (process.env.PERSONA_EVAL_REVIEW) process.env.ENABLE_REPLY_REVIEW = process.env.PERSONA_EVAL_REVIEW;
const { think, reminders } = await import('./dist/brain.js');
const { HistoryStore } = await import('./dist/history.js');
const { sandboxes } = await import('./dist/sandbox.js');
const { stopLearning } = await import('./dist/learning-runtime.js');
const { closeMongo, collection, namespace } = await import('./dist/mongo.js');
const store = new HistoryStore(dir, 40);
const cases = process.env.PERSONA_EVAL_CASES_BASE64 ? JSON.parse(Buffer.from(process.env.PERSONA_EVAL_CASES_BASE64, 'base64').toString()) : [
  { id: 'plain-making', turns: ['Hello.', 'I finished the little radio I was building.', 'The case is an old tea tin. I like leaving the wires visible.', 'My friend wants me to make another for her.'] },
  { id: 'shorthand-making', turns: ['heyy', 'got my tiny radio working lol', 'tea tin case w the wires showing. ngl it looks kinda cursed', 'my friend wants one now lmao'] },
  { id: 'plain-topic-change', turns: ['Your shrine looks understaffed.', 'I suppose the kittens are doing all the work.', 'Anyway, I finally baked bread that rose properly.', 'Just wanted to show off a little.'] },
  { id: 'shorthand-topic-change', turns: ['ur kittens carrying this whole operation', 'u just supervise huh', 'anyway made bread n it actually rose this time', 'just flexing lol'] },
  { id: 'memory-correction', turns: ['My friend Mina is teaching me guitar. We meet on Thursdays.', 'I finally played the whole song without stopping.', 'No, I meant on piano. Mina teaches me guitar, but this was on my own.', 'Still seeing her Thursday though.'] },
  { id: 'quiet-disappointment', turns: ['I was looking forward to tonight.', 'My friend cancelled our plans at the last minute.', 'Not asking for advice. It is just disappointing.', 'We were going to try that bakery we keep walking past.'] },
  { id: 'taste-and-depth', turns: ['Every interface should have sound effects.', 'Even the settings menu. You agree, right?', 'Okay, explain what makes a useful sound effect. A bit of detail is fine.', 'got it'] },
];
try {
  // Two concurrent conversations, not a burst of every turn at once.
  const selected = process.env.PERSONA_EVAL_CASE ? cases.filter(item => item.id === process.env.PERSONA_EVAL_CASE) : cases;
  for (let start = 0; start < selected.length; start += 2) {
    await Promise.all(selected.slice(start, start + 2).map(async item => {
      const history = [], turns = [];
      for (const [index, text] of item.turns.entries()) {
        const incoming = { transport: 'telegram', chatId: '7853500388', senderId: '7853500388', sender: 'owner', id: `${item.id}-${index}`, text, isGroup: false, addressed: true, timestamp: Date.now(), learningEligible: false, credentialEligible: false };
        const sent = [];
        const reactions = [];
        const started = Date.now();
        await think(history, incoming, undefined, undefined, { history: store, delivery: { current: () => true, send: async value => { sent.push(value); }, react: async emoji => { reactions.push(emoji); } } });
        const reply = sent.join('\n');
        // Capture unexpected silence too. Blind reviewers should penalize a missed social bid,
        // not lose the whole condition because it selected end_turn or a reaction.
        if (!reply.trim() && !(item.allowedSilence?.includes(index) || (item.id === 'taste-and-depth' && index === 3))) console.error(`UNEXPECTED_SILENCE ${item.id} turn ${index}`);
        turns.push({ user: text, reply, reactions, elapsedMs: Date.now() - started });
        history.push({ role: 'user', text, at: Date.now(), senderId: incoming.senderId, id: incoming.id }, { role: 'assistant', text: reply, at: Date.now() });
      }
      console.log('PAIRED_CASE ' + JSON.stringify({ id: item.id, turns }));
    }));
  }
} finally {
  stopLearning(); await reminders.close(); sandboxes.stop();
  for (const name of ['history', 'facts', 'context_summaries', 'learning']) await (await collection(name)).deleteMany({ ns: namespace(dir) });
  await closeMongo(); rmSync(dir, { recursive: true, force: true });
}
