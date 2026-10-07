import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replyFailureGate} from '../src/reply-failure.js';
const deadline = () => new DOMException('sensitive provider details', 'TimeoutError');
test('current deadline before delivery permits only a safe notice',()=>{
 const gate=replyFailureGate(()=>true);
 assert.equal(gate.shouldNotify(deadline()),true);
 assert.equal(gate.shouldNotify(new DOMException('cancelled','AbortError')),true);
 assert.equal(gate.shouldNotify(new Error('unrecognized error')),false);
 assert.equal(gate.shouldNotify({name:'TimeoutError'}),false);
 gate.deliveryStarted();assert.equal(gate.shouldNotify(deadline()),false);
});
for(const kind of ['text','voice','reaction','uncertain transport send'])test(`${kind} attempt excludes timeout notice`,()=>{
 const gate=replyFailureGate(()=>true);gate.deliveryStarted();assert.equal(gate.shouldNotify(deadline()),false);
});
test('closed generation rejects late delivery and permits exactly one current notice',()=>{
 const gate=replyFailureGate(()=>true);gate.close();
 assert.equal(gate.current(),false);
 assert.throws(()=>gate.deliveryStarted(),/unavailable/);
 assert.equal(gate.shouldNotify(deadline()),true);
 gate.noticeStarted();assert.equal(gate.shouldNotify(deadline()),false);
 assert.throws(()=>gate.noticeStarted(),/unavailable/);
});
test('queued late tool cannot deliver after deadline notice',async()=>{
 const gate=replyFailureGate(()=>true);let calls=0;
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 const late=(async()=>{await pending;gate.deliveryStarted();calls++;})();
 gate.close();gate.noticeStarted();release();
 await assert.rejects(late,/unavailable/);assert.equal(calls,0);
});
test('a wrapper entered before synthesis or pacing suppresses notice',async()=>{
 const gate=replyFailureGate(()=>true);gate.deliveryStarted();await Promise.resolve();gate.close();
 assert.equal(gate.current(),false);assert.equal(gate.shouldNotify(deadline()),false);
});
test('notice superseded before it begins is never attempted',()=>{
 let current=true;const gate=replyFailureGate(()=>current);gate.close();
 assert.equal(gate.shouldNotify(deadline()),true);current=false;
 assert.throws(()=>gate.noticeStarted(),/unavailable/);
});

