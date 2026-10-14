import {localDMScope} from './local-dm-context.js';
import {dangerousConfirmations} from './dangerous-confirmations.js';
import {transferStore} from './transfer-store.js';
import type {IncomingMessage} from './types.js';
type Scope=NonNullable<ReturnType<typeof localDMScope>>;
type Metadata={owner:string;target:string;box:string;authority:string};
type Proof={scope:Scope;metadata:Metadata;current:()=>boolean};
const proofs=new WeakMap<object,Proof>();
/** Server-only adapter integration. The resolver must verify actual current registered
 * recipient/device fields against its owner mapping. No model-supplied "known" boolean,
 * shell text or destination inference is accepted by this API. */
export async function resolveDestination(m:IncomingMessage,resolve:()=>Promise<{metadata:Metadata;current:()=>boolean}|undefined>){
 const scope=localDMScope(m);if(!scope)return;
 const resolved=await resolve();
 if(!resolved||resolved.metadata.owner!==scope.owner||!resolved.current()||localDMScope(m)!==scope)return;
 const d=resolved.metadata;
 if(!d.target||d.target.length>200||!d.box||d.box.length>200||!d.authority||d.authority.length>200)return;
 const token=Object.freeze({});proofs.set(token,{scope,metadata:{...d},current:resolved.current});return token;
}
export async function destinationPolicy(m:IncomingMessage,action:string,args:unknown,proof?:object,dangerous=false,signal?:AbortSignal){
 const scope=localDMScope(m);if(!scope)throw new Error('Current direct owner required');
 const verified=proof?proofs.get(proof):undefined;
 const valid=verified&&verified.scope===scope&&verified.current();
 const known=valid&&await transferStore.known(scope.owner,verified.metadata.box,verified.metadata.authority,verified.metadata.target);
 if(dangerous||!known)await dangerousConfirmations.require(m,action,args,signal);
 if(localDMScope(m)!==scope||verified&&!verified.current())throw new Error('Destination or origin changed');
 return async(receipt:unknown)=>{
  if(!receipt||localDMScope(m)!==scope||!valid||!verified.current())throw new Error('Verified actual destination receipt required');
  await transferStore.remember(scope.owner,verified.metadata.box,verified.metadata.authority,verified.metadata.target);
 };
}
export function currentOriginDestination(m:IncomingMessage){
 const scope=localDMScope(m);
 if(!scope?.upload||m.id!==scope.id||m.text!==scope.original||Date.now()-scope.at>120000)throw new Error('Current origin DM unavailable');
 return scope;
}
