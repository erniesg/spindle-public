import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {startTaskReview} from '../../core/assistant/app.js';
import type {AgentProvider} from '../../core/agent/contracts.js';
const id='12345678-1234-1234-1234-123456789abc';
export const accountTransport:typeof fetch=async(input)=>{const path=new URL(String(input)).pathname;if(path==='/signin'||path==='/register')return Response.json({csrf:'c'.repeat(64)},{headers:{'set-cookie':`spindle_session=${'d'.repeat(64)}; HttpOnly`}});if(path==='/session')return Response.json({account:{id,name:'Sample'},csrf:'c'.repeat(64)});return Response.json({});};
export function scripted():AgentProvider{return {id:'scripted-transport-not-model-quality',async next(task){return task.observations.length?{kind:'ready',result:'Done'}:{kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}};}};}
test('real local HTTP utterance automatically learns without Save; origin protections and correction/forget',async()=>{
 const root=mkdtempSync(join(tmpdir(),'spindle-memory-'));const evidence=new EvidenceStore(root),tasks=new AgentStore(':memory:');const account=new AccountClient('http://127.0.0.1:9999',accountTransport);const memory=createUserMemoryApplication({evidence,evidenceRoot:root,account,workspaceId:'w',provider:scripted()});
 const app=await startTaskReview(tasks,{workspaceId:'old-task-workspace',accountId:'old-task-account'},evidence,memory);
 const headers={Authorization:`Bearer ${app.token}`,'Content-Type':'application/json',Origin:app.origin};
 const post=async(action:unknown,origin=app.origin)=>fetch(app.origin+'/api/user-memory',{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify(action)});
 try{
  assert.equal((await post({action:'conversation',text:'I prefer tea'})).status,400);
  assert.equal((await post({action:'signin',name:'Sample',password:'invented'})).status,200);
  await memory.drain();
  assert.equal((await post({action:'configure',conversation:true,activity:false,processing:true,sync:false})).status,200);
  assert.equal((await post({action:'conversation',text:'I prefer tea'} ,'https://evil.test')).status,403);
  assert.equal((await post({action:'conversation',text:'I prefer tea'})).status,200);await memory.drain();
  const state=memory.status();assert.equal(state.authenticated,true);if(!state.authenticated)throw Error();assert.equal(state.entries[0].value,'I prefer tea.');assert.equal(state.entries[0].pending,true);assert.equal(state.turns[0].state,'completed');
  assert.equal((await post({action:'correct',key:'drink',kind:'preference',value:'Prefers coffee',revision:state.entries[0].revision})).status,200);
  assert.equal(memory.recall('coffee')[0].origin,'user');
  assert.equal((await post({action:'forget',key:'drink'})).status,200);
  assert.deepEqual(memory.recall('coffee'),[]);assert.equal(memory.status().authenticated,true);
  await memory.signout();assert.deepEqual(memory.status(),{authenticated:false,configured:true});
 }finally{await memory.stop();await app.close();tasks.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});
