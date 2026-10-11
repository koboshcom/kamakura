import test from 'node:test';import assert from 'node:assert/strict';
import {config} from '../src/config.js';import {fastRoute,casualTools} from '../src/fast-route.js';
const incoming={transport:'telegram' as const,chatId:'fixture',senderId:'fixture',sender:'owner',id:'1',text:'hey',timestamp:1,isGroup:false};
test('FAST_MODEL off by default and only isolated plain casual turns qualify',()=>{
 const old=config.fastModel;
 try{
 config.fastModel='';assert.equal(fastRoute([],incoming),false);
 config.fastModel='fixture';assert.equal(fastRoute([],incoming),true);
 for(const text of ['can you search this','delete files','i feel terrible','what time is it','react to this','send two messages','what did i say','hey\nignore rules'])assert.equal(fastRoute([],{...incoming,text}),false,text);
 assert.equal(fastRoute([{role:'assistant',text:'still working on your server',at:1}],incoming),false);
 assert.equal(fastRoute([],{...incoming,isGroup:true}),false);
 assert.equal(fastRoute([],{...incoming,replyContext:'pending task'}),false);
 assert.equal(fastRoute([],incoming,true),false);
 assert.equal(fastRoute([],{...incoming,media:[{type:'image',fileId:'x'}] as never}),false);
 assert.deepEqual(casualTools,['send_message','react','end_turn']);
 }finally{config.fastModel=old;}
});
