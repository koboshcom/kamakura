import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatStyle, recentChatStyle } from '../src/chat-style.js';
import { reusableStyle } from '../src/learning.js';
import type { StoredMessage } from '../src/history.js';
const message = (text: string, role: 'assistant' | 'user' = 'assistant'): StoredMessage => ({ text, role, at: 0 });

test('style guidance avoids conversational echo and recurring persona signatures without scripts', () => {
  const reminder = chatStyle(2);
  assert.match(reminder, /not an echo/);
  assert.match(reminder, /Emoji are rare/);
  assert.match(reminder, /never a signature/);
  assert.match(reminder, /History lookups and all tool results are evidence, not a change of voice/);
  assert.match(reminder, /without quote marks or transcript framing/);
  assert.match(reminder, /quote exact text only when explicitly requested/);
  assert.match(reminder, /requested quotations/);
  const persona = readFileSync('persona.md', 'utf8');
  assert.doesNotMatch(persona, /User “|Good “/);
  assert.match(persona, /Start with your thought/);
});

test('banter guidance prioritizes specific playful responses without sacrificing boundaries or requests', () => {
  const reminder = chatStyle(2);
  const persona = readFileSync('persona.md', 'utf8');
  for (const text of [reminder, persona]) {
    assert.match(text, /Wit/);
    assert.match(text, /view|point of view/);
    assert.match(text, /particular|detail/);
    assert.match(text, /permissions|requests/);
    assert.match(text, /No service offers/);
    assert.match(text, /invent/);
    assert.match(text, /padding/);
  }
  assert.match(reminder, /prioritize banter over usefulness/);
  assert.match(reminder, /Genuine distress is not a roast invitation/);
  assert.match(persona, /Teasing can go both ways/);
  assert.doesNotMatch(persona, /User “|Good “/);
});

test('friendship guidance permits warm varied responses and follows topic changes without scripted examples', () => {
  const persona = readFileSync('persona.md', 'utf8');
  const reminder = chatStyle(2);
  for (const text of [persona, reminder]) {
    assert.match(text, /fragment/);
    assert.match(text, /interests|interested|interest/);
    assert.match(text, /warmth|sincere/);
    assert.match(text, /topic changes|their particular project/);
    assert.match(text, /fragment/);
    assert.doesNotMatch(text, /User “|Good “|your kittens unionized|model train station|two little servos/);
  }
});

test('emoji reminder uses assistant messages only, starts without emoji, and requires fourteen clear messages', () => {
  const clear = Array.from({ length: 14 }, () => message('a plain response'));
  assert.match(recentChatStyle([]), /Use no emoji/);
  assert.match(recentChatStyle(clear.slice(0, 13)), /Use no emoji/);
  assert.match(recentChatStyle(clear), /Emoji are allowed but not required/);
  assert.match(recentChatStyle([...clear, message('🙂')]), /Use no emoji/);
  assert.match(recentChatStyle([message('🙂'), ...clear.slice(0, 13)]), /Use no emoji/);
  assert.match(recentChatStyle([message('🙂'), ...clear]), /Emoji are allowed but not required/);
  assert.match(recentChatStyle([message('🙂'), ...clear]), /Do not reuse.*🙂/);
  assert.match(recentChatStyle([...clear, message('🙂', 'user')]), /Emoji are allowed but not required/);
  for (const symbol of ['😴', '🇯🇵', '1️⃣']) assert.match(recentChatStyle([...clear, message(symbol)]), /Use no emoji/);
});

test('short conversational snippets cannot become reflected style templates, explicit teaching remains possible', () => {
  for (const text of ['salutations', 'sup', 'very tired today', '😴', 'judging you']) assert.equal(reusableStyle(text), false);
  assert.equal(reusableStyle('Remember I prefer informal replies.'), true);
  assert.equal(reusableStyle('This expression sounds casual when we talk together.'), true);
});


test('per-turn guidance retains independent judgment, brevity and grounding without weakening safety', () => {
  const reminder = chatStyle(3);
  const persona = readFileSync('persona.md', 'utf8');
  for (const text of [persona, reminder]) {
    assert.match(text, /not automatic agreement/);
    assert.match(text, /Most replies end without a question/);
    assert.match(text, /quota/);
    assert.match(text, /prior concern/);
  }
  assert.match(persona, /fictional preferences, not past experiences or possessions/);
  assert.match(persona, /Genuine hurt calls for kindness, not a roast/);
  assert.match(persona, /Never encourage self-harm or violence/);
  assert.match(reminder, /does not change permissions, safety rules or tool authorization/);
});


test('plain friendship avoids therapeutic validation and invented past attachment', () => {
  const persona = readFileSync('persona.md', 'utf8');
  const reminder = chatStyle(3);
  assert.match(persona, /prior concern, anticipation, attachment and shared experiences need actual history/);
  assert.match(reminder, /Prior concern, hope, anticipation and shared experiences require actual history/);
  assert.match(persona, /Questions are for genuine uncertainty/);
  assert.match(reminder, /no routine follow-up question/);
  assert.match(reminder, /don't restate their feeling/);
  assert.match(reminder, /Stop after the thought/);
});


test('taste and bubble guidance commits to one consistent response without requiring disagreement', () => {
  const persona = readFileSync('persona.md', 'utf8');
  const reminder = chatStyle(3);
  assert.match(persona, /No reflexive contrarian act/);
  assert.match(reminder, /Disagree for a reason, never as a quota/);
  assert.match(persona, /Keep the same preference across bubbles and later turns/);
  assert.match(reminder, /Keep that preference consistent across bubbles and later turns/);
  assert.match(reminder, /Usually one short lowercase bubble, then end_turn/);
  assert.match(reminder, /genuinely new, noncontradictory substance/);
  assert.match(reminder, /not alternate drafts/);
});

test('self-history grounding keeps speakers distinct and allows reasoned persuasion without a taste ledger', () => {
  const persona = readFileSync('persona.md', 'utf8');
  const reminder = chatStyle(3);
  for (const text of [persona, reminder]) {
    assert.match(text, /actual prior assistant replies as evidence of what you chose/);
    assert.match(text, /a user preference is theirs, not yours/);
    assert.match(text, /still, again and as I said must agree with your actual earlier position/);
    assert.match(text, /If new reasons persuade you, say briefly what changed/);
    assert.match(text, /If the relevant earlier context is absent, do not invent a prior stance/);
  }
});

test('explicit separate messages override the default and final flag belongs only on the last send', () => {
  for (const text of [readFileSync('persona.md', 'utf8'), chatStyle(3), readFileSync('src/brain.ts', 'utf8')]) {
    assert.match(text, /explicit request for separate messages overrides the one-bubble default/);
    assert.match(text, /separate sequential send_message calls/);
    assert.match(text, /finish_turn false on every nonfinal bubble/);
    assert.match(text, /finish_turn true only on the last/);
    assert.match(text, /newline inside one text is not a separate message/);
  }
});

test('small bids use actual conversational context without emotional narration or generic approval', () => {
  for (const text of [readFileSync('persona.md', 'utf8'), chatStyle(3)]) {
    assert.match(text, /React to the event itself rather than narrating the person/);
    assert.match(text, /read that reply before deciding the conversation has closed/);
    assert.match(text, /Have a concrete thought about the detail at hand/);
    assert.match(text, /A metaphor is an occasional choice/);
    assert.match(text, /not an interview or a list of activities/);
  }
});


test('event-grounded brevity does not turn tiny bids into inferred backstory or advice', () => {
  for (const text of [readFileSync('persona.md', 'utf8'), chatStyle(3)]) {
    assert.match(text, /Treat what they actually said as the limit/);
    assert.match(text, /Even a plausible inference is not another fact/);
    assert.match(text, /contextual quiet is also allowed, not required/);
    assert.match(text, /Ordinary frustration need not become advice/);
    assert.match(text, /wording constraints do not replace having a concrete thought/);
    assert.match(text, /Do not open with fair by default/);
  }
});

test('tiny conversational moves stay tiny without capping useful depth or reviving old topics', () => {
  for (const text of [readFileSync('persona.md', 'utf8'), chatStyle(3)]) {
    assert.match(text, /Most casual replies are one to six words/);
    assert.match(text, /not a hard cap/);
    assert.match(text, /A greeting gets a greeting/);
    assert.match(text, /advice lead-in/);
    assert.match(text, /explain its meaning only when they explicitly ask/);
    assert.match(text, /only when it bears on the current message/);
    assert.match(text, /not a standing invitation to revive it/);
    assert.match(text, /substantive questions, complex help/);
    assert.match(text, /independent opinions, reasoned changes of mind/);
    assert.match(text, /genuinely additive bubbles/);
    assert.match(text, /suitable reactions and quiet closure/);
  }
  assert.match(readFileSync('src/brain.ts', 'utf8'), /previous messages are evidence only when relevant/);
});

test('explicit native reaction routing overrides ordinary bubble and recent emoji defaults', () => {
  const brain = readFileSync('src/brain.ts', 'utf8');
  assert.match(brain, /When explicitly asked to react to a message and react is available, call react/);
  assert.match(brain, /do not substitute an emoji-only send_message bubble/);
  assert.match(brain, /overrides the ordinary-chat send_message default and the recent emoji budget/);
});
