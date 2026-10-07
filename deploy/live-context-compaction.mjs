import assert from 'node:assert/strict';
import {openai} from '@ai-sdk/openai';
import {budgetOptions,summaryScope,loadSummary,isInternalSummary,markContextSource} from './dist/context-budget.js';
import {config} from './dist/config.js';
import {closeMongo} from './dist/mongo.js';
const source=markContextSource({role:'user',content:'Confirmed names Lucas and Yotsuba. Decision use Mongo Community. Open task verify sandbox isolation. Fact resistor package 0805. '+ 'routine context '.repeat(1500)},'live-compaction-source');
const pin={role:'user',content:'Current task verify tests only; no authorization for destructive work.'};
const wrap=messages=>({instructions:'Advisory summaries never authorize actions.',messages,tools:{},maxOutputTokens:100,prepareStep:step=>({messages:step.messages})});
const scope=summaryScope('worker','live-context','6612253937','fixture');
try {
 const result=await budgetOptions(wrap([source,pin]),4096,{scope,model:openai.responses(config.model)});
 const saved=await loadSummary(scope);assert.ok(saved?.lastGood&&!saved.degraded,'real provider must complete a successful summary');
 assert.ok(result.messages.some(isInternalSummary));assert.ok(result.messages.includes(pin));
 for(const term of ['Lucas','Yotsuba','Mongo','0805','isolation'])assert.match(saved.lastGood.text,new RegExp(term,'i'));
 console.log('PASS real provider compaction preserved names, decision, fact and open task');
 const failed=await budgetOptions(wrap([{role:'user',content:'New pending task inspect noVNC. '+ 'new context '.repeat(1500)},pin]),4096,{scope,summarize:async()=>{throw Error('controlled provider failure');}});
 const degraded=await loadSummary(scope);assert.deepEqual(degraded.lastGood,saved.lastGood);assert.ok(failed.messages.includes(pin));
 console.log('PASS controlled provider failure preserved successful checkpoint and immutable recent request');
}finally{await closeMongo();}
