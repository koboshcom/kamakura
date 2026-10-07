import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
export function fixtureVector(text:string):number[]{
 const result=Array<number>(64).fill(0);
 for(const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))result[createHash('sha256').update(word).digest()[0]!%64]!++;
 if(!result.some(Boolean))result[0]=1;return result;
}
export async function embeddingFixture(){
 const requests:{model:string;input:string[];encoding_format:string}[]=[];
 const server=createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',model:body.model,data:body.input.map((input:string,index:number)=>({object:'embedding',index,embedding:fixtureVector(input)})),usage:{prompt_tokens:1,total_tokens:1}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};
 return {requests,url:'http://127.0.0.1:'+address.port+'/v1',close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})};
}
