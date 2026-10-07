// Real deployed model and think pipeline, captured delivery. No Telegram sends,
// no local device pairing or worker jobs. Uses an isolated history namespace.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-capabilities-live-'));
process.env.DATA_DIR = dir;
const { think, reminders } = await import('./dist/brain.js');
const { config } = await import('./dist/config.js');
const { HistoryStore } = await import('./dist/history.js');
const { sandboxes } = await import('./dist/sandbox.js');
const { startWorkers, stopWorkers } = await import('./dist/worker.js');
const { desktopAccess } = await import('./dist/desktop-service.js');
const { stopLearning } = await import('./dist/learning-runtime.js');
const { closeMongo, collection, namespace } = await import('./dist/mongo.js');
const history = new HistoryStore(dir, 30);
startWorkers(async () => { throw new Error('Fixture must not start a worker'); });
const previous = [
  { role: 'user', text: 'you got a pc?', at: 1 },
  { role: 'assistant', text: 'no vm, no vnc or browser session, just this chat. the strict no-kittens policy.', at: 2 },
];
try {
  for (const owner of ['6612253937', '7853500388']) {
    const prompts = [
      ['you got a pc?', /(?:linux|container|sandbox|virtual|box|desktop)/i],
      ['vm?', /(?:linux|container|sandbox|virtual|box|desktop)/i],
      ['vnc/browser?', /(?:vnc|browser|chromium|desktop|link)/i],
      ['can you use kittens to work on stuff?', /(?:worker|kitten|delegate|background|task)/i],
      ['send me your vnc desktop link', /https:\/\//i],
    ];
    let turn = 0;
    for (const [text, evidence] of prompts) {
      const incoming = { transport: 'telegram', chatId: owner, senderId: owner, sender: 'owner', id: String(93000 + ++turn), text, isGroup: false, addressed: true, timestamp: Date.now(), credentialEligible: true, learningEligible: false };
      const sent = [];
      await think(previous, incoming, undefined, undefined, { history, delivery: { current: () => true, send: async text => { sent.push(text); }, react: async () => {} } });
      const reply = sent.join('\n');
      assert.ok(reply.trim(), 'capability question must receive a delivered answer');
      assert.match(reply, evidence, 'answer must acknowledge the actual relevant capability');
      const currentClaims = reply.replace(/[“"][^”"\n]*[”"]/g, ''); // Quoting an old denial to correct it is not a current denial.
      assert.doesNotMatch(currentClaims, /(?:just|only) (?:this |a |the )?(?:chat|text)|no (?:vm|vnc|browser|computer|desktop)|(?:no[- ]kittens|strict .*policy)|(?:can(?:not|'t|’t)|don(?:'t|’t)) (?:have|use|spawn|start|access|run) (?:a |any |the |my )?(?:computer|desktop|browser|vm|worker|kitten)/i, 'must not repeat false old denials or invent worker refusals');
      if (turn === prompts.length) {
        const links = reply.match(/https:\/\/[^\s<>"'`]+\/[a-f0-9]{64}/g) ?? [];
        assert.equal(links.length, 1, 'actual model must issue and deliver one fresh link');
        assert.equal(new URL(links[0]).origin, new URL(config.desktopPublicBaseUrl).origin);
        desktopAccess.revokeOwner(owner);
        console.log('PASS actual model issued and delivered private desktop link', owner);
      } else {
        console.log('PASS actual model capability answer', owner, JSON.stringify(text), JSON.stringify(reply));
      }
    }
  }
} finally {
  stopWorkers(); desktopAccess?.close(); stopLearning(); await reminders.close(); sandboxes.stop();
  for (const name of ['history', 'facts', 'context_summaries', 'learning']) await (await collection(name)).deleteMany({ ns: namespace(dir) });
  await closeMongo(); rmSync(dir, { recursive: true, force: true });
}
