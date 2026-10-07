import {config} from './config.js';
import {hasCredentials} from './credentials.js';
/** Optional speech server has its own credential, never the chat provider key. */
export async function speechAvailable():Promise<boolean>{
 if(!config.speech.baseUrl||!config.speech.model||!config.speech.voice||!config.speech.apiKey)return false;
 try{const base=new URL(config.speech.baseUrl);const headers={Authorization:`Bearer ${config.speech.apiKey}`};
 const response=await fetch(new URL('../openapi.json',base.href.endsWith('/')?base:new URL(base.href+'/')),{headers,signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)return false;
 const schema=await response.json() as {paths?:Record<string,unknown>};if(!schema.paths?.['/v1/audio/speech']&&!schema.paths?.['/audio/speech'])return false;
 const models=await fetch(new URL('models',base.href.endsWith('/')?base:new URL(base.href+'/')),{headers,signal:AbortSignal.timeout(5000),redirect:'error'});if(!models.ok)return false;const data=await models.json() as {data?:{id:string}[]};return Boolean(data.data?.some(m=>m.id===config.speech.model));
 }catch{return false;}
}
export async function synthesizeVoice(text:string):Promise<Buffer>{
 if(hasCredentials(text))throw new Error('Credentials cannot be spoken');if(!config.speech.baseUrl||!config.speech.apiKey)throw new Error('Speech unavailable');
 const base=config.speech.baseUrl.replace(/\/$/,'');const response=await fetch(`${base}/audio/speech`,{method:'POST',headers:{Authorization:`Bearer ${config.speech.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.speech.model,voice:config.speech.voice,input:text,response_format:'opus'}),signal:AbortSignal.timeout(config.mediaTimeoutMs),redirect:'error'});
 if(!response.ok||!response.body)throw new Error('Speech synthesis unavailable');const reader=response.body.getReader();const chunks:Buffer[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>config.maxMediaBytes){await reader.cancel();throw new Error('Speech output too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}const audio=Buffer.concat(chunks);if(audio.subarray(0,4).toString()!=='OggS')throw new Error('Speech did not return Ogg Opus');return audio;
}
