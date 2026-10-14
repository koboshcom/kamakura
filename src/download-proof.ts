import {transferPath} from './workspace-bytes.js';
// Deliberately a small literal evidence recognizer, never a shell parser/executor.
export function literalDownloadPath(command:string):string|undefined {
 if(command.length>1500||/[;&|\`$<>\n"'\\]/.test(command))return;
 const tokens=command.trim().split(/\s+/),name=tokens.shift();if(name!=='curl'&&name!=='wget')return;
 let output:string|undefined,url:string|undefined;
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i]!;
  if(t===(name==='curl'?'-o':'-O')){if(output||!tokens[i+1])return;output=tokens[++i];continue;}
  if((name==='curl'&&/^-[fsSL]{1,4}$/.test(t))||(name==='wget'&&t==='-q'))continue;
  if(!url&&/^https?:\/\/[^\s]+$/.test(t)){try{const u=new URL(t);if(u.username||u.password)return;url=t;}catch{return;}continue;}
  return;
 }
 if(!url||!output)return;
 try{return transferPath(output);}catch{return;}
}
