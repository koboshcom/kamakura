import assert from 'node:assert/strict';
import {test} from 'node:test';
import {outgoingText} from '../src/outgoing-text.js';
import {chatDelivery} from '../src/chat-delivery.js';
test('strips Unicode and concatenated bare provider citations without changing content',()=>{
 assert.equal(outgoingText('Heater. citeturn0search2turn0search1'),'Heater.');
 assert.equal(outgoingText('Heater. citeturn0search2turn0search1'),'Heater.');
 assert.equal(outgoingText('citeturn12view3citeturn0search2turn0search1'),'');
 const content='[source](https://example.com/citeturn0search2turn0search1?q=1) I²R 中文 👍 `citeturn0search2turn0search1`\n```js\nconst cite = "citeturn0search2";\n```';
 assert.equal(outgoingText(content),content);
});
test('shared delivery strips text and voice before pacing, synthesis and recording; marker-only is silent',async()=>{
 const sent:string[]=[],spoken:string[]=[],recorded:string[]=[];
 const transport:any={send:async(_chat:string,text:string)=>{sent.push(text);},sendVoice:async()=>{}};
 const incoming:any={transport:'telegram',chatId:'1',id:'42'};
 const delivery=chatDelivery(transport,incoming,{current:()=>true,deliveryStarted:()=>{},pace:async()=>{},delivered:async(text)=>{if(text)recorded.push(text);},voice:{synthesize:async(text)=>{spoken.push(text);return Buffer.alloc(0);}}});
 await delivery.send('answer citeturn0search2');
 await delivery.voice!('answer citeturn0search2turn0search1');
 await delivery.send('citeturn0search2');
 await delivery.voice!('citeturn0search2turn0search1');
 assert.deepEqual(sent,['answer']);assert.deepEqual(spoken,['answer']);assert.deepEqual(recorded,['answer','answer']);
});
