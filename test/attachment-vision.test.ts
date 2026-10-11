import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,createCipheriv,randomBytes} from 'node:crypto';
import {getMediaKeys} from 'baileys';
import {APICallError} from 'ai';
import sharp from 'sharp';
import {attachmentUrl,publicAttachmentAddress,downloadAttachment} from '../src/attachment-download.js';
import {whatsappImage} from '../src/whatsapp-image.js';
import {prepareIncomingMedia} from '../src/media.js';
import {config} from '../src/config.js';
import {unsupportedVision,withoutImages} from '../src/vision.js';
test('fixed platform HTTPS origins and paths reject arbitrary URLs, credentials, ports, redirects-to-private and DNS rebinding ranges',async()=>{
 for(const url of ['http://cdn.discordapp.com/attachments/x','https://cdn.discordapp.com.evil.test/attachments/x','https://user@cdn.discordapp.com/attachments/x','https://cdn.discordapp.com:8443/attachments/x','https://127.0.0.1/attachments/x','https://cdn.discordapp.com/not-attachments/x'])assert.throws(()=>attachmentUrl(url,'discord'));
 assert.doesNotThrow(()=>attachmentUrl('https://cdn.discordapp.com/attachments/1/2/photo.png?ex=123','discord'));
 for(const address of ['127.0.0.1','0.0.0.0','10.1.1.1','172.16.0.1','169.254.169.254','192.168.0.1','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicAttachmentAddress(address),false,address);
 assert.equal(publicAttachmentAddress('1.1.1.1'),true);
 const abort=new AbortController();abort.abort();await assert.rejects(async()=>downloadAttachment('https://cdn.discordapp.com/attachments/x','discord',1024,abort.signal));
});
test('WhatsApp synthetic ciphertext HMAC and plaintext/encrypted hashes verified, fixed origin ignores embedded host',async()=>{
 const plain=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();const key=randomBytes(32);const {cipherKey,iv,macKey}=await getMediaKeys(key,'image');
 const cipher=createCipheriv('aes-256-cbc',cipherKey,iv),body=Buffer.concat([cipher.update(plain),cipher.final()]);const encrypted=Buffer.concat([body,createHmac('sha256',macKey!).update(iv).update(body).digest().subarray(0,10)]);
 const image={fileLength:plain.length,mediaKey:key,fileSha256:createHash('sha256').update(plain).digest(),fileEncSha256:createHash('sha256').update(encrypted).digest(),directPath:'/v/fixture',url:'http://127.0.0.1/private',mimetype:'image/png'};
 let reads=0;const download:any=async(url:string,platform:string,max:number)=>{reads++;assert.equal(url,'https://mmg.whatsapp.net/v/fixture');assert.equal(platform,'whatsapp');assert.equal(max,1024+32);return encrypted;};
 assert.deepEqual(await whatsappImage(image,1024,new AbortController().signal,download),plain);
 for(const patch of [{fileLength:2048},{mediaKey:Buffer.alloc(1)},{fileSha256:Buffer.alloc(32)},{fileEncSha256:Buffer.alloc(32)},{directPath:'//127.0.0.1/x'}])await assert.rejects(whatsappImage({...image,...patch},1024,new AbortController().signal,download));
 assert.ok(reads<7);
 const altered=Buffer.from(encrypted);altered[altered.length-1]^=1;
 await assert.rejects(whatsappImage({...image,fileEncSha256:createHash('sha256').update(altered).digest()},1024,new AbortController().signal,async()=>altered),/integrity/);
});
test('media errors become truthful text; sniff rejects SVG/GIF/malformed/20MP, count capped; no byte persistence',async()=>{
 const png=await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer();
 const malformed=await prepareIncomingMedia([{kind:'image',mime:'image/png',data:Buffer.from('secret malformed bytes')}]);assert.equal(malformed.images.length,0);assert.match(malformed.text,/unavailable/);assert.doesNotMatch(malformed.text,/secret/);
 const svg=Buffer.from('<svg width="1" height="1"><rect width="1" height="1"/></svg>');const prepared=await prepareIncomingMedia([{kind:'image',mime:'image/png',data:svg}]);assert.equal(prepared.images.length,0);
 const giant=await sharp({create:{width:5000,height:4001,channels:3,background:'white'}}).png().toBuffer();assert.equal((await prepareIncomingMedia([{kind:'image',mime:'image/png',data:giant}])).images.length,0);
 assert.equal((await prepareIncomingMedia(Array.from({length:5},()=>({kind:'image',mime:'image/png',data:png})))).images.length,4);
 const enabled=config.visionEnabled;try{config.visionEnabled=false;const off=await prepareIncomingMedia([{kind:'image',mime:'image/png',data:png}]);assert.equal(off.images.length,0);assert.match(off.text,/disabled/);}finally{config.visionEnabled=enabled;}
 assert.deepEqual(await prepareIncomingMedia([{kind:'image',mime:'image/png',data:png}],()=>false),{images:[],text:''});
});
test('vision retry is limited to explicit provider rejection, never auth/network/general failure; strips all image parts',()=>{
 const make=(status:number,message:string)=>new APICallError({url:'https://fixture.invalid',requestBodyValues:{},message,statusCode:status});
 assert.equal(unsupportedVision(make(400,'model does not support image input')),true);
 for(const error of [make(401,'image unsupported'),make(500,'image unsupported'),make(400,'invalid payload'),new Error('image unsupported')])assert.equal(unsupportedVision(error),false);
 const messages=withoutImages([{role:'user',content:[{type:'text',text:'caption'},{type:'image',image:Buffer.from('bytes')},{type:'file',data:Buffer.from('bytes'),mediaType:'image/png'}]}]);assert.doesNotMatch(JSON.stringify(messages),/bytes|image\/png/);assert.match(JSON.stringify(messages),/caption|unavailable/);
});

test('real downloader response handling declines redirects/compressed or oversize streams, bounded success, generic errors',async()=>{
 const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
 async function attempt(status:number,headers:Record<string,string>,chunks:Buffer[]){
  const response:any=new PassThrough();response.statusCode=status;response.headers=headers;
  const requester:any=(_url:any,options:any,callback:any)=>{assert.equal(options.agent,false);assert.equal(options.family,4);assert.equal(options.headers['Accept-Encoding'],'identity');
   const req:any=new EventEmitter();req.end=()=>setImmediate(()=>{callback(response);if(!response.destroyed){for(const chunk of chunks)response.write(chunk);response.end();}});return req;};
  return downloadAttachment('https://cdn.discordapp.com/attachments/x','discord',8,new AbortController().signal,requester);
 }
 assert.deepEqual(await attempt(200,{'content-length':'3'},[Buffer.from('abc')]),Buffer.from('abc'));
 for(const [status,headers,chunks]of [[302,{location:'http://127.0.0.1/private'},[]],[200,{'content-length':'9'},[]],[200,{'content-encoding':'gzip'},[]],[200,{},[Buffer.alloc(5),Buffer.alloc(4)]],[500,{},[]]] as const)await assert.rejects(attempt(status,headers as any,[...chunks]),/unavailable or over limit/);
});
