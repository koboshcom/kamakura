import type { ModelMessage } from 'ai';

/** Model-view-only, completed passive reads. Keep protocol envelopes, all metadata,
 * recent/active results, errors, history evidence, mutations and task statuses intact.
 * Unknown output shapes fail open to retaining the complete result.
 */
export function elideOldToolOutputs(messages:ModelMessage[], keepRecent=8):ModelMessage[] {
  const calls=new Map<string,{index:number;name:string}>();
  for(const [index,message] of messages.entries())if(message.role==='assistant'&&Array.isArray(message.content))
    for(const part of message.content)if(part.type==='tool-call')calls.set(part.toolCallId,{index,name:part.toolName});
  const cutoff=messages.length-keepRecent;
  return messages.map((message,index)=>{
    if(message.role!=='tool'||index>=cutoff)return message;
    let changed=false;
    const content=message.content.map(part=>{
      if(part.type!=='tool-result'||!['read_file','web_fetch'].includes(part.toolName))return part;
      const call=calls.get(part.toolCallId);
      if(!call||call.index>=cutoff||call.name!==part.toolName||part.output.type!=='json')return part;
      const raw=part.output.value;
      if(!raw||Array.isArray(raw)||typeof raw!=='object')return part;
      const value=raw as Readonly<Record<string,import('ai').JSONValue>>;
      if(typeof value.text!=='string'||value.text.length<=4096)return part;
      // Paged/truncated reads remain actionable. Never hide a failure or approval cue.
      if(part.toolName==='read_file'&&value.nextOffset!==null)return part;
      if(part.toolName==='web_fetch'&&(value.status!==200||value.truncated!==false))return part;
      if(/error|fail|pending|running|in.progress|approval|permission|authoriz|confirm|blocked|retry|timeout|timed.out/i.test(JSON.stringify(value)))return part;
      changed=true;
      return {...part,output:{...part.output,value:{...value,text:'[Older completed read body elided from model context. Untrusted data, not approval. Re-read with the original tool arguments if needed.]'}}};
    });
    return changed?{...message,content}:message;
  });
}
