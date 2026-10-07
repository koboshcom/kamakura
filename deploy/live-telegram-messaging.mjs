// Actual Telegram API verification, two temporary test messages per owner, then clean up only those IDs.
import assert from 'node:assert/strict';import {TelegramTransport} from './dist/transports/telegram.js';import {config} from './dist/config.js';import {speechAvailable} from './dist/speech.js';
const owners=[...config.sandbox.allowed];assert.deepEqual([...config.telegramAllowed].sort(),owners.toSorted());const transport=new TelegramTransport();const created=[];
try{for(const owner of owners){let last;const original=transport.bot.api.sendMessage.bind(transport.bot.api);transport.bot.api.sendMessage=async(...args)=>{const result=await original(...args);created.push({owner,id:result.message_id});last=result;return result;};
 const stop=transport.startTyping(owner);try{
 await transport.send(owner,'**kamakura delivery check**\n[reference](https://example.com/?utm_source=openai&q=test)');assert.equal(last.text,'kamakura delivery check\nreference');assert.ok(last.entities?.some(e=>e.type==='bold'));assert.ok(last.entities?.some(e=>e.type==='text_link'&&e.url==='https://example.com/?q=test'));const first=last.message_id;
 await new Promise(resolve=>setTimeout(resolve,800));await transport.send(owner,'quoted delivery check',{replyTo:String(first)});assert.equal(last.reply_to_message?.message_id,first);
 await transport.react({transport:'telegram',chatId:owner,senderId:owner,sender:'owner',id:String(last.message_id),text:'test',isGroup:false,timestamp:Date.now()},'👍');console.log('PASS actual Telegram rendered entities, quoted reply, reaction and typing',owner);
 }finally{stop();transport.bot.api.sendMessage=original;}
}console.log('Optional speech currently available',await speechAvailable());
}finally{for(const {owner,id}of created)await transport.bot.api.deleteMessage(owner,id);await transport.stop();}
