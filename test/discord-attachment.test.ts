import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {attachmentUrl,publicAttachmentAddress,downloadAttachment} from '../src/attachment-download.js';
test('Discord attachment origin/path denies SSRF, private addresses, credentials and redirect origins',()=>{
 for(const url of ['http://cdn.discordapp.com/attachments/1','https://127.0.0.1/attachments/1','https://cdn.discordapp.com.evil.test/attachments/1','https://cdn.discordapp.com:444/attachments/1','https://u:p@cdn.discordapp.com/attachments/1','https://cdn.discordapp.com/other','https://cdn.discordapp.com/attachments/1#x'])assert.throws(()=>attachmentUrl(url,'discord'));
 assert.equal(attachmentUrl('https://cdn.discordapp.com/attachments/1/2/a.mp4?ex=abc&hm=signed','discord').hostname,'cdn.discordapp.com');
 for(const address of ['127.0.0.1','10.1.1.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','::1','224.0.0.1'])assert.equal(publicAttachmentAddress(address),false);
 assert.equal(publicAttachmentAddress('8.8.8.8'),true);
});
test('streamed attachment caps and failures, no credentials, redirects declined',async()=>{
 const fake=(status:number,headers:any,chunks:Buffer[])=>((_url:any,opts:any,callback:any)=>{
  assert.equal(opts.headers.Authorization,undefined);assert.equal(opts.agent,false);assert.equal(opts.family,4);assert.equal(opts.headers['Accept-Encoding'],'identity');
  const req:any=new EventEmitter();req.end=()=>{const res:any=new EventEmitter();res.statusCode=status;res.headers=headers;res.destroy=()=>{};callback(res);queueMicrotask(()=>{for(const chunk of chunks)res.emit('data',chunk);res.emit('end');});};return req;
 }) as any;
 const url='https://cdn.discordapp.com/attachments/1/2/file',signal=new AbortController().signal;
 assert.deepEqual(await downloadAttachment(url,'discord',5,signal,fake(200,{},[Buffer.from('abc')])),Buffer.from('abc'));
 for(const request of [fake(302,{location:'http://127.0.0.1'},[]),fake(200,{'content-length':'6'},[]),fake(200,{},[Buffer.from('abc'),Buffer.from('def')]),fake(200,{'content-encoding':'gzip'},[])])await assert.rejects(downloadAttachment(url,'discord',5,signal,request));
 const abort=new AbortController();abort.abort();assert.throws(()=>downloadAttachment(url,'discord',5,abort.signal,fake(200,{},[])));
});
