import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { BridgeTransport } from '../src/transports/bridge.ts';

test('HTTP bridge authenticates, authorizes, deduplicates, and claims replies once', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamakura-bridge-test-'));
  config.dataDir = dir;
  config.bridgeToken = 'a'.repeat(64);
  config.bridgePort = 47689;
  config.imessageAllowed = new Set(['iMessage;-;test@example.test']);
  const bridge = new BridgeTransport();
  let received = 0;
  try {
    await bridge.start(() => received++);
    const url = `http://127.0.0.1:${config.bridgePort}`;
    const headers = { Authorization: `Bearer ${config.bridgeToken}`, 'Content-Type':'application/json' };
    assert.equal((await fetch(`${url}/outgoing`)).status,401);
    const message = { chatId:'iMessage;-;test@example.test',id:'message-1',sender:'alice',text:'hi',isGroup:false,timestamp:Date.now() };
    assert.equal((await fetch(`${url}/incoming`,{ method:'POST',headers,body:JSON.stringify(message) })).status,204);
    assert.equal((await fetch(`${url}/incoming`,{ method:'POST',headers,body:JSON.stringify(message) })).status,204);
    assert.equal(received,1);
    assert.equal((await fetch(`${url}/incoming`,{ method:'POST',headers,body:JSON.stringify({...message,chatId:'unapproved'}) })).status,403);
    await bridge.send(message.chatId,'fish');
    const first = await (await fetch(`${url}/outgoing`,{ headers })).json() as unknown[];
    assert.equal(first.length,1);
    assert.deepEqual(await (await fetch(`${url}/outgoing`,{ headers })).json(),[]);
    await assert.rejects(bridge.send('unapproved','nope'));
  } finally { await bridge.stop(); rmSync(dir,{recursive:true,force:true}); }
});
