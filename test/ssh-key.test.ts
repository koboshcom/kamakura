import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, statSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxPublicKey, sshKeyCommand } from '../src/ssh-key.js';
const exec = promisify(execFile);

test('SSH key generation persists, repairs public key, and returns only public material', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kamakura-ssh-'));
  const command = sshKeyCommand.replace('/workspace/.ssh', `${root}/.ssh`);
  const run = async () => { const result = await exec('bash', ['-c', command]); return { output: result.stdout, exitCode: 0, timedOut: false }; };
  try {
    const first = await sandboxPublicKey(run);
    assert.match(first.publicKey, /^ssh-ed25519 /);
    assert.doesNotMatch(first.publicKey, /PRIVATE/);
    const privateBefore = readFileSync(join(root, '.ssh/id_ed25519'));
    assert.equal(statSync(join(root, '.ssh')).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, '.ssh/id_ed25519')).mode & 0o777, 0o600);
    rmSync(join(root, '.ssh/id_ed25519.pub'));
    assert.deepEqual(await sandboxPublicKey(run), first);
    assert.deepEqual(readFileSync(join(root, '.ssh/id_ed25519')), privateBefore);
    assert.equal(readFileSync(join(root, '.ssh/id_ed25519.pub'), 'utf8').trim(), first.publicKey);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SSH generation refuses directory and key symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kamakura-ssh-'));
  try {
    const target = join(root, 'target'); mkdirSync(target); symlinkSync(target, join(root, '.ssh'));
    const command = sshKeyCommand.replace('/workspace/.ssh', `${root}/.ssh`);
    await assert.rejects(exec('bash', ['-c', command]));
    rmSync(join(root, '.ssh')); mkdirSync(join(root, '.ssh'));
    symlinkSync(join(target, 'private'), join(root, '.ssh/id_ed25519'));
    await assert.rejects(exec('bash', ['-c', command]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SSH errors never pass command output through', async () => {
  await assert.rejects(sandboxPublicKey(async () => ({ output: 'PRIVATE SECRET', exitCode: 1, timedOut: false })), error => {
    assert.doesNotMatch(String(error), /PRIVATE SECRET/); return true;
  });
});
