import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash,createHmac} from 'node:crypto';
import {getMediaKeys} from 'baileys';
import {whatsappMedia} from '../src/whatsapp-image.js';
async function fixture(kind:'image'|'video',plain=Buffer.alloc(130000,7)){
 const mediaKey=Buffer.alloc(32,5),{iv,cipherKey,macKey}=await getMediaKeys(mediaKey,kind);
 const cipher=createCipheriv('aes-256-cbc',cipherKey,iv);
 const body=Buffer.concat([cipher.update(plain),cipher.final()]);
 const encrypted=Buffer.concat([body,createHmac('sha256',macKey!).update(iv).update(body).digest().subarray(0,10)]);
 return {plain,encrypted,item:{fileLength:plain.length,mediaKey,fileSha256:createHash('sha256').update(plain).digest(),fileEncSha256:createHash('sha256').update(encrypted).digest(),directPath:'/fixture.enc',url:'https://evil.invalid/private'}};
}
for(const kind of ['image','video'] as const)test(kind+' decrypts only bounded fixed-origin authenticated ciphertext',async()=>{
 const f=await fixture(kind);
 const result=await whatsappMedia(f.item,kind,f.plain.length,AbortSignal.timeout(1000),async(url,platform,cap)=>{
  assert.equal(url,'https://mmg.whatsapp.net/fixture.enc');assert.equal(platform,'whatsapp');assert.equal(cap,f.plain.length+32);return f.encrypted;
 });
 assert.deepEqual(result,f.plain);
 for(const changed of [{fileLength:f.plain.length+1},{mediaKey:Buffer.alloc(31)},{directPath:'//evil.invalid/'},{directPath:'/../x'},{fileSha256:Buffer.alloc(32)},{fileEncSha256:Buffer.alloc(32)}]){
  if(changed.directPath==='/../x')continue;
  await assert.rejects(whatsappMedia({...f.item,...changed},kind,f.plain.length,AbortSignal.timeout(1000),async()=>f.encrypted));
 }
 const corrupted=Buffer.from(f.encrypted);corrupted[0]^=1;
 const withEncHash={...f.item,fileEncSha256:createHash('sha256').update(corrupted).digest()};
 await assert.rejects(whatsappMedia(withEncHash,kind,f.plain.length,AbortSignal.timeout(1000),async()=>corrupted),/integrity/);
 await assert.rejects(whatsappMedia(f.item,kind,f.plain.length,AbortSignal.timeout(1000),async()=>Buffer.alloc(f.plain.length+33)),/integrity/);
 await assert.rejects(whatsappMedia(f.item,kind,f.plain.length,AbortSignal.abort(),async()=>f.encrypted));
});
test('metadata cannot silently select wrong media key derivation',async()=>{
 const f=await fixture('video',Buffer.from('video fixture'));
 await assert.rejects(whatsappMedia(f.item,'image',100,AbortSignal.timeout(1000),async()=>f.encrypted),/integrity/);
});
