// Actual multimodal image and three text-only follow-ups, no Telegram sends.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kamakura-image-live-'));process.env.DATA_DIR=dir;
const {think,reminders}=await import('./dist/brain.js');
const {config}=await import('./dist/config.js');
const {HistoryStore}=await import('./dist/history.js');
const {sandboxes}=await import('./dist/sandbox.js');
const {stopLearning}=await import('./dist/learning-runtime.js');
const fixture=await sharp(Buffer.from('<svg width="640" height="400"><rect width="640" height="400" fill="white"/><rect x="70" y="100" width="120" height="120" fill="#dc2626"/><circle cx="380" cy="160" r="60" fill="#2563eb"/><text x="60" y="55" font-family="sans-serif" font-size="32" fill="black">ORBIT 731</text><text x="60" y="320" font-family="sans-serif" font-size="30" fill="black">MEETING FRIDAY</text></svg>')).jpeg().toBuffer();
try{for(const owner of config.sandbox.allowed){
 const history=new HistoryStore(join(dir,owner),30);let n=0;
 const turn=async(text,media)=>{const incoming={transport:'telegram',chatId:owner,senderId:owner,sender:'live owner',id:String(++n),text,isGroup:false,addressed:true,timestamp:Date.now(),learningEligible:false};history.add(owner,{role:'user',text,at:incoming.timestamp});const reply=await think(history.get(owner),incoming,media);history.add(owner,{role:'assistant',text:reply,at:Date.now()});console.log(owner,n,JSON.stringify(reply));return reply;};
 await turn('Keep this reference image for my next questions. Do not describe the words or shapes yet, just acknowledge receipt.',{images:[fixture],text:''});
 const colors=await turn('Which color is the circle in the image I sent?');assert.match(colors,/blue/i);assert.doesNotMatch(colors,/resend|send.*again|distract/i);
 const words=await turn('Read the exact text along the top of that same image.');assert.match(words,/orbit\s*731/i);assert.doesNotMatch(words,/resend|send.*again|distract/i);
 const bottom=await turn('What day is printed at the bottom of that same image, and what shape is to the left of the circle?');assert.match(bottom,/friday/i);assert.match(bottom,/square/i);assert.doesNotMatch(bottom,/resend|send.*again|distract/i);
 console.log('PASS actual retained image with three text-only visual/OCR follow-ups',owner);
}}finally{stopLearning();reminders.close();sandboxes.stop();rmSync(dir,{recursive:true,force:true});}
