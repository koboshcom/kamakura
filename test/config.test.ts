import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReasoningEffort } from '../src/config.js';
import { execFileSync } from 'node:child_process';

function readConfig(overrides: Record<string, string> = {}) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/nonexistent-kamakura-test', ...overrides };
  for (const key of ['OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'OPENAI_WORKER_EFFORT']) if (!(key in overrides)) delete env[key];
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const {config} = await import('./src/config.ts'); console.log(JSON.stringify([config.model,config.reasoningEffort,config.workerEffort]))"], { env, encoding: 'utf8' }));
}

test('chat and worker defaults and environment overrides are independent', () => {
  assert.deepEqual(readConfig(), ['gpt-6-luna', 'low', 'high']);
  assert.deepEqual(readConfig({ OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: 'medium', OPENAI_WORKER_EFFORT: 'max' }), ['test-model', 'medium', 'max']);
  assert.throws(() => parseReasoningEffort('invalid', 'OPENAI_WORKER_EFFORT'), /OPENAI_WORKER_EFFORT/);
});

test('reasoning effort defaults to low and accepts all configured levels', () => {
  assert.equal(parseReasoningEffort(), 'low');
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(parseReasoningEffort(effort), effort);
    assert.equal(parseReasoningEffort(effort, 'OPENAI_WORKER_EFFORT'), effort);
  }
});

test('invalid or empty reasoning effort fails closed', () => {
  for (const effort of ['', 'HIGH', 'minimal', 'invalid']) {
    assert.throws(() => parseReasoningEffort(effort), /OPENAI_REASONING_EFFORT/);
  }
});

test('removed global container limit ignores legacy environment values', () => {
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/nonexistent-kamakura-test', SANDBOX_MAX_CONTAINERS: 'invalid' };
  const value = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const {config} = await import('./src/config.ts'); console.log('maxContainers' in config.sandbox)"], { env, encoding: 'utf8' });
  assert.equal(value.trim(), 'false');
});
