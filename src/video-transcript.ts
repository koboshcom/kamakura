import {createHash} from 'node:crypto';
import {parseSync} from 'subtitle';
export interface TranscriptSegment {id:string;start:number;end:number;text:string;source:string;language:string;timing:string}
export function captionSegments(metadata?:Record<string,unknown>):TranscriptSegment[] {
 const tracks=(metadata?.captions as any)?.tracks;
 if(!Array.isArray(tracks))return [];
 const out:TranscriptSegment[]=[];
 for(const track of tracks.slice(0,2)){
  if(!track||typeof track.text!=='string'||track.text.length>24000)continue;
  const source=track.source==='manual'?'manual captions':track.source==='automatic'?'automatic captions':'unknown captions';
  const language=typeof track.language==='string'?track.language.slice(0,40):'unknown';
  try {
   if(!['vtt','srt'].includes(track.format))continue;
   for(const node of parseSync(track.text)){
    if(node.type!=='cue')continue;
    const {start,end,text}=node.data;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>3600000||typeof text!=='string')continue;
    const clean=text.replace(/<[^>]*>/g,'').replace(/[\x00-\x08\x0b-\x1f]/g,'').trim().slice(0,1000);
    if(!clean)continue;
    out.push(segment(start/1000,end/1000,clean,source,language,'caption cue timestamps, not verified speech'));
    if(out.length>=512)return out;
   }
  }catch{/* Retain availability distinction when unsupported or malformed. */}
 }
 return out;
}
export function segment(start:number,end:number,text:string,source:string,language='unknown',timing='bounded STT window; words have no exact timestamps'):TranscriptSegment {
 return {id:createHash('sha256').update(JSON.stringify([start,end,text,source,language])).digest('hex').slice(0,24),start,end,text,source,language,timing};
}
export function searchSegments(segments:TranscriptSegment[],query:string,limit=8) {
 const q=query.trim().toLocaleLowerCase();if(!q||q.length>200)throw new Error('Search query must have 1-200 characters');
 const tokens=q.split(/\s+/u).filter(Boolean).slice(0,16);
 return segments.map((s,index)=>({s,index,score:(s.text.toLocaleLowerCase().includes(q)?100:0)+tokens.reduce((sum,t)=>sum+(s.text.toLocaleLowerCase().includes(t)?1:0),0)}))
 .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,Math.min(8,Math.max(1,limit))).map(x=>x.s);
}
