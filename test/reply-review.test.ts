import test from 'node:test';import assert from 'node:assert/strict';
import {reviewDraft,replyLengthHint,bypassReplyReview,reviewEvidence,completeReviewedText,reviewChatReply} from '../src/reply-review.js';
import type {ModelMessage} from 'ai';
import {chatTools} from '../src/chat-tools.js';import {HistoryStore} from '../src/history.js';
test('artifact and exact-text requests bypass casual editor without changing bytes',async()=>{
 for(const [draft,latest] of [['{"Hello":"World"}','send json'],['Subject: Request\nDear Alex,\nThank you.','write an email'],['"Keep This Exactly"','quote what I said'],['const X = 1;','write code'],['Bonjour','translate hello']]){
  assert.equal(bypassReplyReview(draft,latest,[]),true);
  assert.equal(await reviewChatReply(draft,latest,[]),draft);
 }
 assert.equal(bypassReplyReview('what colour did you use?','painted my shelf',[]),false);
 const image:ModelMessage={role:'user',content:[{type:'image',image:new Uint8Array(1000000)}]};
 assert.equal(bypassReplyReview('a blue bird','what is this?',[image]),true);
});
test('bounded text evidence excludes binary and tool-call objects before serialization',()=>{
 const image={type:'image' as const,get image(){throw Error('binary payload must never be read');}};
 const messages:ModelMessage[]=[{role:'system',content:'PRIVATE'},{role:'user',content:[image,{type:'text',text:'actual detail'}]},{role:'assistant',content:[{type:'tool-call',toolCallId:'x',toolName:'x',input:{hidden:'tool input'}}]}];
 assert.equal(reviewEvidence(messages),'[{"role":"user","text":"actual detail"}]');
 const large:ModelMessage[]=Array.from({length:1000},()=>({role:'user',content:'x'.repeat(100000)}));
 assert.ok(reviewEvidence(large).length<21000);
});
test('incomplete model edits retain the whole original draft',()=>{
 for(const finishReason of ['length','error','tool-calls','unknown','content-filter'])assert.equal(completeReviewedText({text:'nonempty truncated',finishReason},'complete original'),'complete original');
 assert.equal(completeReviewedText({text:'good edit',finishReason:'stop'},'original'),'good edit');
});
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
