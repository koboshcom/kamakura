import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import {embeddingFixture} from './embedding-fixture.js';
const embeddings=await embeddingFixture();
process.env.EMBEDDING_BASE_URL=embeddings.url;process.env.EMBEDDING_API_KEY='test-only';process.env.EMBEDDING_MODEL='fixture';process.env.EMBEDDING_DIMENSIONS='64';process.env.EMBEDDING_MIN_SCORE='0.3';
after(()=>embeddings.close());
// Imported before tests and config. No global store points at production DATA_DIR.
const dir=mkdtempSync(join(tmpdir(),'kamakura-suite-'));
process.env.DATA_DIR=dir;
process.env.MONGODB_DATABASE=`kamakura_test_${process.pid}`;
after(async()=>{
 const {mongo,closeMongo}=await import('../src/mongo.js');
 try{await (await mongo()).dropDatabase();}finally{await closeMongo();rmSync(dir,{recursive:true,force:true});}
});
