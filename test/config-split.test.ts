import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parse} from 'dotenv';
test('example keys partition once with required providers basic and optional triplets advanced',()=>{
 const normal=parse(readFileSync('.env.example')),advanced=parse(readFileSync('.env.advanced.example'));
 assert.equal(Object.keys(normal).filter(k=>k in advanced).length,0);
 for(const k of ['STORAGE','DEFAULT_TIMEZONE','OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','EMBEDDING_BASE_URL','EMBEDDING_API_KEY','EMBEDDING_MODEL'])assert(k in normal,k);
 for(const k of ['STT_KEY','GEMINI_VIDEO_KEY','OPENAI_WORKER_API_KEY','STT_MODEL'])assert(k in advanced,k);
 assert('NOVNC_PORT' in normal);assert('SANDBOX_MEMORY' in normal);assert.equal(normal.STORAGE,'mongo');
});
test('Node optional advanced config precedence preserves shell, normal and advanced values',()=>{
 const dir=mkdtempSync(join(tmpdir(),'env-split-')),envPath=join(dir,'.env');
 try{
  writeFileSync(envPath,'SPLIT_VALUE=normal\n');
  const code="await import("+JSON.stringify(resolve('src/env.ts'))+");console.log(JSON.stringify([process.env.SPLIT_VALUE,process.env.ADVANCED_ONLY]))";
  const run=(extra={})=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,DOTENV_CONFIG_PATH:envPath,...extra},encoding:'utf8'});
  let r=run();assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['normal',null]);
  writeFileSync(join(dir,'.env.advanced'),'SPLIT_VALUE=advanced\nADVANCED_ONLY=present\n');
  r=run();assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['normal','present']);
  r=run({SPLIT_VALUE:'shell'});assert.deepEqual(JSON.parse(r.stdout),['shell','present']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('standard Compose optional advanced defaults, normal overrides, shell overrides and ports',()=>{
 const dir=mkdtempSync(join(tmpdir(),'compose-split-'));
 try{
  for(const name of ['compose.yaml','compose.sqlite.yaml'])copyFileSync(name,join(dir,name));
  writeFileSync(join(dir,'.env'),'STORAGE=mongo\nOPENAI_MODEL=normal\n');
  const env={...process.env};for(const key of ['COMPOSE_FILE','COMPOSE_ENV_FILES','NOVNC_PORT','DESKTOP_PORT','OPENAI_MODEL'])delete env[key];
  const run=(args:string[])=>{const r=spawnSync('docker',['compose',...args],{cwd:dir,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  let c=run(['config','--format','json']);assert.equal(c.services.core.environment.OPENAI_MODEL,'normal');assert(c.services.mongo);
  writeFileSync(join(dir,'.env.advanced'),'NOVNC_PORT=49171\nSTT_REQUEST_TIMEOUT_SECONDS=60\nOPENAI_MODEL=advanced\n');
  c=run(['config','--format','json']);assert.equal(c.services.core.environment.OPENAI_MODEL,'normal');assert.equal(c.services.core.environment.STT_REQUEST_TIMEOUT_SECONDS,'60');
  assert.equal(String(c.services.core.ports[0].published),'47831'); // env_file cannot interpolate host settings.
  writeFileSync(join(dir,'.env'),'STORAGE=mongo\nOPENAI_MODEL=normal\nNOVNC_PORT=49173\n');c=run(['config','--format','json']);assert.equal(String(c.services.core.ports[0].published),'49173');assert.equal(c.services.core.ports[0].target,49173);
  env.NOVNC_PORT='49172';c=run(['config','--format','json']);assert.equal(String(c.services.core.ports[0].published),'49172');delete env.NOVNC_PORT;env.OPENAI_MODEL='shell';c=run(['config','--format','json']);assert.equal(c.services.core.environment.OPENAI_MODEL,'shell');env.OPENAI_MODEL='';c=run(['config','--format','json']);assert.equal(c.services.core.environment.OPENAI_MODEL,'');delete env.OPENAI_MODEL;
  c=run(['-f','compose.yaml','-f','compose.sqlite.yaml','config','--format','json']);
  assert.equal(c.services.core.environment.STORAGE,'sqlite');assert(!c.services.core.depends_on?.mongo);assert.deepEqual(Object.keys(c.services.core.networks),['default']);
  const r=spawnSync('docker',['compose','-f','compose.yaml','-f','compose.sqlite.yaml','config','--services'],{cwd:dir,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'core');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
