import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getMediaKeys, type proto } from 'baileys';
import { downloadAttachment } from './attachment-download.js';
/** Use Baileys key derivation with bounded authenticated ciphertext, not its unrestricted URL fetch. */
export async function whatsappImage(image:proto.Message.IImageMessage,maxBytes:number,signal:AbortSignal,download=downloadAttachment):Promise<Buffer> {
 const size=Number(image.fileLength);
 if(!Number.isSafeInteger(size)||size<1||size>maxBytes||!image.mediaKey||image.mediaKey.length!==32||image.fileSha256?.length!==32||image.fileEncSha256?.length!==32)throw new Error('Image metadata unavailable');
 // Ignore message-supplied hosts. A direct path may only select a resource on the fixed media origin.
 if(!image.directPath||!image.directPath.startsWith('/')||image.directPath.startsWith('//')||image.directPath.includes('\\'))throw new Error('Image path unavailable');
 const encrypted=await download('https://mmg.whatsapp.net'+image.directPath,'whatsapp',maxBytes+32,signal);
 signal.throwIfAborted();
 if(encrypted.length<26||!timingSafeEqual(createHash('sha256').update(encrypted).digest(),Buffer.from(image.fileEncSha256)))throw new Error('Image integrity unavailable');
 const {iv,cipherKey,macKey}=await getMediaKeys(image.mediaKey,'image');
 if(!macKey)throw new Error('Image keys unavailable');
 const body=encrypted.subarray(0,-10),mac=encrypted.subarray(-10);
 if(!timingSafeEqual(createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10),mac))throw new Error('Image integrity unavailable');
 const decipher=createDecipheriv('aes-256-cbc',cipherKey,iv);
 const data=Buffer.concat([decipher.update(body),decipher.final()]);
 if(data.length!==size||data.length>maxBytes||!timingSafeEqual(createHash('sha256').update(data).digest(),Buffer.from(image.fileSha256)))throw new Error('Image integrity unavailable');
 return data;
}
