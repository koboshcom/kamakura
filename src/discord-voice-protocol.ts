export const frameBytes=960, maxLineBytes=8192;
export function pcm(value:unknown):Buffer {
 if(typeof value!=='string'||value.length!==1280||!/^[A-Za-z0-9+/]+$/.test(value))throw new Error('Invalid PCM frame');
 const bytes=Buffer.from(value,'base64');if(bytes.length!==frameBytes||bytes.toString('base64')!==value)throw new Error('Invalid PCM frame');return bytes;
}
/** Bounded byte-oriented NDJSON parser, including a partial final line. */
export class VoiceLines {
 private buffer=Buffer.alloc(0);
 feed(chunk:Buffer):unknown[]{
  const messages:unknown[]=[];let start=0;
  for(let i=0;i<chunk.length;i++)if(chunk[i]===10){
   const line=Buffer.concat([this.buffer,chunk.subarray(start,i)]);
   if(line.length>maxLineBytes)throw new Error('IPC frame too large');
   messages.push(JSON.parse(line.toString('utf8')));this.buffer=Buffer.alloc(0);start=i+1;
   if(messages.length>128)throw new Error('IPC burst too large');
  }
  this.buffer=Buffer.concat([this.buffer,chunk.subarray(start)]);
  if(this.buffer.length>maxLineBytes)throw new Error('IPC frame too large');
  return messages;
 }
 clear(){this.buffer=Buffer.alloc(0);}
}
