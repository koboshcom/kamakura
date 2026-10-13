import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {postCaps,parseMediaPost,postEvidence,answerMediaPost} from '../src/media-post.js';
import {geminiVideoSettings,GeminiVideoClient} from '../src/gemini-video.js';
const caps=postCaps({});
const image=Buffer.from([255,216,255,224,0,0]);
const video=Buffer.from('0000ftyp0000000000');
const slide=(index=1)=>({index,kind:'image',status:'processed',mime:'image/jpeg',data:image.toString('base64'),sha256:createHash('sha256').update(image).digest('hex'),width:20,height:30,sourcePixels:600});
const fixture=()=>({ok:true,total:1,totalKnown:true,slides:[slide()],transferBytes:200,encodedBytes:image.length,sourcePixels:600,videoSeconds:0,wallMs:10,metadata:{caption:'untrusted caption'}});
test('validated image, explicit omissions and duplicates preserve slide order without base64 evidence',()=>{
 const r=fixture();r.total=3;r.slides.push({...slide(2),status:'duplicate',duplicateOf:1} as any,{index:3,kind:'unknown',status:'omitted',reason:'slide_count_cap'} as any);
 const parsed=parseMediaPost(JSON.stringify(r),caps);
 assert.equal(postEvidence(parsed).complete,false);assert.equal(postEvidence(parsed).slides[1].duplicateOf,1);assert(!JSON.stringify(postEvidence(parsed)).includes(image.toString('base64')));
});
test('reject hostile shapes, bytes, malformed image, totals, order, duplicate references and unknown output',()=>{
 for(const mutate of [(r:any)=>r.total=2,(r:any)=>r.transferBytes=caps.bytes+1,(r:any)=>r.slides[0].index=2,(r:any)=>r.slides[0].data='not base64',(r:any)=>r.slides[0].sha256='bad',(r:any)=>r.slides[0].width=caps.dimension+1,(r:any)=>r.slides[0].status='duplicate',(r:any)=>r.slides[0].kind='unknown',(r:any)=>r.encodedBytes=0,(r:any)=>r.sourcePixels=0]){const r=fixture();mutate(r);assert.throws(()=>parseMediaPost(JSON.stringify(r),caps));}
});
test('mixed image/video has per-slide full sparse coverage and shared budgets',()=>{
 const r=fixture();r.total=2;r.videoSeconds=11;r.encodedBytes+=video.length;r.slides.push({index:2,kind:'video',status:'processed',mime:'video/mp4',data:video.toString('base64'),sha256:createHash('sha256').update(video).digest('hex'),duration:11,coverage:[0,11],fullSource:true,mode:'static'} as any);
 const parsed=parseMediaPost(JSON.stringify(r),caps);assert.equal(parsed.slides[1].kind,'video');
 assert.throws(()=>parseMediaPost(JSON.stringify(r),{...caps,videoSeconds:10}));
});
test('fresh actual questions, ordered native inline image/video parts, bounded response, no answer cache',async()=>{
 const settings=geminiVideoSettings({GEMINI_VIDEO_BASE_URL:'https://provider.example',GEMINI_VIDEO_KEY:'private-key',GEMINI_VIDEO_MODEL:'model'})!;
 const bodies:any[]=[];const client=new GeminiVideoClient(settings,(async(_url:any,init:any)=>{assert.equal(init.redirect,'error');bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'observed image'}]}}]}));}) as typeof fetch);
 const post=parseMediaPost(JSON.stringify(fixture()),caps);
 for(const q of ['What is here?','What is the color?'])await answerMediaPost(post,q,client);
 assert.equal(bodies.length,2);assert(bodies[0].contents[0].parts[1].inlineData);assert(bodies[1].contents[0].parts.at(-1).text.includes('What is the color?'));assert(!bodies[0].tools);
});
test('caps must be finite integers and within shared maxima',()=>{
 for(const v of ['Infinity','0','21','NaN'])assert.throws(()=>postCaps({MEDIA_POST_MAX_SLIDES:v}));
 assert.equal(postCaps({MEDIA_POST_MAX_SLIDES:'2'}).count,2);
});
test('unknown total never claims complete and foreign fields never leak',()=>{
 const r:any=fixture();r.totalKnown=false;r.privateURL='https://cdn/?token=SECRET';r.slides[0].privateURL=r.privateURL;
 const p=parseMediaPost(JSON.stringify(r),caps);assert.equal(postEvidence(p).complete,false);assert(!JSON.stringify(p).includes('SECRET'));
});
test('mixed long video uses documented Interactions agentic while short remains static',async()=>{
 const settings=geminiVideoSettings({GEMINI_VIDEO_BASE_URL:'https://provider.example',GEMINI_VIDEO_KEY:'private-key',GEMINI_VIDEO_MODEL:'model'})!;
 const r=fixture();r.total=2;r.videoSeconds=300;r.encodedBytes+=video.length;r.slides.push({index:2,kind:'video',status:'processed',mime:'video/mp4',data:video.toString('base64'),sha256:createHash('sha256').update(video).digest('hex'),duration:300,coverage:[0,300],fullSource:true,mode:'agentic'} as any);
 const client=new GeminiVideoClient(settings,(async(url:any,init:any)=>{assert(String(url).endsWith('/interactions'));const b=JSON.parse(init.body);assert.equal(b.store,false);assert.equal(b.input[1].type,'image');assert.equal(b.input[3].processing,'agentic');assert(!b.input[3].uri);return new Response('data: '+JSON.stringify({event_type:'step.start',index:0,step:{type:'model_output'}})+'\n\ndata: '+JSON.stringify({event_type:'step.delta',index:0,delta:{type:'text',text:'bounded mixed evidence'}})+'\n\ndata: '+JSON.stringify({event_type:'interaction.completed',interaction:{status:'completed'}})+'\n\n',{headers:{'content-type':'text/event-stream'}});}) as typeof fetch);
 const result=await answerMediaPost(parseMediaPost(JSON.stringify(r),caps),'Describe this post.',client);assert.match(result.text,/bounded mixed evidence/);
});
