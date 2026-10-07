import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';

test('shared main and worker persona explicitly describes work-only persistence', () => {
  const persona = readFileSync(config.persona, 'utf8');
  assert.match(persona, /Only \/work in your box is persistent/);
  assert.match(persona, /\/usr, \/var, \/etc and home directories outside \/work, can be lost when the box is rebuilt/);
  assert.match(persona, /Keep important data and application state in \/work/);
  const paragraph = persona.split('\n').find(line => line.includes('Only /work in your box'))!;
  assert.doesNotMatch(paragraph, /tailscale/i);
  for (const source of ['src/brain.ts', 'src/worker.ts']) assert.match(readFileSync(source, 'utf8'), /readFileSync\(config\.persona/);
});
