import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import {AgentSessionStore} from '../../core/models/agent-session-store.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import type {ModelDeclaration} from '../../core/models/provider.js';
import {preparationBudget} from '../../core/preparation/budget.js';
const model:ModelDeclaration={provider:'nebius',id:'invented-offline',text:true,jsonObject:true,inputContextTokens:16384,maxOutputTokens:1024,pricing:{inputUsdPerMillion:.06,outputUsdPerMillion:.24,source:'https://example.test/offline',verifiedAt:'2026-10-26T00:00:00Z'}};
test('task call/USD caps and unknown full-context reservations survive store reopen before lazy credentials',async()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/budget-'));let tasks=new AgentStore(join(dir,'tasks.sqlite'));let evidence=new EvidenceStore(join(dir,'evidence'));
 try{
  // Invented ephemeral test journal ONLY. Production never creates or resets the owner's journal.
  const journal=join(dir,'invented-budget.json');writeFileSync(journal,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
  const global=new FileCallBudget(journal),task=tasks.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'Invented'},20);
  tasks.update(task.id,t=>{t.preparation={connectionId:'c',rootId:'r',incarnation:'i',rootRevision:1,googleAccountId:'invented@example.test',requestId:'m',request:'Invented',revision:1,processingConsent:true,saveOutputs:true,sources:[],artifactIds:[],fields:[],revisions:[],uploads:[],modelBudget:{limitUsd:.2,maximumDecisionCalls:1,maximumVisionCalls:1,decisionCalls:0,visionCalls:0,reservedUsd:0}};});
  let credentials=0,posts=0;
  const provider=new NebiusAgentProvider({model,budget:preparationBudget(tasks,task.id,global,'decision'),credential:async()=>{credentials++;return 'invented';},persist:new AgentSessionStore(evidence.db).persist,transport:async()=>{posts++;throw Error('Invented uncertain HTTP');}});
  await assert.rejects(provider.next(tasks.get(task.id),[]));assert.equal(credentials,1);assert.equal(posts,1);assert.equal(global.snapshot().calls,1);assert.equal(tasks.get(task.id).preparation!.modelBudget.reservedUsd,.0024576);
  tasks.close();evidence.close();tasks=new AgentStore(join(dir,'tasks.sqlite'));evidence=new EvidenceStore(join(dir,'evidence'));
  const resumed=new NebiusAgentProvider({model,budget:preparationBudget(tasks,task.id,new FileCallBudget(journal),'decision'),credential:async()=>{credentials++;return 'invented';},persist:new AgentSessionStore(evidence.db).persist,transport:async()=>{posts++;return Response.json({});}});
  await assert.rejects(resumed.next(tasks.get(task.id),[]),/TASK_MODEL_BUDGET_DENIED/);assert.equal(credentials,1);assert.equal(posts,1);assert.equal(new FileCallBudget(journal).snapshot().calls,1);assert.equal(new AgentSessionStore(evidence.db).list({workspaceId:'w',accountId:'a'},task.id).length,1);
  const vision=preparationBudget(tasks,task.id,global,'vision');assert.ok(vision instanceof FileCallBudget);assert.throws(()=>vision.reserve(.3),/TASK_MODEL_BUDGET_DENIED/);assert.equal(global.snapshot().calls,1);
 }finally{evidence.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('exclusive preparation ownership survives a simulated crash and cannot be silently stolen',()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/ownership-')),file=join(dir,'tasks.sqlite');let tasks=new AgentStore(file);
 try{tasks.claimPreparationOwner();tasks.close();tasks=new AgentStore(file);assert.throws(()=>tasks.claimPreparationOwner(),/PREPARATION_OWNER_RECONCILIATION_REQUIRED/);}finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});
