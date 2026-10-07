import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {config} from '../src/config.js';
import {trustedLocalOwner} from '../src/local-device-telegram.js';
import type {Message} from 'grammy/types';
const owner='6612253937';
const message={message_id:1,date:1,chat:{id:Number(owner),type:'private'},from:{id:Number(owner),is_bot:false,first_name:'Owner'},text:'/pair'} as Message;
test('trusted local control excludes groups, forwarded or quoted commands and other identities',()=>{
 const hadTelegram=config.telegramAllowed.has(owner),hadSandbox=config.sandbox.allowed.has(owner);config.telegramAllowed.add(owner);config.sandbox.allowed.add(owner);
 try {
 assert.equal(trustedLocalOwner(message),owner);
 for(const change of [{chat:{id:-1,type:'group'}},{from:{id:2,is_bot:false,first_name:'Other'}},{from:{...message.from,is_bot:true}},{forward_origin:{type:'hidden_user',sender_user_name:'x',date:1}},{via_bot:{id:2,is_bot:true,first_name:'bot'}},{quote:{text:'/pair',position:0}}]) assert.equal(trustedLocalOwner({...message,...change} as Message),undefined);
 }finally{if(!hadTelegram)config.telegramAllowed.delete(owner);if(!hadSandbox)config.sandbox.allowed.delete(owner);}
});
test('local execution tools are bound only in workers, pairing and approval never model tools',()=>{
 const brain=readFileSync(new URL('../src/brain.ts',import.meta.url),'utf8');const work=readFileSync(new URL('../src/work-tools.ts',import.meta.url),'utf8');const worker=readFileSync(new URL('../src/worker.ts',import.meta.url),'utf8');
 assert(!brain.includes('localDeviceTools'));assert(!work.includes('localDeviceTools'));assert(worker.includes('localDeviceTools(job.incoming'));assert(!work.includes('issuePairCode'));assert(!worker.includes('issuePairCode'));assert(!worker.includes('.approve('));
});
