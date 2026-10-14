import type {LocalDeviceStore,PairRecord,DeviceRecord,ActionAudit} from './local-devices.js';
import {namespace} from './mongo.js';
import {atomic,insert,row,rows,remove,put} from './sqlite.js';
import {randomUUID} from 'node:crypto';
export class SqliteLocalDeviceStore implements LocalDeviceStore {
 private readonly ns:string;
 constructor(dir:string){this.ns=namespace(dir);}
 private key(value:string){return this.ns+':'+value;}
 async putPair(record:PairRecord){atomic(()=>{for(const old of rows<PairRecord>('local_device_pairs',this.ns))if(old.expiresAt<=Date.now())remove('local_device_pairs',this.key(old.codeHash));if(!insert('local_device_pairs',this.key(record.codeHash),this.ns,record))throw new Error('Duplicate pairing code');});}
 async consumePair(codeHash:string,now:number){return atomic(()=>{const key=this.key(codeHash),r=row<PairRecord>('local_device_pairs',key);if(!r||r.expiresAt<=now)return null;remove('local_device_pairs',key);return r;});}
 async putDevice(record:DeviceRecord){if(!insert('local_devices',this.key(record.deviceId),this.ns,record))throw new Error('Duplicate local device');}
 async byToken(hash:string){return rows<DeviceRecord>('local_devices',this.ns).find(d=>d.tokenHash===hash&&!d.revoked)??null;}
 async get(owner:string,id:string){const r=row<DeviceRecord>('local_devices',this.key(id));return r&&r.ownerId===owner&&!r.revoked?r:null;}
 async list(owner:string){return rows<DeviceRecord>('local_devices',this.ns).filter(d=>d.ownerId===owner&&!d.revoked);}
 async revoke(owner:string,id:string){return atomic(()=>{const key=this.key(id),r=row<DeviceRecord>('local_devices',key);if(!r||r.ownerId!==owner||r.revoked)return false;put('local_devices',key,this.ns,{...r,revoked:true});return true;});}
 async audit(record:ActionAudit){insert('local_device_audit',randomUUID(),this.ns,record);}
}
