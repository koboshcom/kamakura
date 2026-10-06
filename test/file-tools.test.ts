import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileToolCommand, sandboxFileCall, sandboxFileTools } from '../src/sandbox-files.js';
const exec = promisify(execFile);
const helper = resolve('deploy/file-tools.py');
const loader = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('files',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.ROOT=sys.argv[2]\ntry: print(json.dumps({'ok':True,'result':m.execute(json.loads(sys.argv[3]))}))\nexcept Exception as e: print(json.dumps({'ok':False,'error':str(e)}))`;

async function fixture(run: (root: string, call: (r: Record<string, unknown>) => Promise<any>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'kamakura-files-'));
  const call = async (request: Record<string, unknown>) => JSON.parse((await exec('python3', ['-c', loader, helper, root, JSON.stringify(request)])).stdout);
  try { await run(root, call); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('actual helper writes reads unique edits globs and literal grep', async () => fixture(async (root, call) => {
  mkdirSync(join(root, 'src'));
  assert.equal((await call({ op: 'write_file', path: 'src/a.ts', content: 'one\ntwo\n' })).ok, true);
  assert.equal((await call({ op: 'edit_file', path: '/work/src/a.ts', oldText: 'two', newText: 'three' })).ok, true);
  assert.equal((await call({ op: 'read_file', path: 'src/a.ts' })).result.text, 'one\nthree\n');
  assert.deepEqual((await call({ op: 'list_files', glob: '**/*.ts' })).result.matches, ['src/a.ts']);
  assert.equal((await call({ op: 'grep', query: 'three', glob: '**/*' })).result.matches[0].line, 2);
  writeFileSync(join(root, 'repeat'), 'x x');
  assert.equal((await call({ op: 'edit_file', path: 'repeat', oldText: 'x', newText: 'y' })).ok, false);
  assert.equal((await call({ op: 'edit_file', path: 'repeat', oldText: 'missing', newText: 'y' })).ok, false);
  assert.equal(readFileSync(join(root, 'repeat'), 'utf8'), 'x x');
}));

test('actual helper denies traversal absolute paths symlinks hardlinks and oversized files', async () => fixture(async (root, call) => {
  writeFileSync(join(root, 'target'), 'untouched');
  symlinkSync(join(root, 'target'), join(root, 'sym'));
  mkdirSync(join(root, 'folder')); symlinkSync(join(root, 'folder'), join(root, 'dirlink'));
  linkSync(join(root, 'target'), join(root, 'hard'));
  writeFileSync(join(root, 'large'), Buffer.alloc(262145));
  for (const path of ['../bad', '/etc/passwd', 'sym', 'hard', 'dirlink/new', 'large']) {
    assert.equal((await call({ op: 'write_file', path, content: 'changed' })).ok, false, path);
  }
  assert.equal(readFileSync(join(root, 'target'), 'utf8'), 'untouched');
  assert.equal((await call({ op: 'read_file', path: 'sym' })).ok, false);
  assert.equal((await call({ op: 'list_files', glob: '../*' })).ok, false);
}));

test('actual helper paginates text and bounds listing', async () => fixture(async (root, call) => {
  writeFileSync(join(root, 'text'), 'a'.repeat(25000));
  const first = (await call({ op: 'read_file', path: 'text' })).result;
  assert.equal(first.text.length, 2000); assert.equal(first.nextOffset, 2000);
  assert.equal((await call({ op: 'read_file', path: 'text', offset: 24000 })).result.text.length, 1000);
  for (let i = 0; i < 210; i++) writeFileSync(join(root, `f${i}`), 'test');
  const listed = (await call({ op: 'list_files', glob: '**/*' })).result;
  assert.equal(listed.matches.length, 200); assert.equal(listed.truncated, true);
}));

test('actual network helper rejects private IPv4 IPv6 credentials schemes and ports', async () => fixture(async (_root, call) => {
  for (const url of ['http://127.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'http://10.1.2.3', 'http://user:pass@example.com', 'file:///etc/passwd', 'http://example.com:22']) {
    assert.equal((await call({ op: 'web_fetch', url })).ok, false, url);
  }
}));

test('network DNS rebinding and private redirects fail before private connection', async () => {
  const code = `import importlib.util,socket\ns=importlib.util.spec_from_file_location('files',${JSON.stringify(helper)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ncalls=[]\ndef dns(host,port,**kw):\n calls.append(host)\n return [(socket.AF_INET,socket.SOCK_STREAM,6,'',(('93.184.216.34' if host=='public.test' else '127.0.0.1'),port))]\nm.socket.getaddrinfo=dns\nclass Sock:\n def __init__(self,*a): pass\n def settimeout(self,*a): pass\n def connect(self,a):\n  assert a[0]=='93.184.216.34'\n def close(self): pass\nclass Resp:\n status=302\n def getheader(self,k): return 'http://private.test/'\nclass Conn:\n def __init__(self,*a,**kw): pass\n def request(self,*a,**kw): pass\n def getresponse(self): return Resp()\n def close(self): pass\nm.socket.socket=Sock;m.http.client.HTTPConnection=Conn\ntry: m.fetch('http://public.test/')\nexcept ValueError as e: assert 'Non-public' in str(e)\nelse: raise AssertionError('private redirect accepted')\nassert calls==['public.test','private.test']\nprint('ok')`;
  assert.equal((await exec('python3', ['-c', code])).stdout.trim(), 'ok');
});

test('typed tools bound JSON payload and check authorization before and after execution', async () => {
  const command = fileToolCommand({ op: 'write_file', path: "x'; touch /bad", content: '$(bad)' });
  assert.match(command, /^python3 \/opt\/kamakura\/file-tools.py '[A-Za-z0-9+/=]+'$/);
  assert.throws(() => fileToolCommand({ content: 'x'.repeat(8000) }));
  let checks = 0;
  const tools = sandboxFileTools(async () => ({ output: JSON.stringify({ ok: true, result: 'ok' }), exitCode: 0, timedOut: false }), () => { checks++; });
  assert.deepEqual(Object.keys(tools), ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'web_fetch']);
  assert.equal(await sandboxFileCall(async () => ({ output: '{"ok":true,"result":"ok"}', exitCode: 0, timedOut: false }), {}, () => { checks++; }), 'ok');
  assert.equal(checks, 2);
  await assert.rejects(sandboxFileCall(async () => { throw new Error('must not run'); }, {}, () => { throw new Error('revoked'); }), /revoked/);
});
