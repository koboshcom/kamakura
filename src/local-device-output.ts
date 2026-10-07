import { redactCredentials } from './credentials.js';
export function localModelOutput(output: unknown): {text:string;images:string[]} {
  const images:string[]=[];
  const clean=(value:unknown,depth=0):unknown=>{
    if(depth>20)return '[nested value omitted]';
    if(typeof value==='string')return redactCredentials(value).slice(0,16000);
    if(Array.isArray(value))return value.slice(0,100).map(v=>clean(v,depth+1));
    if(value && typeof value==='object') {
      const obj=value as Record<string,unknown>;
      if(obj.type==='image' && obj.mimeType==='image/png' && typeof obj.data==='string' && obj.data.length<=3*1024*1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(obj.data)){if(images.length<2)images.push(obj.data);return '[PNG screenshot attached]';}
      const result:Record<string,unknown>={};
      for(const [key,item]of Object.entries(obj).slice(0,100)) {
        if(['screenshot_png_b64','screenshot_base64','image_base64'].includes(key) && typeof item==='string'){if(images.length<2 && item.length<=3*1024*1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(item))images.push(item);result[key]='[PNG screenshot attached]';}
        else result[key]=clean(item,depth+1);
      }
      return result;
    }
    return value;
  };
  return {text:JSON.stringify(clean(output)).slice(0,16000),images};
}
