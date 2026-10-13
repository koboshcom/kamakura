import {statfs} from 'node:fs/promises';
import {logger,errorType} from './logger.js';
type Disk={bavail:number;bsize:number};
let lastWarning=-Infinity;
/** Observes only DATA_DIR's mounted filesystem. Mongo storage may be separate. */
export async function checkStorageDisk(path:string,read:(path:string)=>Promise<Disk>=statfs,now:()=>number=Date.now,report:(value:Record<string,unknown>,message:string)=>void=(value,message)=>logger.warn(value,message)):Promise<void>{
 const threshold=Number(process.env.LOW_DISK_WARNING_BYTES??1073741824);
 const emit=(data:Record<string,unknown>,message:string)=>{if(now()-lastWarning<300000)return;lastWarning=now();report(data,message);};
 if(!Number.isSafeInteger(threshold)||threshold<1){emit({event:'storage_disk_config_invalid'},'Disk warning threshold invalid; disk health unknown');return;}
 try{const fs=await read(path),freeBytes=fs.bavail*fs.bsize;if(!Number.isSafeInteger(freeBytes)||freeBytes<0)throw new Error('Invalid filesystem stats');
  if(freeBytes<threshold)emit({event:'storage_disk_low',scope:'DATA_DIR filesystem only; Mongo volume not observed',freeBytes,thresholdBytes:threshold},'Low data filesystem space; Mongo filesystem may be separate');
 }catch(error){emit({event:'storage_disk_unknown',err:errorType(error),scope:'DATA_DIR filesystem only'},'Data filesystem space could not be observed; not healthy');}
}
