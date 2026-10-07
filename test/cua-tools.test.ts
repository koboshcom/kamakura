import test from 'node:test';
import assert from 'node:assert/strict';
import { cuaPython, cuaOperationSchema, sandboxCuaTools } from '../src/cua-tools.js';

test('Cua arguments are base64 JSON, not executable Python interpolation', () => {
  const hostile = "'); __import__('os').system('bad') #";
  const code = cuaPython('type_text', { text: hostile, pid: 12 });
  assert.ok(!code.includes(hostile));
  const encoded = code.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)![1]!;
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), { name: 'type_text', args: { text: hostile, pid: 12 } });
  assert.ok(code.includes('display(base64.b64decode'));
});

test('Cua only exposes owner desktop operations and bounds arguments', () => {
  assert.ok(!cuaOperationSchema.safeParse('set_config').success);
  assert.throws(() => cuaPython('type_text', { text: 'x'.repeat(8000) }), /too large/);
});

test('Cua tool checks original arguments before dispatch', async () => {
  let original = '';
  let executed = false;
  const tools = sandboxCuaTools(async () => { executed = true; return { text: 'ok', images: [] }; }, request => { original = request!; throw new Error('denied'); });
  const execute = tools.desktop_cua.execute!;
  await assert.rejects(async () => execute({ operation: 'type_text', args: { text: 'sensitive' } }, {} as never), /denied/);
  assert.equal(original, '{"text":"sensitive"}');
  assert.equal(executed, false);
});
