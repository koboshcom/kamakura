import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { collection, namespace } from '../src/mongo.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialValues, captureCredentials, redactCredentials } from '../src/credentials.js';
import { HistoryStore } from '../src/history.js';
import { FactsStore } from '../src/facts.js';
import { telegramText, entityParseFailure } from '../src/telegram-format.js';
import { taskProgress } from '../src/task-progress.js';
import { tool } from 'ai';
import { z } from 'zod';
import { TelegramTransport } from '../src/transports/telegram.js';

test('credentials stay in the current request, never retained history or facts', async () => {
 const dir=mkdtempSync(join(tmpdir(),'credential-test-'));
 const key='tskey-auth-unitdummy0123456789';
 try {
  const store=new HistoryStore(dir,20);
  await store.add('a',{role:'user',text:`join using ${key}`,at:0});
  assert.ok(!(await store.get('a'))[0]!.text.includes(key));
  const rows=await (await collection('history')).find({ns:namespace(dir)}).toArray();
  assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(key));
  assert.ok(!(await new HistoryStore(dir,20).get('a'))[0]!.text.includes(key));
  await assert.rejects(()=>new FactsStore(join(dir,'facts')).update('a','u',key));
  assert.equal(await (await collection('facts')).countDocuments({ns:namespace(join(dir,'facts'))}),0);
  assert.deepEqual(credentialValues(key),[key]);
  captureCredentials('auth key: shortdummykey');
  assert.equal(redactCredentials('shortdummykey'),'[credential redacted]');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('Markdown is converted into Telegram entities with UTF16 offsets and safe URLs', () => {
 const result=telegramText('🙂 **hi** [a & b](https://example.com/path?q=yes&utm_source=openai) `x_y` — fine');
 assert.equal(result.text,'🙂 hi a & b x_y ,  fine');
 const entity=result.entities.find(e=>e.type==='text_link')!;
 assert.equal(result.text.slice(entity.offset,entity.offset+entity.length),'a & b');
 assert.equal(entity.type==='text_link'&&entity.url,'https://example.com/path?q=yes');
 assert.equal(result.entities.find(e=>e.type==='bold')!.offset,3);
 assert.ok(!result.plain.includes('[a & b]('));
 assert.ok(!result.plain.includes('utm_source'));
 assert.ok(!telegramText('[x](javascript:alert(1))').entities.some(e=>e.type==='text_link'));
 assert.ok(entityParseFailure({error_code:400,description:"Bad Request: can't parse entities"}));
 assert.ok(!entityParseFailure({error_code:429,description:'rate limit'}));
});
test('tracking query cleaning preserves parsed Markdown link delimiters in any order',()=>{
 const result=telegramText('[docs](https://example.test/?utm_source=openai&q=x)');
 assert.equal(result.text,'docs');assert.equal(result.entities.find(entity=>entity.type==='text_link')?.url,'https://example.test/?q=x');
});
test('ack delivery precedes execution even when calls arrive in parallel', async () => {
 const events:string[]=[];
 const progress=taskProgress(async text=>{await new Promise(r=>setTimeout(r,20));events.push(text);},()=>false,undefined,true);
 const guarded=progress.guard({work:tool({inputSchema:z.object({}),execute:async()=>{events.push('work');return 'done';}})});
 const options={toolCallId:'test',messages:[]};
 await assert.rejects(()=>guarded.work.execute!({},options) as Promise<unknown>,/announce_task/);
 await Promise.all([progress.tools.announce_task!.execute!({text:'checking the setup'},options),guarded.work.execute!({},options)]);
 assert.deepEqual(events,['checking the setup','work']);
});
test('Telegram format fallback retries only definite entity rejection, not uncertain network sends',async()=>{
 const transport=new TelegramTransport('123456789:test_token');
 let calls=0;let plain='';
 transport.bot.api.sendMessage=async (_chat,text,other)=>{
  calls++;
  if(other?.entities?.length) throw {error_code:400,description:"Bad Request: can't parse entities"};
  plain=text;return {} as never;
 };
 await transport.send('1','[docs](https://example.com/?utm_source=openai)');
 assert.equal(calls,2);assert.equal(plain,'docs\nhttps://example.com/');
 calls=0;transport.bot.api.sendMessage=async()=>{calls++;throw new Error('network');};
 await assert.rejects(()=>transport.send('1','[docs](https://example.com/)'));
 assert.equal(calls,1);
});
