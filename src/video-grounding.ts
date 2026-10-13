import {parseFragment} from 'parse5';
import {createHash,randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';

export type SearchEvidence={used:boolean;queries:string[];sources:{url:string;title:string;start?:number;end?:number}[];suggestions:string[];usage:Record<string,unknown>;original:string;complete:boolean};
const cappedString=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n?v:undefined;
const safeLink=(s:string)=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port;}catch{return false;}};
/** Only called with provider-response fields. Never accepts a model HTML part. Reject, never rewrite. */
export function trustedSuggestions(html:string):string {
 if(!html.trim()||Buffer.byteLength(html)>65536)throw new Error('Search suggestions unavailable');
 const tree=parseFragment(html);let nodes=0;
 const visit=(node:any)=>{if(++nodes>4096)throw new Error('Search suggestions too large');
  if(node.tagName){
   if(!new Set(['div','span','a','style','svg','path','g','circle','rect','polygon','polyline','line','title','p','br']).has(node.tagName))throw new Error('Unsupported Search suggestions markup');
   for(const a of node.attrs??[]){
    if(a.name.startsWith('on')||['src','srcdoc','action','formaction','ping','id','name'].includes(a.name)||(a.namespace&&!(a.name==='xmlns'&&a.value==='http://www.w3.org/2000/svg')))throw new Error('Active Search suggestions markup');
    if(a.name==='href'&&!safeLink(a.value))throw new Error('Unsafe Search suggestions link');
    if(a.name==='target'&&!['_blank','_self'].includes(a.value))throw new Error('Unsafe Search suggestions target');
   }
  }
  for(const child of node.childNodes??[])visit(child);
 };visit(tree);return html;
}
export class SearchCollector {
 private called=false;private queries=new Set<string>();private sources=new Map<string,SearchEvidence['sources'][number]>();private suggestions=new Set<string>();private usage:Record<string,unknown>={};
 step(v:any){
  if(v?.type==='google_search_call'){this.called=true;for(const q of v.arguments?.queries??[])this.query(q);}
  if(v?.type==='google_search_result'){
   this.called=true;
   if(v.is_error)return;
   if(v.result===undefined)return;
   if(!Array.isArray(v.result)||v.result.length>32)throw new Error('Invalid search result metadata');
   for(const r of v.result){const h=cappedString(r?.search_suggestions,65536);if(h)this.suggestions.add(h);}
  }
  if(v?.type==='text'||v?.type==='text_annotation_delta'){for(const a of v.annotations??[])this.annotation(a);}
 }
 private query(v:unknown){const s=cappedString(v,1000);if(s){if(this.queries.size>=32&&!this.queries.has(s))throw new Error('Search query cap');this.queries.add(s);}}
 private annotation(a:any){if(a?.type!=='url_citation')return;const url=cappedString(a.url,2000),title=cappedString(a.title,1000)??'';if(!url||!safeLink(url))return;
  const start=a.start_index,end=a.end_index;
  if(start!==undefined&&(!Number.isSafeInteger(start)||start<0)||end!==undefined&&(!Number.isSafeInteger(end)||end<0)||start!==undefined&&end!==undefined&&end<start)throw new Error('Invalid citation span');
  if(this.sources.size>=64&&!this.sources.has(url))throw new Error('Search source cap');
  this.sources.set(url,{url,title,start,end});
 }
 interaction(v:any){
  if(v?.usage&&typeof v.usage==='object')this.usage=v.usage;
  for(const o of v?.steps??[]){
   this.step(o);
   for(const c of o?.content??[])this.step(c);
  }
 }
 generate(v:any){
  const meta=v?.candidates?.[0]?.groundingMetadata;
  const usage=v?.usageMetadata;this.usage=usage&&typeof usage==='object'?usage:{};
  if(!meta)return;
  if(meta.webSearchQueries?.length||meta.groundingChunks?.length||meta.searchEntryPoint?.renderedContent)this.called=true;
  for(const q of meta.webSearchQueries??[])this.query(q);
  const h=cappedString(meta.searchEntryPoint?.renderedContent,65536);if(h)this.suggestions.add(h);
  for(const c of meta.groundingChunks??[]){if(c.web)this.annotation({type:'url_citation',url:c.web.uri,title:c.web.title});}
  for(const s of meta.groundingSupports??[]){if(s.segment){const a=s.segment.startIndex,b=s.segment.endIndex;if(a!==undefined&&(!Number.isSafeInteger(a)||a<0)||b!==undefined&&(!Number.isSafeInteger(b)||b<0)||a!==undefined&&b!==undefined&&b<a)throw new Error('Invalid citation span');}}
 }
 finish(original:string):SearchEvidence{
  const count=Array.isArray(this.usage.grounding_tool_count)?this.usage.grounding_tool_count.find((v:any)=>v.type==='google_search')?.count:0;
  const used=this.called||Number(count)>0;
  let suggestions=[...this.suggestions],complete=!used;
  if(used){try{suggestions=suggestions.map(trustedSuggestions);complete=suggestions.length>0;}catch{suggestions=[];complete=false;}}
  return {used,queries:[...this.queries],sources:[...this.sources.values()],suggestions,usage:this.usage,original,complete};
 }
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
export const groundingHeaders={
 'Cache-Control':'no-store',
 'Referrer-Policy':'no-referrer',
 'X-Content-Type-Options':'nosniff',
 'X-Robots-Tag':'noindex, nofollow, noarchive',
 'Content-Security-Policy':"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https://www.gstatic.com; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
};
export function resultHTML(result:SearchEvidence):string{
 if(!result.used||!result.complete)throw new Error('Incomplete search display');
 const widget=result.suggestions.map(trustedSuggestions).join('\n');
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Video research</title><style>body{margin:0;background:#faf8f2;color:#262925}main{max-width:760px;margin:64px auto;padding:0 24px}header{font:13px Georgia,serif;color:#60705f;letter-spacing:.04em;padding-bottom:22px;border-bottom:1px solid #d5dbce}pre{font:18px/1.65 Georgia,serif;white-space:pre-wrap;overflow-wrap:anywhere;margin:30px 0}footer{font:12px/1.5 Georgia,serif;color:#60705f;margin-top:32px}</style></head><body><main><header>VIDEO RESEARCH · Original Gemini response</header><section><pre>'+escape(result.original)+'</pre>'+widget+'</section><footer>This private result link grants access to anyone who has it. It expires shortly. Search evidence, publisher metadata, and visual observations are not interchangeable.</footer></main></body></html>';
}
type Grant={owner:string;expires:number;html:string};
/** Short-lived delivery buffer only, not a reusable answer/suggestions cache or history. */
export class GroundingPages{
 private entries=new Map<string,Grant>();private timer:NodeJS.Timeout;
 constructor(private base:string,private authorized:(owner:string)=>boolean,private ttl=120000,private max=32,private now=Date.now){
  const u=new URL(base);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid result origin');
  if(!Number.isInteger(ttl)||ttl<1000||ttl>300000||!Number.isInteger(max)||max<1||max>128)throw new Error('Invalid result limits');
  this.timer=setInterval(()=>this.sweep(),1000);this.timer.unref();
 }
 private hash(v:string){return createHash('sha256').update('grounding-result-only\0'+v).digest('hex');}
 private sweep(){for(const [k,v] of this.entries)if(v.expires<=this.now()||!this.authorized(v.owner))this.entries.delete(k);}
 issue(owner:string,result:SearchEvidence){
  this.sweep();if(!this.authorized(owner)||!result.used||!result.complete||this.entries.size>=this.max)throw new Error('Result access unavailable');
  const html=resultHTML(result);if(Buffer.byteLength(html)>100000)throw new Error('Result body cap');
  const token=randomBytes(32).toString('hex');this.entries.set(this.hash(token),{owner,expires:this.now()+this.ttl,html});
  return {url:new URL('/video-result/'+token,this.base).href,expiresInSeconds:this.ttl/1000};
 }
 revokeOwner(owner:string){for(const [k,v] of this.entries)if(v.owner===owner)this.entries.delete(k);}
 close(){clearInterval(this.timer);this.entries.clear();}
 handle(req:IncomingMessage,res:ServerResponse):boolean{
  if(!(req.url??'').startsWith('/video-result'))return false;
  for(const [k,v] of Object.entries(groundingHeaders))res.setHeader(k,v);
  this.sweep();
  const match=/^\/video-result\/([a-f0-9]{64})$/.exec(req.url??'');
  const value=match?this.entries.get(this.hash(match[1]!)):undefined;
  if(!value||!['GET','HEAD'].includes(req.method??'')){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'});res.end('Result unavailable');return true;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:value.html);return true;
 }
}
