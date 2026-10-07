import test from 'node:test';import assert from 'node:assert/strict';import {TelegramTransport} from '../src/transports/telegram.js';
test('Telegram reply parameters, voice note and reactions preserve explicit destinations and propagate failures',async()=>{
 const transport=new TelegramTransport('123456789:test_token');let captured:unknown;
 transport.bot.api.sendMessage=async(chat,text,options)=>{captured={chat,text,options};return {} as never;};await transport.send('123','**kamakura**',{replyTo:'42'});const sent=captured as {chat:string;text:string;options:{reply_parameters:{message_id:number};entities:{type:string}[]}};assert.equal(sent.chat,'123');assert.equal(sent.text,'kamakura');assert.equal(sent.options.reply_parameters.message_id,42);assert.equal(sent.options.entities[0].type,'bold');
 transport.bot.api.sendVoice=async(chat,_voice,options)=>{captured={chat,options};return {} as never;};await transport.sendVoice('123',Buffer.from('OggSdummy'),{replyTo:'42'});assert.equal((captured as {options:{reply_parameters:{message_id:number}}}).options.reply_parameters.message_id,42);
 transport.bot.api.setMessageReaction=async()=>{throw new Error('disabled');};await assert.rejects(()=>transport.react({transport:'telegram',chatId:'123',senderId:'123',sender:'owner',id:'42',text:'x',timestamp:0,isGroup:false},'👍'),/disabled/);
 let tries=0;transport.bot.api.sendVoice=async()=>{tries++;throw new Error('network');};await assert.rejects(()=>transport.sendVoice('123',Buffer.from('OggSdummy')));assert.equal(tries,1);
});
