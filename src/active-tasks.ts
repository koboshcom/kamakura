import {randomUUID} from 'node:crypto';
import {localDMScope,consumeLocalCommand} from './local-dm-context.js';
import type {IncomingMessage} from './types.js';
type RecordTask={scope:NonNullable<ReturnType<typeof localDMScope>>;current:()=>boolean;stop:()=>Promise<void>;critical:boolean};
export class ActiveTasks {
 private tasks=new Map<string,RecordTask>();
 register(message:IncomingMessage,stop:()=>Promise<void>,current:()=>boolean,critical:boolean){
 const scope=localDMScope(message);if(!scope||!current())return {id:'',close:()=>{}};
 for(const [old,t] of this.tasks)if(!t.current()||!t.scope.current())this.tasks.delete(old);
 if(this.tasks.size>=128)throw new Error('Active task limit');
 const id=randomUUID();this.tasks.set(id,{scope,current,stop,critical});
 return {id,close:()=>{this.tasks.delete(id);}};
 }
 async stop(message:IncomingMessage,id:string){
 const s=localDMScope(message),t=this.tasks.get(id);
 if(!s||!t||!t.current()||!t.scope.current()||s.owner!==t.scope.owner||s.transport!==t.scope.transport||s.chat!==t.scope.chat||s.account!==t.scope.account)return false;
 if(t.critical)return false;
 this.tasks.delete(id);await t.stop();return true;
 }
 async handle(message:IncomingMessage){const m=/^\/stop_task\s+([a-f0-9-]{36})$/.exec(message.text.trim());if(!m)return false;const s=consumeLocalCommand(message);if(!s)return true;const ok=await this.stop(message,m[1]!);await s.send(ok?'Task stopped.':'Task unavailable or protected.');return true;}
}
export const activeTasks=new ActiveTasks();
