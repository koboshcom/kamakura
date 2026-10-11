import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export type AttachmentPlatform='telegram'|'discord'|'whatsapp';
/** No user URL fetch tool. Only adapter-returned platform attachment locations. No redirects. */
export function attachmentUrl(raw:string,platform:AttachmentPlatform):URL {
 const url=new URL(raw);
 const hosts={telegram:['api.telegram.org'],discord:['cdn.discordapp.com','media.discordapp.net'],whatsapp:['mmg.whatsapp.net']}[platform];
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!hosts.includes(url.hostname))throw new Error('Attachment origin denied');
 if(platform==='discord'&&!url.pathname.startsWith('/attachments/'))throw new Error('Attachment path denied');
 if(platform==='telegram'&&!/^\/file\/bot[^/]+\/.+/.test(url.pathname))throw new Error('Attachment path denied');
 if(platform==='whatsapp'&&!url.pathname.startsWith('/'))throw new Error('Attachment path denied');
 return url;
}
/** IPv4-only pinned resolution. Reject non-public/special-use answers, including DNS rebinding. */
export function publicAttachmentAddress(address:string):boolean {
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number) as [number,number];
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
}
export function downloadAttachment(raw:string,platform:AttachmentPlatform,maxBytes:number,signal:AbortSignal,httpsRequest:typeof request=request):Promise<Buffer> {
 const url=attachmentUrl(raw,platform);signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const req=httpsRequest(url,{method:'GET',family:4,agent:false,signal,headers:{'Accept-Encoding':'identity'},lookup:(hostname,_options,cb)=>{
   lookup(hostname,{family:4},(error,address,family)=>{
    if(error)return cb(new Error('Attachment DNS unavailable'),'',4);
    if(!publicAttachmentAddress(address))return cb(new Error('Attachment address denied'),'',4);
    cb(null,address,family);
   });
  }},res=>{
   const fail=()=>{res.destroy();reject(new Error('Attachment download unavailable or over limit'));};
   const length=Number(res.headers['content-length']??0);
   if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||!Number.isSafeInteger(length)||length<0||length>maxBytes){fail();return;}
   const chunks:Buffer[]=[];let bytes=0;
   res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxBytes)fail();else chunks.push(chunk);});
   res.on('end',()=>resolve(Buffer.concat(chunks)));
   res.on('error',()=>reject(new Error('Attachment download interrupted')));
   res.on('aborted',()=>reject(new Error('Attachment download interrupted')));
  });
  req.on('error',()=>reject(new Error(signal.aborted?'Attachment download cancelled':'Attachment download failed')));req.end();
 });
}
