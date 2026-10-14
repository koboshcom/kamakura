import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,copyFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('sandbox distro targets use fixed bases, unchanged entrypoint and root identity',()=>{
 const d=readFileSync('deploy/sandbox.Dockerfile','utf8');
 assert(!/FROM .*\$/.test(d));assert(!d.includes('FROM ${'));
 for(const [name,base] of [['ubuntu','ubuntu:24.04'],['debian','debian:13.7-slim'],['fedora','fedora:44']]){
  assert(d.includes(`FROM ${base} AS sandbox-${name}`));
  assert(d.includes(`ARG SANDBOX_DISTRO=${name}`));
  assert(d.includes(`test "$SANDBOX_DISTRO" = ${name}`));
 }
 assert.equal((d.match(/USER 0:0/g)||[]).length,3);
 assert.equal((d.match(/CMD \["bash", "\/opt\/kamakura\/start-desktop.sh"\]/g)||[]).length,3);
 assert(d.trim().endsWith('CMD ["bash", "/opt/kamakura/start-desktop.sh"]'));
});
test('Compose sandbox target and build arg load advanced explicitly with normal and shell precedence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'distro-compose-'));
 try{
  copyFileSync('compose.yaml',join(dir,'compose.yaml'));
  writeFileSync(join(dir,'.env'),'STORAGE=mongo\n');
  const env={...process.env};for(const k of ['SANDBOX_DISTRO','COMPOSE_FILE','COMPOSE_ENV_FILES'])delete env[k];
  const run=(advanced=false)=>{const args=['compose',...(advanced?['--env-file','.env.advanced','--env-file','.env']:[]),'--profile','build','config','--format','json'];const r=spawnSync('docker',args,{cwd:dir,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).services['sandbox-image'].build;};
  assert.equal(run().target,'sandbox-ubuntu');
  for(const name of ['ubuntu','debian','fedora']){
   writeFileSync(join(dir,'.env.advanced'),`SANDBOX_DISTRO=${name}\n`);
   assert.equal(run(true).target,`sandbox-${name}`);assert.equal(run(true).args.SANDBOX_DISTRO,name);
  }
  writeFileSync(join(dir,'.env'),'SANDBOX_DISTRO=debian\n');assert.equal(run(true).target,'sandbox-debian');
  env.SANDBOX_DISTRO='ubuntu';assert.equal(run(true).target,'sandbox-ubuntu');
  env.SANDBOX_DISTRO='alpine';assert.equal(run(true).target,'sandbox-alpine');
  // Docker --target only accepts an existing stage; it cannot resolve an arbitrary FROM.
 }finally{rmSync(dir,{recursive:true,force:true});}
});
