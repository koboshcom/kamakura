import {collection} from './mongo.js';
import {storageBackend,row,put} from './sqlite.js';
import type {Summary} from './context-budget.js';
export interface SummaryRepository {get(scope:string):Promise<Summary|null>;save(summary:Summary):Promise<void>}
export function summaryRepository():SummaryRepository {
 if(storageBackend()==='sqlite')return {async get(scope){return row<Summary>('context_summaries',scope);},async save(summary){put('context_summaries',summary._id,summary._id,summary);}};
 return {async get(scope){return (await collection<Summary>('context_summaries')).findOne({_id:scope});},async save(summary){await (await collection<Summary>('context_summaries')).updateOne({_id:summary._id},{$set:summary},{upsert:true});}};
}
