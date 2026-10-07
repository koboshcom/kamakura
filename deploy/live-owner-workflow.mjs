// Actual model/sandbox tests. Dummy key only, isolated history/learning, no real enrollment.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'kamakura-workflow-live-'));
process.env.DATA_DIR=dir;
const { config }=await import('./dist/config.js');
const { think, reminders }=await import('./dist/brain.js');
const { runWorker }=await import('./dist/worker.js');
const { BackgroundJobs }=await import('./dist/jobs.js');
const { canWork }=await import('./dist/work-tools.js');
const { sandboxes }=await import('./dist/sandbox.js');
const { HistoryStore }=await import('./dist/history.js');
const { stopLearning }=await import('./dist/learning-runtime.js');
const { TelegramTransport }=await import('./dist/transports/telegram.js');
const { telegramText }=await import('./dist/telegram-format.js');
const { redactCredentials }=await import('./dist/credentials.js');
const owners=[...config.sandbox.allowed];
const make=(owner,text)=>({transport:'telegram',chatId:owner,senderId:owner,sender:'live owner',id:randomUUID(),text,isGroup:false,addressed:true,credentialEligible:true,learningEligible:false,timestamp:Date.now()});
const history=new HistoryStore(dir,30);
const disk=path=>readdirSync(path,{withFileTypes:true}).map(item=>item.isDirectory()?disk(join(path,item.name)):readFileSync(join(path,item.name),'utf8')).join('');
try {
 for(const owner of owners){
  const key='tskey-auth-'+randomUUID().replaceAll('-','');
  const text=`I own this sandbox. This is a dummy test credential, not an actual enrollment key. Use this privately supplied single-use auth key ${key} solely for a local transient check. In the shell, compare its string prefix and print only credential-flow-ok on success. Do not connect to any network service, echo it, or write the key to files. Do this short check yourself, not a worker.`;
  const incoming=make(owner,text);history.add(owner,{role:'user',text,at:Date.now()});
  const acks=[];const run=sandboxes.run.bind(sandboxes);let verifiedCredential=false;
  sandboxes.run=async(id,command)=>{assert.ok(acks.length,'ack before any command');const result=await run(id,command);if(result.exitCode===0&&result.output.includes('credential-flow-ok'))verifiedCredential=true;console.log('Dummy check outcome',JSON.stringify({exitCode:result.exitCode,output:redactCredentials(result.output)}));return result;};
  const reply=await think(history.get(owner),incoming,undefined,async ack=>{acks.push(ack);assert.ok(!ack.includes(key));}).finally(()=>{sandboxes.run=run;});
  assert.ok(acks.length===1,'exactly one task acknowledgment');assert.ok(verifiedCredential,'actual transient credential check');assert.doesNotMatch(reply,/revoke|exposed|rotate|can.t use|cannot use/i);
  assert.ok(!reply.includes(key));assert.ok(!disk(dir).includes(key));
  console.log('PASS actual owner DM dummy-key task, acknowledgment, no exposure refusal, no secret disk/reply',owner,JSON.stringify({acks,reply}));
 }
 const owner=owners[0];const marker='ack-long-'+randomUUID();let acknowledged=false;const delivered=[];
 const jobs=new BackgroundJobs(runWorker,async(job,text)=>{assert.ok(acknowledged);delivered.push(text);},canWork,{concurrency:1,timeoutMs:180000});
 // Use real worker handoff system in think, with its delivery captured rather than spamming Telegram.
 const { startWorkers, stopWorkers }=await import('./dist/worker.js');
 const completion=Promise.withResolvers();
 startWorkers(async(job,text)=>{assert.ok(acknowledged,'worker result after ack');delivered.push(text);if(text.includes(marker))completion.resolve();});
 const request=make(owner,`Start a background worker for this authorized sandbox test. Have it run sleep 5 and then printf ${marker} without creating files. Send a short acknowledgment before starting it, then let it report the verified output.`);
 const short=await think([],request,undefined,async ack=>{acknowledged=true;console.log('Actual long task acknowledgment',JSON.stringify(ack));});
 assert.ok(acknowledged);assert.ok(!delivered.length,'chat returns before the worker finishes');
 // Wait for this actual worker completion with a bounded delivery event, not agent polling.
 let deadline;try{await Promise.race([completion.promise,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Worker result timed out')),180000);})]);}finally{clearTimeout(deadline);}
 assert.match(delivered.join('\n'),new RegExp(marker));console.log('PASS actual ack before long-worker result',JSON.stringify({short,result:delivered}));stopWorkers();jobs.stop();
 // Actual missing-default-package recovery in owner sandbox, no auth key/enrollment.
 const absent=await sandboxes.run(owner,'command -v tailscale || true');assert.equal(absent.output.trim(),'');
 const recover=make(owner,'For this isolated installation test, install Tailscale in my sandbox, but do NOT enroll or connect a node. It is missing and the default apt repositories cannot find it. First verify those states using tools. Recover through the official signed vendor repository or inspected official installer, verify tailscale version with tools, and report the actual result. Use /tmp for temporary installer data, never change /work. Do not give up with a documentation link.');
 const recovery=await runWorker({id:randomUUID(),incoming:recover,task:recover.text},AbortSignal.timeout(240000));
 const verified=await sandboxes.run(owner,'tailscale version');assert.equal(verified.exitCode,0);assert.match(verified.output,/\d+\.\d+/);
 console.log('PASS actual missing package install recovery and executable verification',JSON.stringify(redactCredentials(recovery)));
 // Remove only the test installation and official repo introduced above; keep no bundled Tailscale.
 const cleanup=await sandboxes.run(owner,'sudo apt-get remove -y tailscale >/dev/null && sudo rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg && ! command -v tailscale');assert.equal(cleanup.exitCode,0);
 const transport=new TelegramTransport();const rendered=telegramText('workflow test passed. [installation docs](https://tailscale.com/docs/install/linux?utm_source=openai)');
 // Real Telegram server validates/rendered entity payload returned in Message, no browser assumption.
 const message=await transport.bot.api.sendMessage(owner,rendered.text,{entities:rendered.entities,link_preview_options:{is_disabled:true}});
 assert.ok(message.entities?.some(e=>e.type==='text_link'&&e.url==='https://tailscale.com/docs/install/linux'));assert.ok(!message.text.includes('[installation docs]('));assert.ok(!message.text.includes('utm_source'));
 await transport.bot.api.deleteMessage(owner,message.message_id);
 console.log('PASS actual Telegram server accepted text_link entities, clean URL and clean text (test message deleted)');
 assert.ok(!disk(dir).includes('tskey-auth-'));assert.equal([...config.telegramAllowed].length,2);
} finally {stopLearning();reminders.close();sandboxes.stop();rmSync(dir,{recursive:true,force:true});}
