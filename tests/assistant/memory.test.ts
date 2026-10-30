import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTaskReview } from '../../core/assistant/app.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { MemoryStore } from '../../core/memory/store.js';
import { contextTools } from '../../core/memory/tools.js';
import { AgentRuntime } from '../../core/agent/runtime.js';

test('HTTP user preference survives actual stores restart and registered runtime recall; writes stay trusted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-http-'));const ns={workspaceId:'w',accountId:'a'};
 let tasks=new AgentStore(join(dir,'agent.sqlite'));let evidence=new EvidenceStore(join(dir,'context'));
 let app=await startTaskReview(tasks,ns,evidence);
 const request=(body:string,headers:Record<string,string>={Authorization:`Bearer ${app.token}`,Origin:app.origin,'Content-Type':'application/json'})=>fetch(app.origin+'/api/memory',{method:'POST',headers,body});
 try {
 const preference={key:'writing',kind:'preference',value:'Concise plain language please'};
 assert.equal((await request(JSON.stringify(preference),{})).status,403);
 assert.equal((await request(JSON.stringify(preference),{Authorization:`Bearer ${app.token}`,Origin:'https://evil.test','Content-Type':'application/json'})).status,403);
 assert.equal((await request(JSON.stringify(preference),{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'})).status,403);
 assert.equal((await request(JSON.stringify(preference),{Authorization:`Bearer ${app.token}`,Origin:app.origin,'Content-Type':'text/plain'})).status,403);
 assert.equal((await request('{')).status,400);
 assert.equal((await request('x'.repeat(32769))).status,413);
 for(const extra of [{accountId:'foreign'},{workspaceId:'foreign'},{userCorrected:false},{sourceIds:[]},{grant:'submit'}])assert.equal((await request(JSON.stringify({...preference,...extra}))).status,400);
 for(const invalid of [null,[],{...preference,value:''},{...preference,kind:'permission'},{...preference,value:'x'.repeat(8193)}])assert.equal((await request(JSON.stringify(invalid))).status,400);
 assert.equal((await request(JSON.stringify(preference))).status,200);
 assert.equal((await request(JSON.stringify({...preference,value:'Use concise plain language and short paragraphs'}))).status,200);
 const headers={Authorization:`Bearer ${app.token}`};
 const saved=await (await fetch(app.origin+'/api/memory',{headers})).json() as {key:string;userCorrected:boolean}[];
 assert.equal(saved.length,1);assert.equal(saved[0].userCorrected,true);
 const history=await (await fetch(app.origin+'/api/memory/history?key=writing',{headers})).json() as unknown[];
 assert.equal(history.length,2);
 assert.equal((await fetch(app.origin+'/api/memory')).status,403);
 assert.equal((await fetch(app.origin+'/api/memory/history?key=writing',{headers:{...headers,Origin:'https://evil.test'}})).status,403);
 const foreignApp=await startTaskReview(tasks,{...ns,accountId:'foreign'},evidence);
 try {
  const foreignHeaders={Authorization:`Bearer ${foreignApp.token}`};
  assert.deepEqual(await (await fetch(foreignApp.origin+'/api/memory',{headers:foreignHeaders})).json(),[]);
  assert.deepEqual(await (await fetch(foreignApp.origin+'/api/memory/history?key=writing',{headers:foreignHeaders})).json(),[]);
 } finally {await foreignApp.close();}
 const withoutMemory=await startTaskReview(tasks,ns);
 try {assert.equal((await fetch(withoutMemory.origin+'/api/memory',{headers:{Authorization:`Bearer ${withoutMemory.token}`}})).status,404);}
 finally {await withoutMemory.close();}
 const memory=new MemoryStore(evidence);
 assert.deepEqual(memory.list({...ns,accountId:'foreign'}),[]);assert.deepEqual(memory.list({...ns,workspaceId:'foreign'}),[]);
 const source=evidence.put(ns,Buffer.from('invented source'),'text/plain',[],{provider:'user'}).source!;
 const tools=contextTools(evidence,{},{});
 assert.throws(()=>tools.find(t=>t.name==='memory.search')!.inputSchema.parse({query:'x'.repeat(513)}));
 const record=tools.find(t=>t.name==='memory.record')!;
 assert.throws(()=>record.inputSchema.parse({...preference,sourceIds:[source.id],userCorrected:true}));
 const task=tasks.admit({...ns,messageId:'model-write',outcome:'inspect remembered preference'},8);
 await new AgentRuntime(tasks,contextTools(evidence,{},{})).run(task.id,{id:'scripted-not-live',async next(t){
  if(!t.observations.length)return {kind:'tool',name:'memory.record',args:{...preference,value:'Verbose technical jargon',sourceIds:[source.id]}};
  assert.equal((t.observations[0].data as {userCorrected:boolean}).userCorrected,false);
  return {kind:'ready',result:'model revision inspected'};
 }},3,{scope:{sources:[source],destinations:[],grants:['memory.record']}});
 assert.equal(memory.read(ns,'writing')?.value,'Use concise plain language and short paragraphs');
 await app.close();tasks.close();evidence.close();
 tasks=new AgentStore(join(dir,'agent.sqlite'));evidence=new EvidenceStore(join(dir,'context'));app=await startTaskReview(tasks,ns,evidence);
 const recall=tasks.admit({...ns,messageId:'restart-recall',outcome:'recall preference'},8);let observed=false;
 await new AgentRuntime(tasks,contextTools(evidence,{},{})).run(recall.id,{id:'scripted-not-live',async next(t){
  if(!t.observations.length)return {kind:'tool',name:'memory.search',args:{query:'plain concise'}};
  const result=t.observations[0].data as {value:string}[];
  assert.equal(result[0].value,'Use concise plain language and short paragraphs');observed=true;
  return {kind:'ready',result:'observed persisted user context, not permission'};
 }},3,{scope:{sources:[],destinations:[],grants:['memory.search']}});
 assert.equal(observed,true);assert.equal(tasks.get(recall.id).status,'ready');
 assert.equal(new MemoryStore(evidence).history(ns,'writing').length,3);
 } finally {await app.close();tasks.close();evidence.close();rmSync(dir,{recursive:true,force:true});}
});
