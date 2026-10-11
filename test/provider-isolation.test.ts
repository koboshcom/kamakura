import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateText} from 'ai';
import {WebSocketServer} from 'ws';
import {config} from '../src/config.js';
import {modelFor,type GenerationPart} from '../src/model-provider.js';
import {providerNames,readProvider,validateProvider,ProviderConfigError} from '../src/provider-settings.js';
import {validateStartupProviders} from '../src/provider-startup.js';
import {voiceConfig} from '../src/discord-voice-config.js';
import {createVoiceLive} from '../src/discord-voice-provider.js';
import {createVoiceBackend,startDiscordVoice} from '../src/discord-voice-service.js';
import {transcribeWav} from '../src/transcription.js';
import {embedText} from '../src/embeddings.js';
import {speechAvailable,synthesizeVoice} from '../src/speech.js';
import {VoiceSession} from '../src/discord-voice-session.js';
const parts=['chat','fast','worker','summary','learning','review'] as GenerationPart[];
const voiceEnv={DISCORD_VOICE_ENABLED:'true',DISCORD_VOICE_SELF_ID:'222222222222222222',DISCORD_VOICE_USER_TOKEN:'offline-token',SANDBOX_ALLOWED_USERS:'1',DISCORD_VOICE_ALLOWED_USERS:'111111111111111111',DISCORD_VOICE_OWNER_IDS:'{"111111111111111111":"1"}'};
const response=(model:string)=>({id:'resp_local',created_at:1,model,status:'completed',output:[{type:'message',id:'msg_local',role:'assistant',status:'completed',content:[{type:'output_text',text:'local answer',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
test('actual local HTTP/WS captures every part own URL, credential and model with hostile ambient settings',async()=>{
 const savedEnv={...process.env};const saved={provider:{...config.provider},model:config.model,speech:{...config.speech},transcriptionBaseUrl:config.transcriptionBaseUrl,transcriptionApiKey:config.transcriptionApiKey,transcriptionModel:config.transcriptionModel};
 const oldParts=Object.fromEntries(parts.filter(p=>p!=='chat').map(part=>[part,{provider:{...config[`${part as Exclude<GenerationPart,'chat'>}Provider`]},model:config[`${part as Exclude<GenerationPart,'chat'>}Model`]}]));
 const seen:{part:string;path:string;model:string}[]=[];
 const server=createServer(async(req,res)=>{
  try{
   const part=req.url!.split('/')[1]!;
   assert.equal(req.headers.authorization,'Bearer key-'+part);
   assert.equal(req.headers['openai-organization'],undefined);assert.equal(req.headers['openai-project'],undefined);
   let data='';for await(const chunk of req)data+=chunk;
   const body=req.headers['content-type']?.includes('multipart')?undefined:data?JSON.parse(data):{};
   if(req.url!.endsWith('responses')){assert.equal(body.model,'model-'+part);seen.push({part,path:req.url!,model:body.model});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response(body.model)));}
   else if(req.url!.endsWith('embeddings')){assert.equal(body.model,'model-embedding');seen.push({part,path:req.url!,model:body.model});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:body.model,data:body.input.map((_v:string,index:number)=>({index,embedding:Array(64).fill(1)}))}));}
   else if(req.url!.endsWith('transcriptions')){assert.match(data,/model-transcription/);seen.push({part,path:req.url!,model:'model-transcription'});res.setHeader('Content-Type','application/json');res.end('{"text":"local transcript"}');}
   else if(req.url!.endsWith('openapi.json')){res.setHeader('Content-Type','application/json');res.end('{"paths":{"/audio/speech":{}}}');}
   else if(req.url!.endsWith('models')){res.setHeader('Content-Type','application/json');res.end('{"data":[{"id":"model-speech"}]}');}
   else if(req.url!.endsWith('speech')){assert.equal(body.model,'model-speech');seen.push({part,path:req.url!,model:body.model});res.end('OggSlocal');}
   else {res.statusCode=404;res.end();}
  }catch(error){res.statusCode=400;res.end('local fixture assertion');throw error;}
 });
 const ws=new WebSocketServer({server});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  process.env.OPENAI_API_KEY='ambient-wrong';process.env.OPENAI_BASE_URL='http://127.0.0.1:1/wrong';process.env.OPENAI_MODEL='ambient-wrong';process.env.OPENAI_ORG_ID='ambient-org';process.env.OPENAI_PROJECT_ID='ambient-project';process.env.OPENAI_LOG='debug';process.env.OPENAI_ADMIN_KEY='ambient-admin';
  for(const part of parts){const settings={baseUrl:root+'/'+part+'/v1',apiKey:'key-'+part,model:'model-'+part};if(part==='chat'){config.provider=settings;config.model=settings.model;}else{config[`${part}Provider`]=settings;config[`${part}Model`]=settings.model;}}
  for(const part of parts)assert.equal((await generateText({model:modelFor(part),prompt:'synthetic',maxRetries:0})).text,'local answer');
  const cfg=voiceConfig({...voiceEnv,OPENAI_LIVE_BASE_URL:root+'/live/v1',OPENAI_LIVE_API_KEY:'key-live',OPENAI_LIVE_MODEL:'model-live',OPENAI_LIVE_ENDPOINT:root+'/live/socket',DISCORD_VOICE_BACKEND_BASE_URL:root+'/voiceBackend/v1',DISCORD_VOICE_BACKEND_API_KEY:'key-voiceBackend',DISCORD_VOICE_BACKEND_MODEL:'model-voiceBackend'});
  assert.equal(await createVoiceBackend(cfg)('synthetic',new AbortController().signal),'local answer');
  const connection=once(ws,'connection'),live=createVoiceLive(cfg);live.on('error',()=>{});
  try{
   const [peer,request]=await connection;
   assert.equal(request.url,'/live/socket');assert.equal(request.headers.authorization,'Bearer key-live');assert.equal(request.headers['openai-organization'],undefined);assert.equal(request.headers['openai-project'],undefined);
   const incoming=once(peer,'message');const session=new VoiceSession(cfg,{send:e=>live.send(e),close:()=>live.close(),buffered:()=>0},()=>{},()=>true,async()=>'', 'synthetic',()=>{});
   session.start();const event=JSON.parse(String((await incoming)[0]));assert.equal(event.type,'session.start');assert.equal(event.session.model,'model-live');session.disconnected();
  }finally{live.close();for(const peer of ws.clients)peer.terminate();}
  process.env.EMBEDDING_BASE_URL=root+'/embedding/v1';process.env.EMBEDDING_API_KEY='key-embedding';process.env.EMBEDDING_MODEL='model-embedding';await embedText('synthetic');
  config.transcriptionBaseUrl=root+'/transcription/v1';config.transcriptionApiKey='key-transcription';config.transcriptionModel='model-transcription';assert.equal(await transcribeWav(Buffer.from('synthetic')),'local transcript');
  config.speech={baseUrl:root+'/speech/v1',apiKey:'key-speech',model:'model-speech',voice:'local'};assert.equal(await speechAvailable(),true);assert.equal((await synthesizeVoice('synthetic')).toString(),'OggSlocal');
  assert.deepEqual(seen.map(row=>row.part).sort(),[...parts,'voiceBackend','embedding','transcription','speech'].sort());
 }finally{
  Object.assign(config,saved);for(const part of parts)if(part!=='chat'){config[`${part}Provider`]=oldParts[part]!.provider;config[`${part}Model`]=oldParts[part]!.model;}
  for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);
  await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
 }
});
test('every used triplet fails closed with only its missing/invalid field name',()=>{
 for(const part of Object.keys(providerNames) as (keyof typeof providerNames)[]){
  const settings={baseUrl:'https://provider.test/v1',apiKey:'own-key',model:'own-model'};
  for(const [key,suffix] of [['baseUrl','BASE_URL'],['apiKey','API_KEY'],['model','MODEL']] as const){
   for(const value of ['',' '])assert.throws(()=>validateProvider(part,{...settings,[key]:value}),error=>error instanceof ProviderConfigError&&error.message===providerNames[part]+'_'+suffix);
  }
  for(const baseUrl of ['https://private:secret@host.test','https://host.test/?secret','https://host.test/#secret','https://host.test/\nsecret'])assert.throws(()=>validateProvider(part,{...settings,baseUrl}),error=>error instanceof Error&&!error.message.includes('secret'));
 }
 assert.throws(()=>validateProvider('worker',readProvider('worker',{OPENAI_API_KEY:'main',OPENAI_BASE_URL:'https://main.test',OPENAI_MODEL:'main'})),/OPENAI_WORKER_BASE_URL/);
});
test('startup activation validates required/active parts but permits unused optional blank triplets',async()=>{
 const saved={fast:{...config.fastProvider},fastModel:config.fastModel,review:config.replyReview.enabled,learning:config.learning.enabled,owners:new Set(config.learning.owners),reviewProvider:{...config.reviewProvider},reviewModel:config.reviewModel,learningProvider:{...config.learningProvider},learningModel:config.learningModel,speech:{...config.speech}};
 const live=process.env.DISCORD_VOICE_ENABLED,embedding=process.env.EMBEDDING_API_KEY;
 try{
  process.env.DISCORD_VOICE_ENABLED='false';config.fastProvider={baseUrl:'',apiKey:'',model:''};config.fastModel='';config.replyReview.enabled=false;config.learning.enabled=false;config.speech={baseUrl:'',apiKey:'',model:'',voice:''};
  config.reviewProvider={baseUrl:'',apiKey:'',model:''};config.reviewModel='';config.learningProvider={baseUrl:'',apiKey:'',model:''};config.learningModel='';
  assert.equal(validateStartupProviders().enabled,false);
  process.env.EMBEDDING_API_KEY='';assert.throws(validateStartupProviders,/EMBEDDING_API_KEY/);process.env.EMBEDDING_API_KEY=embedding;
  config.replyReview.enabled=true;assert.throws(validateStartupProviders,/OPENAI_REVIEW_BASE_URL/);config.replyReview.enabled=false;
  config.learning.enabled=true;config.learning.owners=new Set(['not-numeric']);validateStartupProviders();config.learning.owners.add('123');assert.throws(validateStartupProviders,/OPENAI_LEARNING_BASE_URL/);config.learning.enabled=false;
  config.fastProvider.apiKey='partial';assert.throws(validateStartupProviders,/FAST_BASE_URL/);config.fastProvider.apiKey='';
  config.speech.model='partial';assert.throws(validateStartupProviders,/SPEECH_TTS_BASE_URL/);
  let touched=false;await assert.rejects(startDiscordVoice({...voiceConfig({}),enabled:true},{spawnChild:()=>{touched=true;throw new Error('unexpected');},connect:()=>{touched=true;throw new Error('unexpected');}}),/OPENAI_LIVE_BASE_URL/);assert.equal(touched,false);
 }finally{
  process.env.DISCORD_VOICE_ENABLED=live;process.env.EMBEDDING_API_KEY=embedding;config.fastProvider=saved.fast;config.fastModel=saved.fastModel;config.replyReview.enabled=saved.review;config.learning.enabled=saved.learning;config.learning.owners=saved.owners;config.reviewProvider=saved.reviewProvider;config.reviewModel=saved.reviewModel;config.learningProvider=saved.learningProvider;config.learningModel=saved.learningModel;config.speech=saved.speech;
 }
});
test('HTTP redirect never forwards any role credential to another endpoint',async()=>{
 let targetHits=0;
 const target=createServer((_q,r)=>{targetHits++;r.end();});await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
 const redirect=createServer((_q,r)=>{r.writeHead(307,{Location:'http://127.0.0.1:'+(target.address() as {port:number}).port+'/stolen'});r.end();});await new Promise<void>(resolve=>redirect.listen(0,'127.0.0.1',resolve));
 const old={...config.provider},model=config.model;
 try{config.provider={baseUrl:'http://127.0.0.1:'+(redirect.address() as {port:number}).port,apiKey:'private-key'};config.model='local';await assert.rejects(generateText({model:modelFor('chat'),prompt:'synthetic',maxRetries:0}));assert.equal(targetHits,0);}
 finally{config.provider=old;config.model=model;await Promise.all([target,redirect].map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})));}
});
test('actual worker, reflection, review and compaction call sites select their own role',async()=>{
 const {runWorker}=await import('../src/worker.js');const {reflectOwner}=await import('../src/learning-runtime.js');const {reviewChatReply}=await import('../src/reply-review.js');const {budgetOptions}=await import('../src/context-budget.js');
 const original=globalThis.fetch,models:string[]=[];
 const saved=Object.fromEntries(parts.map(p=>[p,p==='chat'?{provider:{...config.provider},model:config.model}:{provider:{...config[`${p}Provider`]},model:config[`${p}Model`]}]));
 const allowed=new Set(config.telegramAllowed),sandbox=new Set(config.sandbox.allowed),owners=new Set(config.learning.owners),enabled=config.learning.enabled;
 const incoming={transport:'telegram' as const,chatId:'123',senderId:'123',sender:'owner',id:'fixture',text:'remember i prefer tea',timestamp:0,isGroup:false,learningEligible:true};
 try{
  for(const part of parts){const provider={baseUrl:'http://127.0.0.1:1/'+part,apiKey:'key-'+part,model:'model-'+part};if(part==='chat'){config.provider=provider;config.model=provider.model;}else{config[`${part}Provider`]=provider;config[`${part}Model`]=provider.model;}}
  globalThis.fetch=async(input,init)=>{
   const body=JSON.parse(String(init?.body)),part=body.model.slice(6);models.push(part);
   assert.equal(String(input),'http://127.0.0.1:1/'+part+'/responses');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer key-'+part);assert.equal(init?.redirect,'error');
   const data=response(body.model);data.output[0]!.content[0]!.text=part==='learning'?'{"lessons":[]}':part==='summary'?'bounded summary':part==='review'?'hello':'worker result';return Response.json(data);
  };
  config.telegramAllowed.add('123');config.sandbox.allowed.add('123');config.learning.enabled=false;
  assert.equal(await runWorker({id:'fixture',incoming,task:'synthetic',takeMessages:()=>[],sendMessage:async()=>({sent:true})},new AbortController().signal),'worker result');
  config.learning.enabled=true;config.learning.owners.add('123');await reflectOwner(incoming);
  assert.equal(await reviewChatReply('hello','hey',[{role:'user',content:'hey'}]),'hello');
  const pinned={role:'user' as const,content:'latest'};
  await budgetOptions({instructions:'safety',messages:[{role:'user',content:'old data. '.repeat(1800)},pinned],tools:{},maxOutputTokens:100,prepareStep:()=>({})},1800,{model:()=>modelFor('summary')});
  assert(models.includes('worker'));assert(models.includes('learning'));assert(models.includes('review'));assert(models.includes('summary'));assert(!models.includes('chat'));
  const before=models.length;config.summaryModel='';await budgetOptions({instructions:'safety',messages:[pinned],tools:{},maxOutputTokens:100,prepareStep:()=>({})},1800,{model:()=>modelFor('summary')});assert.equal(models.length,before);
  await assert.rejects(budgetOptions({instructions:'safety',messages:[{role:'user',content:'old '.repeat(5000)},pinned],tools:{},maxOutputTokens:100,prepareStep:()=>({})},1800,{model:()=>modelFor('summary')}),/OPENAI_SUMMARY_MODEL/);assert.equal(models.length,before);
 }finally{
  globalThis.fetch=original;config.telegramAllowed=allowed;config.sandbox.allowed=sandbox;config.learning.owners=owners;config.learning.enabled=enabled;
  for(const part of parts){if(part==='chat'){config.provider=saved[part]!.provider;config.model=saved[part]!.model;}else{config[`${part}Provider`]=saved[part]!.provider;config[`${part}Model`]=saved[part]!.model;}}
 }
});
