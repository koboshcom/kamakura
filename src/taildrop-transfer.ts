// Transfer security adapter, NOT a habit detector or pair registry.
// Only this existing CLI command receives the exact known-owner file-send exception.
import {consumeArtifact} from './send-file.js';
import {sandboxes} from './sandbox.js';
import {localDMScope} from './local-dm-context.js';
import {dangerousConfirmations} from './dangerous-confirmations.js';
import {transferStore} from './transfer-store.js';
import {transferPath} from './workspace-bytes.js';
import type {IncomingMessage} from './types.js';
export async function guardedTaildrop(m:IncomingMessage,command:string,signal?:AbortSignal,artifact_handle?:string){
 const mentions=/(?:^|[;&|\s])tailscale\s+file\s+cp\b/.test(command);if(!mentions)return;
 const matched=/^tailscale file cp ([A-Za-z0-9_/.\-]+) ([A-Za-z0-9][A-Za-z0-9.\-]{0,99}):$/.exec(command.trim());
 if(!matched)throw new Error('Use one literal workspace file and exact Taildrop device; dynamic CLI commands require manual handling');
 const scope=localDMScope(m);if(!scope||m.id!==scope.id||m.text!==scope.original||Date.now()-scope.at>120000)throw new Error('Current direct owner DM required');
 const check=()=>{signal?.throwIfAborted();if(localDMScope(m)!==scope||m.id!==scope.id||m.text!==scope.original||Date.now()-scope.at>120000)throw new Error('Transfer origin changed or expired');};
 const path=transferPath(matched[1]!),target=matched[2]!;
 check();const file=artifact_handle?await consumeArtifact(m,artifact_handle,path):await sandboxes.workspaceBytes(scope.owner,path);check();
 const enrollment=await sandboxes.tailscaleEnrollment(scope.owner);check();
 if(enrollment.box!==file.box)throw new Error('Owner box changed');
 if(!await transferStore.known(scope.owner,file.box,enrollment.enrollment,target)){
  await dangerousConfirmations.require(m,'new_file_transfer_destination',{target,box:file.box,enrollment:enrollment.enrollment,path:file.path,sha256:file.sha256,bytes:file.bytes},signal);check();
 }
 const current=await sandboxes.tailscaleEnrollment(scope.owner);check();
 if(current.box!==file.box||current.enrollment!==enrollment.enrollment)throw new Error('Tailnet enrollment changed');
 if(!await transferStore.claim(scope.owner,['taildrop',m.transport,scope.chat,scope.account,m.id,file.box,file.path,file.sha256,target,enrollment.enrollment]))throw new Error('Transfer already attempted; do not retry');
 check();const result=await sandboxes.taildropBytes(scope.owner,file,target,enrollment.enrollment);check();
 // Only actual exit-zero bounded transfer establishes destination, never stdout or historical/model claims.
 await transferStore.remember(scope.owner,file.box,enrollment.enrollment,target);
 return result;
}
