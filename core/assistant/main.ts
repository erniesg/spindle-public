import { AgentStore } from '../storage/agent-store.js';
import { startTaskReview } from './app.js';
import { EvidenceStore } from '../evidence/store.js';
import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import type {UserMemoryApplication} from '../memory/application.js';
// Explicit trusted operator invocation, not model/tool arguments. No capture or worker is started.
const [database,workspaceId,accountId,contextDirectory]=process.argv.slice(2);
if(!database||!workspaceId||!accountId||process.argv.length>6)throw Error('Usage: node build/core/assistant/main.js DATABASE WORKSPACE ACCOUNT [CONTEXT_DIRECTORY]');
const store=new AgentStore(database);
const evidence=contextDirectory?new EvidenceStore(contextDirectory):undefined;
// Explicit operator-owned module only; never loaded from HTTP/model input. It supplies the existing trusted provider/account configuration.
let userMemory:UserMemoryApplication|undefined;
if(process.env.SPINDLE_USER_MEMORY_MODULE){
 const path=process.env.SPINDLE_USER_MEMORY_MODULE;
 if(!isAbsolute(path)||!evidence||!contextDirectory)throw Error('Shared memory requires an absolute trusted module and CONTEXT_DIRECTORY');
 const module=await import(pathToFileURL(path).href) as {createUserMemory:(options:{evidence:EvidenceStore;evidenceRoot:string;workspaceId:string})=>UserMemoryApplication|Promise<UserMemoryApplication>};
 userMemory=await module.createUserMemory({evidence,evidenceRoot:contextDirectory,workspaceId});userMemory.start();
}
const app=await startTaskReview(store,{workspaceId,accountId},evidence,userMemory);
console.log(`Open this private local preparation link (do not share): ${app.url}`);
let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;void app.close().finally(()=>userMemory?.stop()).finally(()=>{store.close();evidence?.close();});};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
