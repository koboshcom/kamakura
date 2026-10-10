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
