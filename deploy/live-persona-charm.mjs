// Actual think/delivery pipeline, no Telegram sends. Run before and after deployment.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kamakura-charm-live-'));
process.env.DATA_DIR = dir;
const {think,reminders} = await import('./dist/brain.js');
const {HistoryStore} = await import('./dist/history.js');
const {sandboxes} = await import('./dist/sandbox.js');
const {stopLearning} = await import('./dist/learning-runtime.js');
const {closeMongo,collection,namespace} = await import('./dist/mongo.js');
const store = new HistoryStore(dir, 40);
const conversations = [
  { name: 'ordinary-interest', turns: ['hey', 'i spent the afternoon making a tiny model train station', 'i based it on the one near my grandma’s place', 'she used to take me there after school'] },
  { name: 'playful-topic-change', turns: ['your kittens unionized yet?', 'you’re getting outnumbered by tiny cats', 'anyway i finally got my light switch working', 'it’s two little servos, looks ridiculous but i love it'] },
  { name: 'soft-no-fix', turns: ['today was a bit disappointing', 'a friend cancelled our plans last minute', 'i was actually looking forward to it', 'don’t need advice, just wanted to tell you'] },
];
try {
  await Promise.all(conversations.map(async (conversation,index) => {
    const recent = [];const replies = [];
    for (const [turn,text] of conversation.turns.entries()) {
      const incoming = {transport:'telegram',chatId:'7853500388',senderId:'7853500388',sender:'owner',id:String(95000+index*100+turn),text,isGroup:false,addressed:true,timestamp:Date.now(),learningEligible:false,credentialEligible:true};
      const sent = [];
      await think(recent,incoming,undefined,undefined,{history:store,delivery:{current:()=>true,send:async text=>{sent.push(text);},react:async()=>{}}});
      assert.ok(sent.join('').trim(),'substantive chat turn must receive captured delivery');
      const answer=sent.join('\n');
      replies.push({user:text,reply:answer});
      recent.push({role:'user',text,at:Date.now(),senderId:incoming.senderId,id:incoming.id},{role:'assistant',text:answer,at:Date.now()});
    }
    console.log('CONVERSATION '+JSON.stringify({name:conversation.name,turns:replies}));
  }));
} finally {
  stopLearning();await reminders.close();sandboxes.stop();
  for(const name of ['history','facts','context_summaries','learning'])await(await collection(name)).deleteMany({ns:namespace(dir)});
  await closeMongo();rmSync(dir,{recursive:true,force:true});
}
