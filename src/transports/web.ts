import {createServer,type Server} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import type {IncomingMessage,Transport} from '../types.js';
export interface DebugWebConfig {host:string;port:number;owner:string;token:string}
export function debugWebConfig(env:NodeJS.ProcessEnv=process.env):DebugWebConfig|undefined {
 if(env.DEBUG_WEBCHAT!=='1')return;
 const host=env.DEBUG_WEBCHAT_HOST||'127.0.0.1',port=Number(env.DEBUG_WEBCHAT_PORT||47863),owner=env.DEBUG_WEBCHAT_OWNER_ID||'',token=env.DEBUG_WEBCHAT_TOKEN||randomBytes(32).toString('hex');
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid DEBUG_WEBCHAT_PORT');
 if(!/^[1-9]\d{0,19}$/.test(owner))throw new Error('DEBUG_WEBCHAT_OWNER_ID must be numeric');
 if(!['127.0.0.1','::1'].includes(host)&&!token)throw new Error('DEBUG_WEBCHAT_TOKEN required for non-loopback bind');
 return {host,port,owner,token};
}
interface Entry {id:string;role:'user'|'assistant';text:string}
export class DebugWebTransport implements Transport {
 readonly name='web' as const;
 private server?:Server;
 private tunnel?:ChildProcess;
 private publicOrigin?:string;
 private entries:Entry[]=[];
 constructor(readonly config:DebugWebConfig,private readonly tunnelEnabled=true){}
 private append(role:Entry['role'],text:string,id:string=randomUUID()):void {this.entries.push({id,role,text});if(this.entries.length>500)this.entries.shift();}
 async start(onMessage:(message:IncomingMessage)=>void):Promise<void> {
  const cfg=this.config;
  this.server=createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
   const url=new URL(req.url||'/', 'http://localhost');
   const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
   const host=req.headers.host,expected=(cfg.host.includes(':')?'['+cfg.host+']':cfg.host)+':'+cfg.port;
   const remote=Boolean(this.publicOrigin&&host===new URL(this.publicOrigin).host);
   const wildcard=cfg.host==='0.0.0.0'||cfg.host==='::';
   if((!remote&&!wildcard&&host!==expected)||(req.headers.origin&&req.headers.origin!==(remote?this.publicOrigin:'http://'+host))){reply(403,{error:'Invalid host or origin'});return;}
   if(url.pathname==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});res.end(page);return;}
   if(cfg.token&&req.headers.authorization!=='Bearer '+cfg.token){reply(401,{error:'Token required'});return;}
   if(url.pathname==='/messages'&&req.method==='GET'){reply(200,this.entries);return;}
   if(url.pathname!=='/messages'||req.method!=='POST'){reply(404,{error:'Not found'});return;}
   if(req.headers['content-type']!=='application/json'){reply(415,{error:'JSON required'});return;}
   try {
    let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>32768){reply(413,{error:'Message too large'});return;}}
    const data=JSON.parse(body) as {text?:unknown};
    if(typeof data.text!=='string'||!data.text.trim()||data.text.length>8000){reply(400,{error:'Text required, maximum 8000 characters'});return;}
    const id=randomUUID();
    onMessage({transport:'web',chatId:cfg.owner,senderId:cfg.owner,sender:'Debug owner',authenticatedOwner:true,credentialEligible:false,learningEligible:false,isGroup:false,addressed:true,text:data.text,id,timestamp:Date.now()});
    this.append('user',data.text,id);reply(202,{id});
   }catch{reply(400,{error:'Message rejected'});}
  });
  await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(cfg.port,cfg.host,resolve);});
  console.log('Debug web chat http://127.0.0.1:'+cfg.port+'/?token='+encodeURIComponent(cfg.token));
  if(!this.tunnelEnabled)return;
  this.tunnel=spawn('cloudflared',['tunnel','--url','http://127.0.0.1:'+cfg.port,'--no-autoupdate'],{stdio:['ignore','ignore','pipe']});
  let output='';this.tunnel.stderr?.on('data',(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-8192);const match=output.match(new RegExp('https://[a-z0-9-]+[.]trycloudflare[.]com'));if(match&&!this.publicOrigin){this.publicOrigin=match[0];console.log('Debug web chat public '+this.publicOrigin+'/?token='+encodeURIComponent(cfg.token));}});
  this.tunnel.on('error',()=>console.error('Debug web chat tunnel failed; install cloudflared'));

 }
 async send(chatId:string,text:string):Promise<void>{if(chatId!==this.config.owner)throw new Error('Unknown debug chat');this.append('assistant',text);}
 async react(message:IncomingMessage,emoji:string):Promise<void>{await this.send(message.chatId,emoji);}
 async stop():Promise<void>{this.tunnel?.kill('SIGTERM');this.tunnel=undefined;if(this.server){this.server.closeAllConnections();await new Promise<void>((resolve,reject)=>this.server!.close(error=>error?reject(error):resolve()));this.server=undefined;}}
}
const page="<!doctype html><html><head><meta charset=\"utf-8\"><title>Kamakura debug chat</title></head><body><h1>Debug chat</h1><label>Token <input id=\"token\" type=\"password\" autocomplete=\"off\"></label><div id=\"messages\" aria-live=\"polite\"></div><form id=\"chat\"><label>Message <input id=\"text\" required maxlength=\"8000\"></label><button>Send</button></form><p id=\"status\" role=\"status\"></p><script>\nconst token=document.querySelector('#token'),text=document.querySelector('#text'),status=document.querySelector('#status');\ntoken.value=new URLSearchParams(location.search).get('token')||'';history.replaceState(null,'',location.pathname);\nfunction headers(){return {'Content-Type':'application/json',...(token.value?{Authorization:'Bearer '+token.value}:{})};}\nasync function poll(){try{const r=await fetch('/messages',{headers:headers()});if(!r.ok)throw Error('HTTP '+r.status);const entries=await r.json();const list=document.querySelector('#messages');list.replaceChildren();for(const entry of entries){const p=document.createElement('p');p.textContent=entry.role+': ';for(const part of entry.text.split(/(https?:\\/\\/[^\\s<>]+)/g)){if(/^https?:\\/\\//.test(part)){const a=document.createElement('a');a.href=part;a.textContent=part;a.target='_blank';a.rel='noopener noreferrer';p.append(a);}else p.append(document.createTextNode(part));}list.append(p);}status.textContent='';}catch(e){status.textContent=e.message;}}\ndocument.querySelector('#chat').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/messages',{method:'POST',headers:headers(),body:JSON.stringify({text:text.value})});if(!r.ok)throw Error('HTTP '+r.status);text.value='';await poll();}catch(e){status.textContent=e.message;}};setInterval(poll,1000);poll();\n</script></body></html>";
