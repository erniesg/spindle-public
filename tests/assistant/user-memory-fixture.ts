import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import type {AgentProvider} from '../../core/agent/contracts.js';
export const alice='12345678-1234-1234-1234-123456789abc',bob='12345678-1234-1234-1234-123456789def';
export function scripted(quote='I prefer tea',extra:Record<string,unknown>={}):AgentProvider{return {id:'scripted-not-model-quality',async next(task){return task.observations.length?{kind:'ready',result:'Done'}:{kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote,...extra}};}};}
export function fixture(provider:AgentProvider|undefined=scripted(),handler?:(url:URL,data:unknown)=>unknown|Response){
 const root=mkdtempSync(join(tmpdir(),'spindle-user-memory-'));let user='Alice';const evidence=new EvidenceStore(root);
 const account=new AccountClient('http://127.0.0.1:9999',async(input,init)=>{const url=new URL(String(input));const data=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
 if(url.pathname==='/signin'||url.pathname==='/register'){user=String(data!.name);return Response.json({csrf:'c'.repeat(64)},{headers:{'set-cookie':`spindle_session=${'d'.repeat(64)}`}});}
 if(url.pathname==='/session')return Response.json({account:{id:user==='Alice'?alice:bob,name:user},csrf:'c'.repeat(64)});
 const value=handler?.(url,data)??{};return value instanceof Response?value:Response.json(value);
 });
 const service=()=>createUserMemoryApplication({evidence,evidenceRoot:root,account,workspaceId:'w',provider});
 const app=service();return {root,evidence,account,app,service,async close(){await app.stop();evidence.close();rmSync(root,{recursive:true,force:true});}};
}
