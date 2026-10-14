import {config} from './config.js';
import {TRANSFER_MAX_BYTES} from './workspace-bytes.js';
export function validateUpload(file:{data:Buffer;filename:string}){
 if(!Buffer.isBuffer(file.data)||!file.data.length||file.data.length>Math.min(config.maxMediaBytes,TRANSFER_MAX_BYTES)||!/^\w[\w.-]{0,239}$/.test(file.filename))throw new Error('Single file upload exceeds cap or invalid filename');
}
