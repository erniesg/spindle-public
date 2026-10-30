import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../../core/storage/agent-store.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {CallBudget,type ModelDeclaration} from '../../core/models/provider.js';
const model:ModelDeclaration={provider:'nebius',id:'offline-browser-state',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:.3,outputUsdPerMillion:.9,verifiedAt:'2026-10-28',source:'https://example.test/pricing'}};
const revision={applicationId:'invented',revision:1,contentHash:'a'.repeat(64)};

test('next persisted prompt contains detached inert browser state, observations and pending uncertainty, not authority tokens',async()=>{
 const tasks=new AgentStore(':memory:');const t=tasks.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'Complete the reviewed fictional application'},100);
 tasks.update(t.id,t=>{
  t.applicationRevision=revision;t.pending={callId:'private-pending-id',tool:'browser.submit',effect:'external_write'};
  t.observations=[{callId:'observed',status:'ok',data:{state:'dispatched',nextAction:'Reconcile via browser.verify_submission'},artifacts:[],evidence:[],observations:[]}];
  t.browser={recovery:'reconciliation_required',approval:{id:'private-approval',requestId:'private-request',authorityId:'private-authority',sessionId:'private-session',destination:'https://portal.example.test/',submissionUrl:'https://portal.example.test/applications',revision,artifact:{id:'review-artifact',sha256:'b'.repeat(64),mimeType:'application/json',bytes:1,relativePath:'artifacts/review-artifact',createdAt:'2026-10-28',derivedFrom:[],version:1},revoked:false},writes:{call:{operation:'submit',approvalId:'private-approval',inputHash:'c'.repeat(64),revision,runId:'private-run',generation:1,pendingCallId:'private-pending-id',state:'uncertain',networkWrite:true,artifacts:[]}},submission:{intent:{id:'private-intent',sessionId:'private-session',destination:'https://portal.example.test/',revision,inputHash:'c'.repeat(64),receiptUrl:'https://portal.example.test/receipts/demo',state:'uncertain'},approvalId:'private-approval',reviewArtifact:{id:'review-artifact',sha256:'b'.repeat(64),mimeType:'application/json',bytes:1,relativePath:'artifacts/review-artifact',createdAt:'2026-10-28',derivedFrom:[],version:1},callId:'call',state:'uncertain',artifacts:[],uncertaintyCount:1}};
 });
 let request:any;const task=tasks.get(t.id);
 try{
  const p=new NebiusAgentProvider({model,budget:new CallBudget(1,3),credential:async()=>'offline-only',persist:async e=>{request=structuredClone(e.request);},transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:null,content:JSON.stringify({next_action:{kind:'ready',result:'offline response only'}})}}],usage:{prompt_tokens:100,completion_tokens:20}}))});
  await p.next(task,[{name:'browser.inspect',version:'1',effect:'read',capabilities:[],inputSchema:{},outputSchema:{}}]);
  const u=JSON.parse(request.messages[1].content).untrustedTask;
  assert.deepEqual(u.applicationRevision,revision);assert.equal(u.browserExecution.recovery,'reconciliation_required');assert.equal(u.browserExecution.retainedReview.matchesCurrentRevision,true);
  assert.equal(u.browserExecution.submission.state,'uncertain');assert.equal(u.browserExecution.writes[0].state,'uncertain');assert.deepEqual(u.browserExecution.pending,{tool:'browser.submit',effect:'external_write'});
  assert.equal(u.observations[0].data.state,'dispatched');assert.match(request.messages[0].content,/read-only.*verify_submission/);
  const projection=JSON.stringify(u.browserExecution);assert.doesNotMatch(projection,/private-|grants|credential/);
  task.browser!.submission!.state='verified';assert.equal(u.browserExecution.submission.state,'uncertain','persisted prompt is detached');
 }finally{tasks.close();}
});

test('non-browser prompt does not acquire browser instructions or state',async()=>{
 const tasks=new AgentStore(':memory:');const task=tasks.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'Read only'},10);let request:any;
 try{
  const p=new NebiusAgentProvider({model,budget:new CallBudget(1,2),credential:async()=>'offline-only',persist:async e=>{request=e.request;},transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:{kind:'ready',result:'offline'}})}}]}))});
  await p.next(task,[]);assert.doesNotMatch(request.messages[0].content,/retained browser|browser\.verify_submission/);assert.equal(JSON.parse(request.messages[1].content).untrustedTask.browserExecution,undefined);
 }finally{tasks.close();}
});
