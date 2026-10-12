import test from 'node:test';
import assert from 'node:assert/strict';
import {videoLimits,publicVideoURL,videoArtifacts,videoLinkTools} from '../src/video-link.js';
import {SandboxManager} from '../src/sandbox.js';
const limits=videoLimits({});
const frame=Buffer.from([255,216,1,255,217]).toString('base64');
const good={ok:true,frames:[frame],audio:null,seconds:20,transferBytes:5};
test('video defaults bounded and env caps fail closed',()=>{assert.equal(limits.frames,6);for(const [k,v] of [['VIDEO_LINK_FRAMES','99'],['VIDEO_LINK_SECONDS','0'],['VIDEO_LINK_MAX_BYTES','999999999'],['VIDEO_LINK_TIMEOUT_SECONDS','NaN']])assert.throws(()=>videoLimits({[k!]:v}));});
test('primary URL rejects credentials protocols control shell options ports',()=>{for(const url of ['file:///etc/passwd','ftp://example.com/x','https://a:b@example.com/x','https://example.com:22/x','https://example.com/\nx','--exec rm'])assert.throws(()=>publicVideoURL(url));assert.equal(publicVideoURL('https://example.com/watch?v=abc'),'https://example.com/watch?v=abc');});
test('copy boundary accepts only capped generated artifacts',()=>{assert.equal(videoArtifacts(JSON.stringify(good),limits).frames.length,1);for(const change of [{frames:Array(9).fill(frame)},{frames:['Li4vZXRjL3Bhc3N3ZA==']},{audio:'Li4vZXRjL3Bhc3N3ZA=='},{seconds:100},{transferBytes:limits.bytes+1},{ok:false},{frames:['!']}])assert.throws(()=>videoArtifacts(JSON.stringify({...good,...change}),limits));});
test('feature off and unbound Discord cannot obtain owner tool',()=>{const previous=process.env.VIDEO_LINK_ENABLED;process.env.VIDEO_LINK_ENABLED='true';try{assert.deepEqual(videoLinkTools({transport:'discord',senderId:'discord-1112392784117235752',chatId:'bogus',sender:'x',id:'1',text:'inspect',isGroup:false,timestamp:0}),{});}finally{if(previous===undefined)delete process.env.VIDEO_LINK_ENABLED;else process.env.VIDEO_LINK_ENABLED=previous;}});
test('unauthorized owner denied before box access',async()=>{const m=new SandboxManager({...({} as any),allowed:new Set(['42'])},{} as any);await assert.rejects(m.inspectVideo('43','https://example.com/x',limits),/not authorized/);});
test('owner serial API uses direct argv and clean environment, no caller shell',async()=>{
 const s={allowed:new Set(['42']),commandMs:30000,maxOutput:10} as any;
 const m=new SandboxManager(s,{} as any);const captured:any[]=[];
 (m as any).container=async(id:string)=>{assert.equal(id,'42');return {};};
 (m as any).execute=async(...args:any[])=>{captured.push(args);return {output:JSON.stringify(good),exitCode:0,timedOut:false,truncated:false};};
 const url="https://example.com/v?q=$(touch%20/tmp/no)";
 const data=await m.inspectVideo('42',url,limits);
 assert.equal(data.frames.length,1);const argv=captured[0][3] as string[];
 assert.equal(captured[0][1],'');assert.equal(argv[0],'env');assert.equal(argv[1],'-i');
 assert.ok(!argv.includes('bash'));assert.ok(argv.includes('YTDLP_NO_PLUGINS=1'));
 const payload=JSON.parse(Buffer.from(argv.at(-1)!,'base64').toString());assert.equal(payload.url,url);
 assert.equal(payload.timeout,25);
 (m as any).execute=async()=>({output:JSON.stringify(good),exitCode:0,timedOut:false,truncated:true});
 await assert.rejects(m.inspectVideo('42',url,limits),/exceeded limits/);
});
test('authenticated owner tool returns frames only under explicit vision, no implicit STT',async()=>{
 const {config}=await import('../src/config.js');const {sandboxes}=await import('../src/sandbox.js');
 const env={enabled:process.env.VIDEO_LINK_ENABLED,vision:process.env.VISION_ENABLED};
 const old=(sandboxes as any).inspectVideo;const allowed=config.sandbox.allowed.has('42'),tg=config.telegramAllowed.has('42');
 process.env.VIDEO_LINK_ENABLED='true';process.env.VISION_ENABLED='true';config.sandbox.allowed.add('42');config.telegramAllowed.add('42');
 (sandboxes as any).inspectVideo=async(owner:string)=>{assert.equal(owner,'42');return {frames:[Buffer.from([255,216,1,255,217])],seconds:20,transferBytes:5};};
 try{
  const incoming={transport:'telegram' as const,chatId:'42',senderId:'42',id:'1',sender:'x',text:'inspect https://example.com/v',isGroup:false,timestamp:0};
  const t:any=videoLinkTools(incoming);assert.ok(t.inspect_video_url);
  const result=await t.inspect_video_url.execute({url:'https://example.com/v'},{});assert.equal(result.images.length,1);assert.match(result.text,/No audio stream/);
  process.env.VISION_ENABLED='false';
  const hidden=await t.inspect_video_url.execute({url:'https://example.com/v'},{});assert.equal(hidden.images.length,0);assert.match(hidden.text,/Vision disabled/);
  assert.deepEqual(videoLinkTools({...incoming,chatId:'43'}),{});
 }finally{(sandboxes as any).inspectVideo=old;if(!allowed)config.sandbox.allowed.delete('42');if(!tg)config.telegramAllowed.delete('42');for(const [key,value] of [['VIDEO_LINK_ENABLED',env.enabled],['VISION_ENABLED',env.vision]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
});
