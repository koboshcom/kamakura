import test from 'node:test';import assert from 'node:assert/strict';
import {reviewDraft,replyLengthHint} from '../src/reply-review.js';
import {chatTools} from '../src/chat-tools.js';import {HistoryStore} from '../src/history.js';
const options={toolCallId:'review',messages:[]};
const incoming={transport:'telegram' as const,chatId:'6612253937',senderId:'6612253937',sender:'owner',id:'1',text:'made a shelf',timestamp:1,isGroup:false};
test('review uses replacement, keeps originals on invalid edit or network failure, preserves URLs',async()=>{
 const input={draft:'original',latest:'hello',evidence:'untrusted'};
 assert.equal(await reviewDraft(input,async()=>'shorter'),'shorter');
 for(const edited of ['', 'Critique: not good','x'.repeat(5000),'```data'])assert.equal(await reviewDraft(input,async()=>edited),'original');
 assert.equal(await reviewDraft(input,async()=>{throw Error('network');}),'original');
 assert.equal(await reviewDraft({...input,draft:'here https://example.test'},async()=>'here'),'here https://example.test');
 assert.match(replyLengthHint('hello'),/small conversational/);assert.match(replyLengthHint('explain in detail'),/requested depth/);
});
test('review cancellation before or after rewrite never returns a deliverable draft',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(()=>reviewDraft({draft:'x',latest:'x',evidence:'',signal:c.signal},async()=>'y'));
 const d=new AbortController();await assert.rejects(()=>reviewDraft({draft:'x',latest:'x',evidence:'',signal:d.signal},async()=>{d.abort();return 'y';}));
});
test('reviewed delivery records edited text, excludes progress and voice, checks stale turns again',async()=>{
 let active=true;const sent:string[]=[];const recorded:string[]=[];let edits=0;
 const tools=chatTools(incoming,new HistoryStore('/tmp/replyreview-test'),{current:()=>active,send:async text=>{sent.push(text);},react:async()=>{},voice:async text=>{sent.push(text);}},[],text=>recorded.push(text),undefined,undefined,async()=>{edits++;return 'edited';});
 await tools.send_message.execute!({text:'draft'},options);await tools.send_message.execute!({text:'working',purpose:'progress'},options);await tools.send_voice!.execute!({text:'spoken'},options);
 assert.equal(edits,1);assert.deepEqual(sent,['edited','working','spoken']);assert.deepEqual(sent,recorded);
 const stale=chatTools(incoming,new HistoryStore('/tmp/replyreview-stale'),{current:()=>active,send:async()=>{throw Error('must not send');},react:async()=>{}},[],()=>{},undefined,undefined,async()=>{active=false;return 'late';});
 await assert.rejects(()=>stale.send_message.execute!({text:'draft'},options) as Promise<unknown>,/superseded/);
});
