// Read-only verification of production history migration. Prints counts, never message text.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './dist/config.js';
import {HistoryStore} from './dist/history.js';
import {collection,namespace,closeMongo} from './dist/mongo.js';
import {redactCredentials,captureCredentials} from './dist/credentials.js';
const dir=config.dataDir;
const load=name=>existsSync(join(dir,name))?JSON.parse(readFileSync(join(dir,name),'utf8')):{};
const archive=load('history-archive.json'),recent=load('history.json');
try{
 await new HistoryStore(dir,config.historyLimit).ready();
 const coll=await collection('history');
 for(const chat of new Set([...Object.keys(archive),...Object.keys(recent)])){
  const signature=m=>JSON.stringify([m.role,m.id??null,m.senderId??null,m.at,m.text]);
  const retained=[...(archive[chat]||[])];const archiveCount=new Map(),recentCount=new Map();
  for(const row of retained){const key=signature(row);archiveCount.set(key,(archiveCount.get(key)||0)+1);}
  for(const row of recent[chat]||[]){const key=signature(row),n=(recentCount.get(key)||0)+1;recentCount.set(key,n);if(n>(archiveCount.get(key)||0))retained.push(row);}
  const expected=new Map();
  for(const row of retained){captureCredentials(row.text);const key=signature({...row,text:redactCredentials(row.text)});expected.set(key,(expected.get(key)||0)+1);}
  const actual=new Map();
  for await(const row of coll.find({ns:namespace(dir),chat})){const key=signature(row);actual.set(key,(actual.get(key)||0)+1);}
  for(const [key,count]of expected)assert.ok((actual.get(key)||0)>=count,'every backed-up message, including genuine duplicates, migrated');
  console.log('PASS retained history migration',chat,'source records',retained.length);
 }
 console.log('PASS every backed-up history record is present in Mongo after credential redaction');
}finally{await closeMongo();}
