import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import {embeddingFixture} from './embedding-fixture.js';
const embeddings=await embeddingFixture();
process.env.EMBEDDING_BASE_URL=embeddings.url;process.env.EMBEDDING_API_KEY='test-only';process.env.EMBEDDING_MODEL='fixture';process.env.EMBEDDING_DIMENSIONS='64';process.env.EMBEDDING_MIN_SCORE='0.3';
after(()=>embeddings.close());
// Every model role has explicit synthetic config; no real dotenv/provider access.
process.env.DOTENV_CONFIG_PATH='/nonexistent-kamakura-offline-test';
delete process.env.PROVIDER_API_KEY;
for(const prefix of ['OPENAI','OPENAI_WORKER','OPENAI_SUMMARY','OPENAI_LEARNING','OPENAI_REVIEW','OPENAI_TRANSCRIBE']){
 process.env[prefix+'_BASE_URL']='http://127.0.0.1:1/v1';process.env[prefix+'_API_KEY']='test-only-'+prefix;process.env[prefix+'_MODEL']=prefix==='OPENAI_TRANSCRIBE'?'fixture':'gpt-5';
}
for(const prefix of ['FAST','SPEECH_TTS'])for(const key of ['BASE_URL','API_KEY','MODEL'])process.env[prefix+'_'+key]='';
process.env.STT_URL='';process.env.STT_KEY='';process.env.STT_MODEL='';
process.env.SPEECH_TTS_VOICE='';process.env.DISCORD_VOICE_ENABLED='false';
// Imported before tests and config. No global store points at production DATA_DIR.
const dir=mkdtempSync(join(tmpdir(),'kamakura-suite-'));
process.env.DATA_DIR=dir;
process.env.MONGODB_DATABASE=`kamakura_test_${process.pid}`;
after(async()=>{
 const {mongo,closeMongo}=await import('../src/mongo.js');
 try{await (await mongo()).dropDatabase();}finally{await closeMongo();rmSync(dir,{recursive:true,force:true});}
});
