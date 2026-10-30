import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../../core/evidence/store.js';
import { AgentSessionStore } from '../../core/models/agent-session-store.js';
import { FileCallBudget } from '../../core/models/file-budget.js';
import { NebiusAgentProvider } from '../../core/models/agent-provider.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
const model = {provider:'nebius' as const,id:'mock',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.test/pricing'}};
test('durable envelope and cumulative usage survive close/reopen without namespace mixing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-session-')); const ns={workspaceId:'w',accountId:'a'};
 const path=join(dir,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const tasks=new AgentStore(':memory:');const task=tasks.admit({...ns,messageId:'m',outcome:'test'},10);
 let evidence=new EvidenceStore(dir);
 try {
 const sessions=new AgentSessionStore(evidence.db);const p=new NebiusAgentProvider({model,budget:new FileCallBudget(path),credential:async()=> 'mock',persist:sessions.persist,transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:{kind:'ready',result:'done'}})}}],usage:{prompt_tokens:100,completion_tokens:20}}))});
 await p.next(task,[]);evidence.close();evidence=new EvidenceStore(dir);
 const rows=new AgentSessionStore(evidence.db).list(ns,task.id);assert.equal(rows.length,1);assert.equal(rows[0].response?.usage?.inputTokens,100);assert.equal(rows[0].reservation,1);assert.equal(rows[0].model,'mock');assert.ok(rows[0].configDigest);assert.ok(rows[0].request);
 const reopened=new AgentSessionStore(evidence.db);
 assert.deepEqual(reopened.list({...ns,accountId:'other'},task.id),[]);
 await assert.rejects(reopened.persist({...rows[0],model:'substituted'}),/immutable/);
 await assert.rejects(reopened.persist({...rows[0],response:undefined}),/immutable/);
 assert.equal(reopened.list(ns,task.id)[0].model,'mock');
 const budget=new FileCallBudget(path);assert.equal(budget.snapshot().calls,1);assert.ok(budget.snapshot().accountedUsd>0);assert.equal(budget.reserve(0.001),2);
 }finally{evidence.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('batch decisions retain provider call IDs in immutable namespaced envelopes after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-batch-session-'));const ns={workspaceId:'w',accountId:'a'};
 const path=join(dir,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const tasks=new AgentStore(':memory:');const task=tasks.admit({...ns,messageId:'m',outcome:'Read two sources'},10);let evidence=new EvidenceStore(dir);
 const decision={kind:'batch',calls:[{callId:'first',name:'files.read',args:{id:'one'}},{callId:'second',name:'files.read',args:{id:'two'}}]};
 try {
 const sessions=new AgentSessionStore(evidence.db);const p=new NebiusAgentProvider({model,budget:new FileCallBudget(path),credential:async()=> 'mock',persist:sessions.persist,transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:decision})}}],usage:{prompt_tokens:100,completion_tokens:20}}))});
 const tools=[{name:'files.read',version:'1',effect:'read' as const,capabilities:[],inputSchema:{type:'object'},outputSchema:{type:'string'}}];
 assert.deepEqual(await p.next(task,tools),decision);evidence.close();evidence=new EvidenceStore(dir);
 const reopened=new AgentSessionStore(evidence.db);const rows=reopened.list(ns,task.id);assert.equal(rows.length,1);assert.deepEqual(rows[0].response?.decision,decision);
 assert.deepEqual(reopened.list({...ns,workspaceId:'other'},task.id),[]);
 await assert.rejects(reopened.persist({...rows[0],response:{...rows[0].response!,decision:{kind:'ready',result:'substituted'}}}),/immutable/);
 assert.deepEqual(reopened.list(ns,task.id)[0].response?.decision,decision);
 }finally{evidence.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('runtime cancellation during credential lookup never dispatches after late resolution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-cancel-'));const path=join(dir,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const tasks=new AgentStore(':memory:');const task=tasks.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'test'},10);
 let resolve!: (key:string)=>void;let entered!:()=>void;const pending=new Promise<string>(r=>resolve=r);const started=new Promise<void>(r=>entered=r);let calls=0;
 try{const p=new NebiusAgentProvider({model,budget:new FileCallBudget(path),credential:()=>{entered();return pending;},persist:async()=>{},transport:async()=>{calls++;throw new Error('must not dispatch');}});const runtime=new AgentRuntime(tasks,[]);const run=runtime.run(task.id,p,1);await started;runtime.cancel(task.id);await run;resolve('mock');await new Promise(r=>setTimeout(r,20));assert.equal(calls,0);assert.equal(tasks.get(task.id).status,'cancelled');}
 finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});
