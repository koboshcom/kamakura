import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function probe(env: Record<string,string>, body: string) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key])=> !/^(BOT_|SYSTEM_PROMPT|PERSONA_|CHAT_STYLE_|OPENAI_)/.test(key)));
  return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',body],{env:{...clean,...env},encoding:'utf8'});
}
const inspect = "const {config}=await import('./src/config.ts');const {personaPrompt}=await import('./src/persona.ts');const {chatStyle,recentChatStyle}=await import('./src/chat-style.ts');console.log(JSON.stringify({name:config.botName,prompt:personaPrompt(),style:chatStyle(2),recent:recentChatStyle([]),mode:config.chatStyleMode,worker:config.workerModel,summary:config.summaryModel,learning:config.learningModel,review:config.reviewModel,base:config.provider.baseUrl}));";
test('operator defaults retain persona, style and shared model defaults',()=>{
 const r=probe({},inspect);assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);
 assert.equal(v.name,'Kamakura');assert.match(v.prompt,/You are Kamakura/);assert.equal(v.mode,'default');assert.match(v.style,/not an echo/);assert.equal(v.worker,'gpt-6-luna');
});
test('inline prompt overrides missing files and custom identity does not inherit fixed style',()=>{
 const r=probe({SYSTEM_PROMPT:'You are {{BOT_NAME}}, a formal archivist.',SYSTEM_PROMPT_PATH:'/missing',PERSONA_PATH:'/missing',BOT_NAME:'Archive',BOT_PERSONALITY:'Use complete sentences.',OPENAI_MODEL:'chat',OPENAI_WORKER_MODEL:'worker',OPENAI_SUMMARY_MODEL:'summary',OPENAI_LEARNING_MODEL:'learn',OPENAI_REVIEW_MODEL:'review',OPENAI_BASE_URL:'https://provider.example/v1'},inspect);
 assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);assert.match(v.prompt,/Archive, a formal archivist/);assert.match(v.prompt,/complete sentences/);assert.equal(v.style,'');assert.equal(v.recent,'');assert.equal(v.worker,'worker');assert.equal(v.summary,'summary');assert.equal(v.learning,'learn');assert.equal(v.review,'review');
});
test('file prompt and style use container paths; inline style takes precedence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'operator-config-'));try{
 writeFileSync(join(dir,'prompt.md'),'Configured file {{BOT_NAME}}');writeFileSync(join(dir,'style.md'),'Formal register.');
 const r=probe({SYSTEM_PROMPT_PATH:join(dir,'prompt.md'),CHAT_STYLE_MODE:'custom',CHAT_STYLE_PATH:join(dir,'style.md'),BOT_NAME:'File'},inspect);
 assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);assert.match(v.prompt,/Configured file File/);assert.equal(v.style,'Formal register.');
 const inline=probe({PERSONA_TEXT:'Inline persona',CHAT_STYLE_MODE:'custom',CHAT_STYLE_PATH:'/missing',CHAT_STYLE_TEXT:'Inline style'},inspect);assert.equal(inline.status,0,inline.stderr);assert.equal(JSON.parse(inline.stdout).style,'Inline style');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('invalid endpoint errors exclude endpoint credentials',()=>{
 for(const name of ['OPENAI_BASE_URL','OPENAI_TRANSCRIBE_BASE_URL','SPEECH_TTS_BASE_URL']){
  const r=probe({[name]:'https://private-user:private-secret@example.com/v1'},inspect);assert.notEqual(r.status,0);assert.doesNotMatch(r.stderr,/private-secret|private-user/);
 }
});
test('all language model call sites use configured provider and selected task model',()=>{
 for(const name of ['brain','worker','learning-runtime','reply-review']){
  const source=readFileSync('src/'+name+'.ts','utf8');assert.match(source,/from '.\/model-provider.js'/);assert.doesNotMatch(source,/from '@ai-sdk\/openai'/);
 }
 assert.match(readFileSync('src/worker.ts','utf8'),/responses\(config.workerModel\)/);
 assert.match(readFileSync('src/brain.ts','utf8'),/responses\(config.summaryModel\)/);
 const brain=readFileSync('src/brain.ts','utf8');assert.match(brain,/Never infer identities or store credentials/);
 assert.match(readFileSync('src/worker.ts','utf8'),/Do not access the host or another user's resources/);
});
