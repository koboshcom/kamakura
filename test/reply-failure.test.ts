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
test('superseded and stopped turns cannot notify',()=>{
 let current=true;const gate=replyFailureGate(()=>current);
 current=false;assert.equal(gate.shouldNotify(deadline()),false);
});
