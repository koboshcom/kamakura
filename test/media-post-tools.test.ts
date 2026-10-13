import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {config} from '../src/config.js';
import {sandboxes} from '../src/sandbox.js';
import {videoLinkTools} from '../src/video-link.js';
import {postCaps,parseMediaPost} from '../src/media-post.js';
test('actual post route, fresh questions, shared owner/channel slides, caps and TTL',async()=>{
 const env={...process.env},fetcher=globalThis.fetch,extract=sandboxes.inspectInstagramPost,now=Date.now;
 const id='929292',other='939393';for(const n of [id,other]){config.sandbox.allowed.add(n);config.telegramAllowed.add(n);}
 Object.assign(process.env,{VIDEO_LINK_ENABLED:'true',GEMINI_VIDEO_BASE_URL:'https://fixture.example',GEMINI_VIDEO_KEY:'fixture-private',GEMINI_VIDEO_MODEL:'fixture',GEMINI_VIDEO_GOOGLE_SEARCH:'false'});delete process.env.GEMINI_VIDEO_SEARCH_GROUNDING;
 let extracted=0,generated=0;const questions:string[]=[];const data=Buffer.from([255,216,255,224]);
 sandboxes.inspectInstagramPost=async(owner,url,c)=>{extracted++;assert.equal(owner,id);assert.equal(url,'https://www.instagram.com/p/Dd89GMKhG54/');return parseMediaPost(JSON.stringify({ok:true,total:1,totalKnown:true,slides:[{index:1,kind:'image',status:'processed',mime:'image/jpeg',data:data.toString('base64'),sha256:createHash('sha256').update(data).digest('hex'),width:20,height:30,sourcePixels:600}],transferBytes:100,encodedBytes:4,sourcePixels:600,videoSeconds:0,wallMs:1,metadata:{}}),c);};
 globalThis.fetch=async(_url,init)=>{generated++;questions.push(JSON.parse(String(init?.body)).contents[0].parts.at(-1).text);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'observed illustration'}]}}]}));};
 const incoming={transport:'telegram' as const,chatId:id,senderId:id,sender:'owner',id:'1',text:'Describe this post.',isGroup:false,timestamp:0};
 try{
  const tools:any=videoLinkTools(incoming);
  await assert.rejects(tools.watch_video.execute({url:'https://www.instagram.com/p/Dd89GMKhG54/',question:'invented'}),/actual latest/);
  const a=await tools.watch_video.execute({url:'https://www.instagram.com/p/Dd89GMKhG54/',question:incoming.text});assert.equal(a.total,1);assert.equal(a.complete,true);assert.equal(extracted,1);assert.equal(generated,1);assert(a.slides[0].handle);assert.notEqual(a.handle,a.slides[0].handle);
  const next:any=videoLinkTools({...incoming,id:'2',text:'What is the color?'});
  const b=await next.watch_video.execute({handle:a.slides[0].handle,question:'What is the color?'});assert.equal(extracted,1);assert.equal(generated,2);assert.equal(b.slides[0].handle,a.slides[0].handle);assert(questions[1].includes('What is the color?'));
  const denied:any=videoLinkTools({...incoming,chatId:other,senderId:other});await assert.rejects(denied.watch_video.execute({handle:a.slides[0].handle,question:incoming.text}),/owner\/channel/);assert.equal(generated,2);
  Date.now=()=>now()+2000000;await assert.rejects(next.watch_video.execute({handle:a.slides[0].handle,question:'What is the color?'}),/unavailable|expired/);assert.equal(generated,2);
 }finally{Date.now=now;globalThis.fetch=fetcher;sandboxes.inspectInstagramPost=extract;for(const n of [id,other]){config.sandbox.allowed.delete(n);config.telegramAllowed.delete(n);}for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
