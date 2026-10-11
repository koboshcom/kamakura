import { APICallError, type ModelMessage } from 'ai';
/** Retry only an explicit unsupported-image rejection, before any tool or delivery side effect. */
export function unsupportedVision(error:unknown):boolean {
 if(!APICallError.isInstance(error)||![400,415,422].includes(error.statusCode??0))return false;
 const text=error.message+' '+(error.responseBody??'');
 return /(?:image|vision|multimodal|input_image)/i.test(text)&&/(?:not support|unsupported|does not support|text.only|not capable)/i.test(text);
}
export function withoutImages(messages:ModelMessage[]):ModelMessage[]{
 return messages.map(message=>message.role==='user'&&Array.isArray(message.content)?{...message,content:message.content.filter(part=>part.type!=='image'&&!(part.type==='file'&&part.mediaType.startsWith('image/')))}:message).concat({role:'user',content:'[Image inspection is unavailable for the configured provider/model. No image could be inspected in this turn. Answer any remaining text request, but do not describe or invent image content. Ask for a text description if needed.]'});
}
