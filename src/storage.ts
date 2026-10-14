import {isMongoUnavailable,closeMongo} from './mongo.js';
import {closeSqlite,storageBackend,sqlite} from './sqlite.js';
export function isStorageUnavailable(error:unknown):boolean {
 if(storageBackend()==='mongo')return isMongoUnavailable(error);
 return error instanceof Error&&/^SQLITE_(?:FULL|IOERR(?:_.*)?|BUSY(?:_.*)?|LOCKED(?:_.*)?|READONLY(?:_.*)?|CANTOPEN(?:_.*)?)$/.test(String((error as Error&{code?:string}).code));
}
export async function closeStorage(){await closeMongo();closeSqlite();}
export function validateStorage(){storageBackend();if(storageBackend()==='sqlite')sqlite();}
