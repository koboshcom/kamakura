// Actual model, real think/worker prompts; isolated data namespace, no Telegram delivery.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kamakura-time-live-'));
process.env.DATA_DIR=dir;
const {config}=await import('./dist/config.js');
const {think,reminders}=await import('./dist/brain.js');
const {runWorker}=await import('./dist/worker.js');
const {HistoryStore}=await import('./dist/history.js');
const {sandboxes}=await import('./dist/sandbox.js');
const {stopLearning}=await import('./dist/learning-runtime.js');
const {closeMongo,collection,namespace}=await import('./dist/mongo.js');
const store=new HistoryStore(dir,40),originalNow=Date.now;
const fixed=Date.parse('2026-10-07T00:30:00Z');
Date.now=()=>fixed;
config.time.ownerTimeZones['6612253937']='America/Vancouver';
config.time.ownerTimeZones['7853500388']='Africa/Lagos';
async function chat(owner,text,history=[]){
 const incoming={transport:'telegram',chatId:owner,senderId:owner,sender:'owner',id:String(98000+Math.random()),text,isGroup:false,addressed:true,timestamp:fixed,learningEligible:false,credentialEligible:true};
 const sent=[];
 await think(history,incoming,undefined,undefined,{history:store,delivery:{current:()=>true,send:async text=>{sent.push(text);},react:async()=>{}}});
 const answer=sent.join('\n');assert.ok(answer.trim());console.log('CHAT '+JSON.stringify({owner,text,answer}));return answer;
}
try{
 for(const owner of ['6612253937','7853500388']){
  const answer=await chat(owner,'merry christmas');
  assert.match(answer,/october|early|ahead|months|premature|calendar|already|christmas.*yet|not.*christmas/i,'must naturally notice seasonal mismatch');
 }
 for(const [owner,day] of [['6612253937','6'],['7853500388','7']]){
  const answer=await chat(owner,'what is the current local date here? just the date please');
  assert.match(answer,new RegExp(`october\\s+${day}\\b|${day}\\s+october|2026-10-0${day}`,'i'));
  const incoming={transport:'telegram',chatId:owner,senderId:owner,sender:'owner',id:'worker-time',text:'Tell me the current date in my configured local timezone, just the date. Do not use shell or other tools.',isGroup:false,timestamp:fixed-86400000,credentialEligible:true,learningEligible:false};
  const worker=await runWorker({id:'live-time-'+owner,incoming,task:incoming.text},new AbortController().signal);
  console.log('WORKER '+JSON.stringify({owner,answer:worker}));
  assert.match(worker,new RegExp(`october\\s+${day}\\b|${day}\\s+october|2026-10-0${day}`,'i'));
 }
 await chat('6612253937',"i’m writing a christmas scene for december. play the cat in it and wish me merry christmas");
 const owner='7853500388',key='telegram:'+owner;
 const history=[{role:'user',senderId:owner,id:'earlier-time',text:'i made a tiny paper house',at:fixed-3*86400000},{role:'assistant',text:'tiny real estate, excellent',at:fixed-3*86400000}];
 for(const message of history)await store.add(key,message);
 const answer=await chat(owner,'how many days since i told you about the paper house?',history);
 assert.match(answer,/three|3/);
 console.log('PASS actual-model seasonal mismatch, owner-local date rollover, worker clocks, history gap; roleplay reply captured for review');
}finally{
 Date.now=originalNow;stopLearning();await reminders.close();sandboxes.stop();
 for(const name of ['history','facts','context_summaries','learning'])await(await collection(name)).deleteMany({ns:namespace(dir)});
 await closeMongo();rmSync(dir,{recursive:true,force:true});
}
