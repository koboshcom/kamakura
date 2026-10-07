import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {HistoryStore} from '../src/history.js';import {captureCredentials} from '../src/credentials.js';import {unsafeLesson} from '../src/learning.js';import {collection,namespace} from '../src/mongo.js';
test('captured custom credentials cannot become unlabeled lessons or reappear in retained history after eviction',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'secret-retention-'));try{
 const history=new HistoryStore(dir,400);const secret='customsecret-retention-unique';captureCredentials(`password is ${secret}`);assert.equal(unsafeLesson(`Remember my favorite label is ${secret}`),true);
 await history.add('telegram:1',{role:'user',senderId:'1',credentialEligible:true,text:`password is ${secret}`,at:1});assert.equal((await history.get('telegram:1'))[0].credentialEligible,false);assert.ok(!(await history.get('telegram:1'))[0].text.includes(secret));
 for(let n=0;n<300;n++)captureCredentials(`password is newcustomsecret-${n}`);
 await history.add('telegram:1',{role:'user',senderId:'1',text:'done',at:2});const rows=await (await collection('history')).find({ns:namespace(dir)}).toArray();assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!(await new HistoryStore(dir,400).get('telegram:1')).some(row=>row.text.includes(secret)));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
