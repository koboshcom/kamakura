import {currentOriginDestination} from './destination-policy.js';
import {randomBytes} from 'node:crypto';
import {tool,type ToolSet} from 'ai';
import {z} from 'zod';
import {localDMScope} from './local-dm-context.js';
import {sandboxes} from './sandbox.js';
import {transferStore} from './transfer-store.js';
import {transferPath} from './workspace-bytes.js';
import type {IncomingMessage} from './types.js';
type Artifact={scope:NonNullable<ReturnType<typeof localDMScope>>;path:string;sha256:string;box:string;bytes:number;expires:number;used:boolean};
const artifacts=new Map<string,Artifact>();
export async function executionArtifacts(m:IncomingMessage,started:number){
 const scope=localDMScope(m);if(!scope||Date.now()-scope.at>120000||m.text!==scope.original)return [];
 for(const [key,value] of artifacts)if(value.expires<=Date.now()||value.used)artifacts.delete(key);
 if(artifacts.size>=128)return [];
 const paths=await sandboxes.changedWorkspaceFiles(scope.owner,started);
 const found:Array<{artifact_handle:string;path:string;bytes:number}>=[];
 let bytes=0;
 for(const path of paths){
  if(found.length>=4)break;
  try{
   const file=await sandboxes.workspaceBytes(scope.owner,path,8*1024*1024-bytes);
   if(localDMScope(m)!==scope||Date.now()-scope.at>120000)return [];
   bytes+=file.bytes;
   const handle=randomBytes(24).toString('hex');
   artifacts.set(handle,{scope,path:file.path,sha256:file.sha256,box:file.box,bytes:file.bytes,expires:Date.now()+120000,used:false});
   found.push({artifact_handle:handle,path:file.path,bytes:file.bytes});
  }catch{}
 }
 return found;
}
export async function consumeArtifact(m:IncomingMessage,handle:string,expectedPath:string){
 const scope=localDMScope(m),a=artifacts.get(handle);
 if(!scope||!a||a.scope!==scope||a.used||a.expires<=Date.now()||transferPath(expectedPath)!==a.path)throw new Error('Current same-file artifact required');
 const file=await sandboxes.workspaceBytes(scope.owner,a.path);
 if(localDMScope(m)!==scope||a.used||a.expires<=Date.now()||file.sha256!==a.sha256||file.box!==a.box||file.bytes!==a.bytes)throw new Error('Artifact changed or expired');
 a.used=true;return file;
}
export function sendFileTools(m:IncomingMessage,signal?:AbortSignal):ToolSet{
 const scope=localDMScope(m);if(!scope?.upload)return {};
 const check=()=>{signal?.throwIfAborted();currentOriginDestination(m);if(localDMScope(m)!==scope||m.text!==scope.original||m.id!==scope.id||Date.now()-scope.at>120000)throw new Error('Current owner origin DM expired');};
 return {send_file:tool({description:'Upload one nonsecret regular file from your owner sandbox /work workspace to THIS authenticated immutable origin DM only. No destination argument or host access. Existing media cap or 8 MiB, whichever smaller. Symlinks, nested mounts, secret-like names and recognizable credentials are denied. This current-owner DM delivery does not need generic external-send confirmation. Delivery failures and ambiguous SDK acknowledgements must NOT be retried automatically. For a learned followup use ONLY the current successful execution artifact_handle, never a historical path or substituted file. Handles expire after two minutes and are bound to this exact owner DM turn.',inputSchema:z.object({path:z.string().min(1).max(240).optional(),artifact_handle:z.string().regex(/^[a-f0-9]{48}$/).optional()}).strict(),execute:async({path,artifact_handle})=>{
  check();if(!!path===!!artifact_handle)throw new Error('Choose exactly one path or fresh artifact handle');
  const a=artifact_handle?artifacts.get(artifact_handle):undefined;
  if(artifact_handle&&(!a||a.used||a.scope!==scope||a.expires<=Date.now()))throw new Error('Artifact expired or foreign');
  const file=await sandboxes.workspaceBytes(scope.owner,transferPath(a?.path??path!));check();
  if(a){if(file.sha256!==a.sha256||file.bytes!==a.bytes||file.box!==a.box)throw new Error('Artifact changed');a.used=true;}
  if(!await transferStore.claim(scope.owner,['send_file',m.transport,scope.chat,scope.account,m.id,file.box,file.path,file.sha256]))throw new Error('File upload already attempted, do not retry');
  check();const sent=await scope.upload!({data:file.data,filename:file.path.split('/').at(-1)!});check();
  if(!sent?.receipt)throw new Error('File upload unconfirmed, do not retry');
  return {sent:true,bytes:file.bytes,receipt:sent.receipt};
 }})};
}
