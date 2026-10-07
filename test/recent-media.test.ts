import test from 'node:test';
import assert from 'node:assert/strict';
import { RecentMedia } from '../src/recent-media.js';
test('recent images scoped by sender and bounded by age, history, count and bytes',()=>{
 const store=new RecentMedia(2,10,100,2);const history=[{role:'user' as const,text:'photo',at:10}];
 store.add('chat','one','a','photo',{images:[Buffer.from('123')],text:''},10);
 assert.equal(store.get('chat','a',history,11).length,1);
 assert.equal(store.get('chat','b',history,11).length,0);
 assert.equal(store.get('other','a',history,11).length,0);
 assert.equal(store.get('chat','a',[],11).length,0);
 store.add('chat','two','a','photo',{images:[Buffer.from('456'),Buffer.from('789')],text:''},11);
 assert.equal(store.get('chat','a',[...history,{role:'user',text:'two',at:11}],12).length,1);
 assert.equal(store.get('chat','a',history,120).length,0);
});
