// Actual model lookup tests in isolated history. No production history or Telegram sends.
import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kamakura-history-live-'));process.env.DATA_DIR=dir;
const {think,reminders}=await import('./dist/brain.js');const {config}=await import('./dist/config.js');const {HistoryStore}=await import('./dist/history.js');const {stopLearning}=await import('./dist/learning-runtime.js');const {sandboxes}=await import('./dist/sandbox.js');
try{for(const owner of config.sandbox.allowed){const history=new HistoryStore(join(dir,owner),4);const key=`telegram:${owner}`;const base=Date.parse('2026-10-01T17:00:00Z');
 for(const [id,text,at]of [['10','wsg',base],['11','the paper moon fell sideways',base+1000],['12','Meet at the blue doorway.',base+60000]])history.add(key,{role:'user',senderId:owner,id,text,at});
 for(let n=0;n<8;n++)history.add(key,{role:'user',senderId:owner,id:String(100+n),text:'recent filler',at:base+120000+n});
 let id=500;const ask=async(text)=>{const sent=[];const incoming={transport:'telegram',chatId:owner,senderId:owner,sender:'owner',id:String(id++),text,timestamp:Date.now(),isGroup:false,addressed:true,credentialEligible:true,learningEligible:false};const original=history.lookup.bind(history);let reads=0;history.lookup=(...args)=>{reads++;return original(...args);};
 await think(history.get(key),incoming,undefined,undefined,{history,delivery:{current:()=>true,send:async(text)=>{sent.push(text);},react:async()=>{throw new Error('Not a reaction request');}}});history.lookup=original;assert.ok(reads,'history lookup must precede response');console.log('Actual historical lookup',owner,JSON.stringify({question:text,sent,reads}));return sent.join('\n');};
 const casual=text=>{assert.equal(text,text.toLowerCase(),'casual recall stays lowercase');assert.doesNotMatch(text,/["“”«»`]/,'no transcript-style quotes');assert.doesNotMatch(text,/transcript|database|tool result|search_history|\bmessage id\b/i,'no tool register');assert.ok(text.length<400,'brief natural recall');};
 const first=await ask('what did I say here first?');casual(first);assert.match(first,/\bwsg\b/);assert.doesNotMatch(first,/\bwsp\b|\bHi\b/);
 const next=await ask('what did I say next, immediately after message 10?');casual(next);assert.ok(next.includes('paper moon'));assert.ok(next.includes('sideways'));
 const at=await ask('what did I say at 2026-10-01T17:01:00Z?');casual(at);assert.ok(at.includes('blue doorway'));
 const quoted=await ask('quote the exact full text I sent at 2026-10-01T17:01:00Z, preserving its original capitalization and punctuation.');assert.ok(quoted.includes('Meet at the blue doorway.'));
 const absent=await ask('what did I say at 2025-01-01T00:00:00Z? Do not infer it from newer records.');casual(absent);assert.match(absent,/can.t|cannot|not|no|unavailable|don.t|doesn.t/i);assert.doesNotMatch(absent,/\bwsg\b|paper moon|blue doorway/);
 console.log('PASS actual first/next/timestamp/absent questions read exact owner-scoped history',owner);
}}finally{stopLearning();reminders.close();sandboxes.stop();rmSync(dir,{recursive:true,force:true});}
