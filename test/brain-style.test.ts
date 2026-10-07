import test from 'node:test';
import assert from 'node:assert/strict';
import { think, reminders } from '../src/brain.js';
import { config } from '../src/config.js';
import { parseReply } from '../src/reply.js';

test('each real SDK request ends with style reminder and low text verbosity including after tools', async () => {
  const original = globalThis.fetch; const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key'; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text.verbosity, 'low');
    assert.equal(body.reasoning.effort, config.reasoningEffort);
    const last = body.input.at(-1);
    assert.ok(['system','developer'].includes(last.role));
    assert.match(JSON.stringify(last), /No em dashes/);
    assert.match(JSON.stringify(last), /Use no emoji or emoji reaction tag this turn/);
    assert.match(JSON.stringify(last), /not an echo/);
    assert.match(JSON.stringify(last), /Old assistant replies are context/);
    assert.match(JSON.stringify(last), /prioritize banter over usefulness/);
    assert.match(JSON.stringify(last), /Genuine distress is not a roast invitation/);
    calls++;
    const output = calls === 1
      ? [{ type:'function_call', id:'fc_1', call_id:'call_1', name:'list_reminders', arguments:'{}', status:'completed' }]
      : [{ type:'message', id:'msg_1', role:'assistant', status:'completed', content:[{type:'output_text', text:'hey\n\nyou again.', annotations:[]}] }];
    return new Response(JSON.stringify({id:'resp_test',created_at:1,model:config.model,status:'completed',output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'content-type':'application/json'}});
  };
  try {
    assert.equal(await think([], {transport:'telegram',chatId:'style-test',senderId:'style-test',sender:'owner',id:'1',text:'hey',isGroup:false,timestamp:0}), 'hey\n\nyou again.');
    assert.equal(calls,2);
  } finally { globalThis.fetch=original; if(key===undefined) delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key; await reminders.close(); }
});
test('chat cleanup caps four bubbles and preserves fenced technical output', () => {
  assert.deepEqual(parseReply('hey—there.\n\na.\n\nb.\n\nc.\n\nd.',10,100).messages,['hey, there','a','b','c']);
  assert.deepEqual(parseReply('```\nx—y.\n```',4,100).messages,['```\nx—y.\n```']);
});
