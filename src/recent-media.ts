import type { PreparedMedia } from './media.js';
import type { StoredMessage } from './history.js';

type Retained = { id: string; at: number; senderId: string; caption: string; images: Buffer[]; text: string };
/** Volatile bounded attachments, never disk/base64 JSON. Scoped to chat and sender. */
export class RecentMedia {
 private readonly chats=new Map<string,Retained[]>();
 constructor(private readonly maxImages=4,private readonly maxBytes=8*1024*1024,private readonly ttlMs=24*60*60*1000,private readonly maxChats=64){}
 add(chat:string,id:string,senderId:string,caption:string,media:PreparedMedia,at=Date.now()):void{
  const images=media.images.filter(image=>image.length<=this.maxBytes).slice(-this.maxImages).map(image=>Buffer.from(image));
  let items=(this.chats.get(chat)??[]).filter(item=>item.id!==id&&at-item.at<=this.ttlMs);
  if(images.length||media.text)items.push({id,senderId,at,caption:caption.slice(0,1000),images,text:media.text.slice(0,6000)});
  let bytes=items.reduce((total,item)=>total+item.images.reduce((n,image)=>n+image.length,0),0);
  let count=items.reduce((n,item)=>n+item.images.length,0);
  while(items.length&&(bytes>this.maxBytes||count>this.maxImages||items.length>4)){const old=items.shift()!;bytes-=old.images.reduce((n,image)=>n+image.length,0);count-=old.images.length;}
  this.chats.delete(chat);this.chats.set(chat,items);
  while(this.chats.size>this.maxChats)this.chats.delete(this.chats.keys().next().value!);
 }
 get(chat:string,senderId:string,history:StoredMessage[],now=Date.now()):Retained[]{
  const items=(this.chats.get(chat)??[]).filter(item=>now-item.at<=this.ttlMs);
  this.chats.set(chat,items);
 return items.filter(item=>item.senderId===senderId&&history.some(message=>message.role==='user'&&message.at===item.at)).map(item=>({...item,images:item.images.map(image=>Buffer.from(image))}));
 }
}
export const recentMedia=new RecentMedia();
