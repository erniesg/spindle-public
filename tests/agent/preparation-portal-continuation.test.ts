import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import type {AgentProvider,Task} from '../../core/agent/contracts.js';
import {preparationBrowserReview} from '../../core/preparation/browser-review.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {createTaskBrowserTools} from '../../core/agent/browser-host.js';
import {continuePreparationPortal,reconcilePreparationPortal,type PortalContinuationOptions,type PortalContinuationTarget} from '../../core/preparation/portal-continuation.js';
import {startPortal,type PortalConfig} from '../../examples/application-portal/server.js';
import {inventedPdf} from '../portal/fixtures.js';

// FIXTURE/CODE PROOF ONLY: invented loopback portal, scripted provider (not an LLM), existing Chromium.
const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const scratch=process.env.TMPDIR??'/home/ubuntu/.local/state/rucksack/scratch/pc';
const available=existsSync(executablePath);
const browser=available?await chromium.launch({executablePath,headless:true,chromiumSandbox:true}):undefined;
after(async()=>{await browser?.close();});
interface View {snapshotRef:string;fields:{ref:string;name:string;type:string}[];actions:{ref:string}[]}
const portalConfig:PortalConfig={title:'Invented continuation portal',fields:[{name:'participant_a',label:'Participant',required:true},{name:'contact_a',label:'Contact address',required:true,type:'email'}],attachments:[{name:'statement_a',label:'Statement',required:true,type:'application/pdf',maxBytes:50000}]};

async function fixture(lose=false){
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'pc-')),ns={workspaceId:'invented-workspace',accountId:'invented-owner'};
 const portal=await startPortal(join(root,'portal'),portalConfig,{loseResponseOnce:lose});
 const tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const source=store.put(ns,Buffer.from('Invented source: Mira Example'),'text/plain',[],{provider:'user',providerId:'invented-source',providerVersion:'1'}),pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[source.artifact.id]);
 const task=tasks.admit({...ns,messageId:'invented-preparation',outcome:'Prepare the invented application'},64);
 tasks.update(task.id,t=>{
  // Existing prepared work: retained counters, observation and an unmapped irrelevant field.
  t.status='ready';t.currentResult='Preparation needs review';t.generation=3;t.run.attempt=2;t.budget.used=5;
  t.observations.push({callId:'prior-prep-call',status:'ok',data:{note:'prior preparation'},artifacts:[],evidence:[],observations:[]});
  t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-revision-2'};
  t.preparation={connectionId:'invented-connection',rootId:'invented-root',incarnation:'invented-epoch',rootRevision:1,googleAccountId:'invented@example.test',requestId:'invented-request',request:'Invented application',revision:2,processingConsent:true,saveOutputs:false,sources:[source.source!],artifactIds:[source.artifact.id,pdf.artifact.id],artifactRevisions:{[source.artifact.id]:1,[pdf.artifact.id]:2},fields:[{id:'name',label:'Name',value:'Mira Corrected',unresolved:false,corrected:true,citations:[]},{id:'email',label:'Email',value:'mira@example.test',unresolved:false,citations:[]},{id:'notes',label:'Irrelevant prep note',value:'',unresolved:true,citations:[]}],revisions:[{revision:2,fieldId:'name',value:'Mira Corrected'}],uploads:[],modelBudget:{limitUsd:.3,maximumDecisionCalls:16,maximumVisionCalls:3,decisionCalls:1,visionCalls:0,reservedUsd:0}};
  t.preparation.artifactBindings={[pdf.artifact.id]:preparationArtifactBinding(t.preparation,pdf.artifact.sha256,['name'])};
 });
 const key='invented-reviewed-'+task.id;
 const target:PortalContinuationTarget={portal:{destination:portal.origin+'/',submissionUrl:portal.origin+'/applications',receiptUrl:portal.origin+'/receipts/'+digest(Buffer.from(key)),encoding:'multipart',constants:[{name:'idempotencyKey',value:key}]},
  selection:{fields:[{fieldId:'name',name:'participant_a'},{fieldId:'email',name:'contact_a'}],files:[{artifactId:pdf.artifact.id,field:'statement_a',filename:'invented-prepared.pdf'}]},
  required:{controls:['participant_a','contact_a','idempotencyKey'],files:['statement_a']}};
 const authority=new AbortController(),owner={current:true},cancel=new AbortController();
 const options=(provider:AgentProvider,extra:Partial<PortalContinuationOptions>={}):PortalContinuationOptions=>({tasks,store,namespace:ns,taskId:task.id,target,provider,caller:'account_api',maxTurns:12,timeoutMs:20000,cancel:cancel.signal,
  scope:{sources:[source.source!],destinations:[portal.origin+'/'],grants:[]},preflight:async()=>{},
  browser:{browser:browser!,sessionId:'invented-owner-session',readUrls:[],allowLoopback:true,timeoutMs:5000,authority:{id:'invented-authority-epoch',signal:authority.signal,isCurrent:()=>owner.current},
   readReceipt:async(page,intent,_ctx,saved)=>{
    const actual=JSON.parse(await page.locator('pre').innerText()) as {reference:string;status:string;digest:string};
    const fields=Object.fromEntries(saved.review.post.fields.filter(f=>f.name!=='idempotencyKey').map(f=>[f.name,f.value]));
    const files=saved.review.post.files.map(f=>{const a=saved.files.find(a=>a.id===f.artifactId)!;return {name:f.field,filename:f.filename,type:a.mimeType,bytes:a.bytes,sha256:a.sha256};});
    if(actual.status!=='submitted'||!intent.receiptUrl.endsWith(actual.reference)||actual.digest!==digest(Buffer.from(JSON.stringify({fields,files}))))return undefined;
    return {receiptId:actual.reference,contentHash:actual.digest,destination:intent.destination,revision:intent.revision};
   }},...extra});
 const shown=()=>preparationBrowserReview(tasks,store,ns,task.id,{expectedRevision:2,...target.selection},target.portal);
 const values=new Map<string,string>([['participant_a','Mira Corrected'],['contact_a','mira@example.test'],['idempotencyKey',key]]);
 const records=()=>existsSync(join(root,'portal'))?readdirSync(join(root,'portal')).filter(x=>x.endsWith('.json')):[];
 return {root,ns,tasks,store,taskId:task.id,pdf,target,authority,owner,cancel,options,shown,values,records,
  async close(){await portal.close();tasks.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const lastState=(t:Readonly<Task>)=>(t.observations.at(-1)?.data as {state?:string}|undefined)?.state;
/** Scripted invented provider (NOT a model). Fills reviewed controls in WRITE batches of <=4. */
function scripted(f:Fixture,hooks:{afterInspect?():void;beforeSubmit?():void;prematureReady?:boolean;ownRunOnly?:boolean}={}):AgentProvider&{seen:string[][]}{
 const seen:string[][]=[];let from:{observations:number;decisions:number}|undefined;
 return {id:'scripted-invented-continuation-NOT-LLM',seen,async next(task,metadata){
  seen.push(metadata.map(m=>m.name));
  // ownRunOnly: a resumed run re-inspects its fresh browser instead of reusing an earlier run's snapshot refs.
  from??=hooks.ownRunOnly?{observations:task.observations.length,decisions:task.decisions.length}:{observations:0,decisions:0};
  const t={...task,observations:task.observations.slice(from.observations),decisions:task.decisions.slice(from.decisions)};
  let view:View|undefined;for(const o of t.observations){const v=o.data as View|undefined;if(v?.snapshotRef&&v.fields)view=v;}
  if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
  hooks.afterInspect?.();
  const done=new Set(t.decisions.flatMap(d=>d.kind==='batch'?d.calls.map(c=>(c.args as {fieldRef:string}).fieldRef):[]));
  const open=view.fields.filter(x=>!done.has(x.ref)).slice(0,4);
  if(open.length)return {kind:'batch',calls:open.map(x=>x.type==='file'?{callId:randomUUID(),name:'browser.upload',args:{snapshotRef:view!.snapshotRef,fieldRef:x.ref,artifactId:f.pdf.artifact.id}}:{callId:randomUUID(),name:'browser.fill',args:{snapshotRef:view!.snapshotRef,fieldRef:x.ref,value:f.values.get(x.name)!}})};
  if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit')){hooks.beforeSubmit?.();return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};}
  if(lastState(t)==='verified')return {kind:'ready',result:'Observed persisted receipt and revisit'};
  // prematureReady models a model that keeps claiming Ready while a submission is unknown. Ready is refused
  // (READY_REJECTED feedback) every time, so the run stops with the write still held.
  if(hooks.prematureReady&&t.observations.some(o=>(o.data as {state?:string}|null)?.state==='uncertain')&&!t.observations.some(o=>(o.data as {state?:string}|null)?.state==='verified'))return {kind:'ready',result:'Premature ready must be refused'};
  return {kind:'tool',name:'browser.verify_submission',args:{}};
 }};
}
const contexts=()=>browser!.contexts().length;

test('pre-effect refusals: uncovered/empty required control, changed review, stale revision, not-ready, budget, authority lost during async preflight',{skip:!available},async()=>{
 const f=await fixture();try{
  const shown=f.shown(),approval={expectedRevision:2,fingerprint:shown.fingerprint,requestId:'owner-approve-1'},none:AgentProvider={id:'never-called',async next(){throw Error('provider must not run');}};
  const before=JSON.stringify(f.tasks.get(f.taskId));
  const refused=async(code:RegExp,extra:Partial<PortalContinuationOptions>={},a=approval)=>{await assert.rejects(continuePreparationPortal(f.options(none,extra),a),code);assert.equal(f.tasks.get(f.taskId).browser,undefined);assert.equal(contexts(),0);assert.equal(f.records().length,0);};
  await refused(/REQUIRED_UNCOVERED/,{target:{...f.target,required:{...f.target.required,files:['statement_a','photo_a']}}});
  await refused(/REVIEW_CHANGED/,{},{...approval,fingerprint:'0'.repeat(64)});
  await refused(/STALE_REVISION/,{},{...approval,expectedRevision:1});
  // Synchronous dispatch authority is rechecked after the earlier async auth check.
  await refused(/AUTHORITY_NOT_CURRENT/,{preflight:async()=>{f.owner.current=false;}});f.owner.current=true;
  // A correction landing during the async preflight invalidates the displayed review.
  await refused(/REVIEW_CHANGED|FILE_NOT_CURRENT/,{preflight:async()=>{f.tasks.update(f.taskId,t=>{t.preparation!.fields[1]!.value='changed@example.test';});}});
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[1]!.value='mira@example.test';});assert.equal(JSON.stringify(f.tasks.get(f.taskId)),before);
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[1]!.value='';});const empty=f.shown();await refused(/REQUIRED_EMPTY/,{},{...approval,fingerprint:empty.fingerprint});
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[1]!.value='mira@example.test';t.preparation!.modelBudget.decisionCalls=16;});await refused(/BUDGET_EXHAUSTED/);
  f.tasks.update(f.taskId,t=>{t.preparation!.modelBudget.decisionCalls=1;t.status='blocked';});await refused(/TASK_NOT_READY/);
  f.tasks.update(f.taskId,t=>{t.status='ready';});assert.equal(JSON.stringify(f.tasks.get(f.taskId)),before);
 }finally{await f.close();}
});

test('approval -> same-task recover -> batched fills/upload -> one POST -> observed verified receipt; counters/provenance preserved; replay is idempotent',{skip:!available},async()=>{
 const f=await fixture();try{
  const before=f.tasks.get(f.taskId),shown=f.shown(),provider=scripted(f),approval={expectedRevision:2,fingerprint:shown.fingerprint,requestId:'owner-approve-1'};
  const outcome=await continuePreparationPortal(f.options(provider),approval),t=f.tasks.get(f.taskId);
  assert.equal(outcome.state,'verified',JSON.stringify({outcome,blocker:t.blocker,obs:t.observations.map(o=>[o.status,o.error?.code])}));
  assert.equal(t.status,'ready');assert.equal(t.id,f.taskId);assert.equal(f.tasks.tasks(f.ns).length,1);assert.equal(f.records().length,1);
  const receipt=JSON.parse(readFileSync(join(f.root,'portal',f.records()[0]!),'utf8')) as {fields:Record<string,string>;files:{sha256:string}[]};
  assert.deepEqual(receipt.fields,{participant_a:'Mira Corrected',contact_a:'mira@example.test'});assert.equal(receipt.files[0]!.sha256,f.pdf.artifact.sha256);
  assert.ok(t.decisions.some(d=>d.kind==='batch'&&d.calls.length===4),'reviewed independent controls go through one serialized write batch');
  assert.ok(t.budget.used>before.budget.used&&t.budget.limit===before.budget.limit);assert.ok(t.generation>before.generation&&t.run.attempt>before.run.attempt);
  assert.deepEqual(t.observations[0],before.observations[0]);assert.deepEqual(t.preparation,before.preparation);assert.equal(t.recovery,'clean');assert.equal(t.pending,undefined);
  const state=t.browser!;assert.equal(state.approvalHistory!.requests.length,1);assert.equal(state.submission!.state,'verified');assert.equal(Object.values(state.writes).filter(w=>w.operation==='submit').length,1);
  const action=f.tasks.preparationActions(f.ns,f.taskId).find(a=>a.disposition==='portal_approved')!;assert.equal(action.actionId,'owner-approve-1');assert.match(action.intentHash!,/^[a-f0-9]{64}$/);
  assert.equal(contexts(),0);
  // Replay of the same owner request returns retained facts: no provider call, POST or counter change.
  const used=t.budget.used,replay=await continuePreparationPortal(f.options({id:'never',async next(){throw Error('no rerun');}}),approval);
  assert.equal(replay.state,'verified');assert.equal(f.tasks.get(f.taskId).budget.used,used);assert.equal(f.records().length,1);
  await assert.rejects(continuePreparationPortal(f.options(provider),{...approval,requestId:'owner-approve-2'}),/SUBMISSION_EXISTS/);
  // A replayed request id must name the review it approved; the receipt keeps that approval's provenance.
  await assert.rejects(continuePreparationPortal(f.options(provider),{...approval,fingerprint:'a'.repeat(64)}),/REQUEST_ID_CONFLICT/);
  await assert.rejects(continuePreparationPortal(f.options(provider),{...approval,expectedRevision:99}),/REQUEST_ID_CONFLICT/);
  assert.deepEqual(replay,outcome);assert.equal(replay.state==='verified'&&replay.approvalId,state.submission!.approvalId);assert.equal(f.records().length,1);
 }finally{await f.close();}
});

test('lost POST response: premature Ready refused, writes held, no second POST; read-only reconcile registers only verify and reaches verified',{skip:!available},async()=>{
 const f=await fixture(true);try{
  const shown=f.shown(),approval={expectedRevision:2,fingerprint:shown.fingerprint,requestId:'owner-approve-lost'};
  const held=await continuePreparationPortal(f.options(scripted(f,{prematureReady:true})),approval);
  assert.equal(held.state,'held');assert.equal(held.state==='held'&&held.submission,'uncertain');assert.equal(f.tasks.get(f.taskId).status,'blocked');assert.equal(f.records().length,1);
  await assert.rejects(continuePreparationPortal(f.options(scripted(f)),approval),/RECONCILIATION_REQUIRED/);
  await assert.rejects(continuePreparationPortal(f.options(scripted(f)),{...approval,requestId:'fresh-approval-cannot-reset'}),/SUBMISSION_EXISTS/);
  const verifier=scripted(f),done=await reconcilePreparationPortal(f.options(verifier));
  assert.equal(done.state,'verified',JSON.stringify(f.tasks.get(f.taskId).blocker));assert.ok(verifier.seen.every(names=>names.join()==='browser.verify_submission'));
  assert.equal(f.records().length,1);assert.equal(contexts(),0);
  // Fault injection: crash after the receipt commit but before the runtime recorded the observation.
  f.tasks.update(f.taskId,t=>{t.observations=t.observations.filter(o=>(o.data as {state?:string}|null)?.state!=='verified');t.status='blocked';});
  const unseen=await reconcilePreparationPortal(f.options({id:'scripted-ready-without-observing',async next(){return {kind:'ready',result:'Stored state alone is not observation'};}}));
  assert.equal(unseen.state,'held');assert.equal(f.tasks.get(f.taskId).blocker,'Repeated READY_REJECTED');// The streak of READY_REJECTED from the earlier run carries across Resume, so this run stops on its first Ready
  // (VERIFICATION_NOT_OBSERVED is not recorded). The safety property holds: the write stays held, never verified.
  assert.ok(!f.tasks.get(f.taskId).observations.some(o=>(o.data as {state?:string}|null)?.state==='verified'));
  assert.equal((await reconcilePreparationPortal(f.options(scripted(f)))).state,'verified');assert.equal(f.records().length,1);
 }finally{await f.close();}
});

test('owner cancel mid-run, disconnect before submit and a foreign run claim hold writes without POST and drain the browser',{skip:!available},async()=>{
 const f=await fixture();try{
  const approval={expectedRevision:2,fingerprint:f.shown().fingerprint,requestId:'owner-approve-cancel'};
  const cancelled=await continuePreparationPortal(f.options(scripted(f,{afterInspect:()=>f.cancel.abort()})),approval);
  assert.equal(cancelled.state,'cancelled');assert.equal(f.tasks.get(f.taskId).status,'cancelled');assert.equal(f.tasks.get(f.taskId).nextAction,'Cancelled by user');assert.equal(f.tasks.get(f.taskId).browser!.submission,undefined);assert.equal(f.records().length,0);assert.equal(contexts(),0);
 }finally{await f.close();}
 // Another runner claims the task mid-run: the post-run hold compares this run's captured claim, so it is left alone.
 const h=await fixture();try{
  const approval={expectedRevision:2,fingerprint:h.shown().fingerprint,requestId:'owner-approve-foreign'};
  const held=await continuePreparationPortal(h.options(scripted(h,{afterInspect:()=>{h.tasks.update(h.taskId,t=>{if(t.run.id!=='invented-other-runner'){t.generation++;t.run.id='invented-other-runner';}});}})),approval),t=h.tasks.get(h.taskId);
  assert.equal(held.state,'held');assert.equal(t.status,'working');assert.equal(t.run.id,'invented-other-runner');assert.equal(t.blocker,undefined);assert.equal(h.records().length,0);assert.equal(contexts(),0);
 }finally{await h.close();}
 const g=await fixture();try{
  const approval={expectedRevision:2,fingerprint:g.shown().fingerprint,requestId:'owner-approve-disconnect'};
  const held=await continuePreparationPortal(g.options(scripted(g,{beforeSubmit:()=>{g.owner.current=false;g.authority.abort();}})),approval);
  assert.equal(held.state,'held');assert.notEqual(g.tasks.get(g.taskId).status,'ready');assert.equal(g.tasks.get(g.taskId).browser!.submission,undefined);assert.equal(g.records().length,0);assert.equal(contexts(),0);
  assert.equal(held.state==='held'&&held.interruption,'authority');
 }finally{await g.close();}
});

test('configured deadline after the POST is a reconcilable hold, not owner cancel; read-only reconcile verifies with one POST total',{skip:!available},async()=>{
 const f=await fixture();try{
  const approval={expectedRevision:2,fingerprint:f.shown().fingerprint,requestId:'owner-approve-deadline'},base=scripted(f);
  // Slow receipt/provider after submit: honours ctx.signal, never returns on its own.
  const slow:AgentProvider={id:'scripted-slow-after-submit-NOT-LLM',async next(t,m,ctx){
   if(t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return await new Promise((_,reject)=>{ctx!.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
   return base.next(t,m,ctx);}};
  const held=await continuePreparationPortal(f.options(slow,{timeoutMs:6000}),approval),t=f.tasks.get(f.taskId);
  assert.deepEqual({state:held.state,code:held.state==='held'&&held.code,interruption:held.state==='held'&&held.interruption,submission:held.state==='held'&&held.submission},{state:'held',code:'PORTAL_CONTINUATION_RECONCILIATION_REQUIRED',interruption:'deadline',submission:'uncertain'});
  assert.equal(t.status,'blocked');assert.equal(t.blocker,'PORTAL_CONTINUATION_DEADLINE_EXCEEDED');assert.notEqual(t.nextAction,'Cancelled by user');assert.equal(t.recovery,'clean');assert.equal(f.records().length,1);assert.equal(contexts(),0);
  await assert.rejects(continuePreparationPortal(f.options(scripted(f)),{...approval,requestId:'owner-approve-deadline-2'}),/SUBMISSION_EXISTS/);
  const verifier=scripted(f),done=await reconcilePreparationPortal(f.options(verifier));
  assert.equal(done.state,'verified',JSON.stringify(f.tasks.get(f.taskId).blocker));assert.ok(verifier.seen.every(names=>names.join()==='browser.verify_submission'));
  assert.equal(f.records().length,1);assert.equal(contexts(),0);
 }finally{await f.close();}
});

test('clean module interruption before submit: only a fresh explicit current approval continues the same task to one verified POST',{skip:!available},async()=>{
 const f=await fixture();try{
  const first={expectedRevision:2,fingerprint:f.shown().fingerprint,requestId:'owner-approve-interrupted'};
  const held=await continuePreparationPortal(f.options(scripted(f,{beforeSubmit:()=>{f.owner.current=false;f.authority.abort();}})),first);
  assert.equal(held.state,'held');assert.equal(f.records().length,0);
  const before=f.tasks.get(f.taskId);assert.equal(before.status,'blocked');assert.equal(before.blocker,'PORTAL_CONTINUATION_INTERRUPTED');
  // A new sign-in/session epoch: the coordinator supplies a fresh current authority.
  const authority=new AbortController(),fresh=(provider:AgentProvider)=>{const o=f.options(provider);return {...o,browser:{...o.browser,authority:{id:'invented-authority-epoch-2',signal:authority.signal,isCurrent:()=>true}}};};
  const none:AgentProvider={id:'never-called',async next(){throw Error('provider must not run');}},shown=f.shown();
  // Any other blocked state stays coordinator-owned.
  f.tasks.update(f.taskId,t=>{t.blocker='Agent turn bound reached';});
  await assert.rejects(continuePreparationPortal(fresh(none),{expectedRevision:2,fingerprint:shown.fingerprint,requestId:'owner-approve-other-block'}),/TASK_NOT_READY/);
  f.tasks.update(f.taskId,t=>{t.blocker='PORTAL_CONTINUATION_INTERRUPTED';});
  await assert.rejects(continuePreparationPortal(fresh(none),{...first,fingerprint:shown.fingerprint}),/REQUEST_ALREADY_USED/);
  await assert.rejects(continuePreparationPortal(fresh(none),{...first,requestId:'owner-approve-stale-view'}),/REVIEW_CHANGED/);
  const again={expectedRevision:2,fingerprint:f.shown().fingerprint,requestId:'owner-approve-resumed'};
  const done=await continuePreparationPortal(fresh(scripted(f,{ownRunOnly:true})),again),t=f.tasks.get(f.taskId);
  assert.equal(done.state,'verified',JSON.stringify({done,blocker:t.blocker}));assert.equal(t.id,f.taskId);assert.equal(f.tasks.tasks(f.ns).length,1);assert.equal(f.records().length,1);
  const history=t.browser!.approvalHistory!.requests;assert.deepEqual(history.map(a=>[a.requestId,a.revoked,a.superseded]),[['owner-approve-interrupted',true,true],['owner-approve-resumed',false,false]]);
  assert.ok(t.budget.used>before.budget.used&&t.budget.limit===before.budget.limit);assert.deepEqual(t.preparation,before.preparation);
  assert.deepEqual(f.tasks.preparationActions(f.ns,f.taskId).filter(a=>a.disposition==='portal_approved').map(a=>a.actionId),['owner-approve-interrupted','owner-approve-resumed']);
  assert.equal(held.state==='held'&&held.interruption,'authority');assert.equal(contexts(),0);
 }finally{await f.close();}
});

const brief=(f:Fixture)=>{const t=f.tasks.get(f.taskId);return {status:t.status,blocker:t.blocker,recovery:t.recovery,pending:t.pending?.tool,submission:t.browser?.submission?.state,posts:f.records().length,contexts:contexts()};};
// The coordinator's fresh sign-in/session epoch after a disconnect.
const fresh=(f:Fixture,provider:AgentProvider)=>{const o=f.options(provider);return {...o,browser:{...o.browser,authority:{id:'invented-authority-epoch-2',signal:new AbortController().signal,isCurrent:()=>true}}};};
// Disconnects (signal + not current) the first time the task records `tool` as pending.
const disconnectAt=(f:Fixture,o:PortalContinuationOptions,tool:string):PortalContinuationOptions=>{let fired=false;return {...o,browser:{...o.browser,authority:{...o.browser.authority,isCurrent:t=>{if(!fired&&t.pending?.tool===tool){fired=true;f.owner.current=false;f.authority.abort();}return f.owner.current;}}}};};

test('deadline WHILE verify_submission reads the slow receipt after the POST: the retired read does not strand; read-only reconcile verifies, one POST',{skip:!available},async()=>{
 const d=await fixture();try{
  const slowReceipt:NonNullable<PortalContinuationOptions['browser']['readReceipt']>=async(_page,_intent,ctx)=>{await new Promise<void>(r=>{if(ctx.signal.aborted)r();else ctx.signal.addEventListener('abort',()=>r(),{once:true});});return undefined;};
  const o=d.options(scripted(d),{timeoutMs:6000}),approval={expectedRevision:2,fingerprint:d.shown().fingerprint,requestId:'owner-approve-slow-receipt'};
  const held=await continuePreparationPortal({...o,browser:{...o.browser,timeoutMs:20000,readReceipt:slowReceipt}},approval);
  assert.deepEqual({state:held.state,interruption:held.state==='held'&&held.interruption,submission:held.state==='held'&&held.submission},{state:'held',interruption:'deadline',submission:'uncertain'});
  assert.deepEqual(brief(d),{status:'blocked',blocker:'PORTAL_CONTINUATION_DEADLINE_EXCEEDED',recovery:'clean',pending:undefined,submission:'uncertain',posts:1,contexts:0});
  await assert.rejects(continuePreparationPortal(d.options(scripted(d)),{...approval,requestId:'owner-approve-slow-receipt-2'}),/SUBMISSION_EXISTS/);
  const verifier=scripted(d),done=await reconcilePreparationPortal(d.options(verifier));
  assert.equal(done.state,'verified',JSON.stringify(brief(d)));assert.ok(verifier.seen.every(names=>names.join()==='browser.verify_submission'));
  assert.equal(d.records().length,1);assert.equal(d.tasks.tasks(d.ns).length,1);
 }finally{await d.close();}
});

test('disconnect WHILE verify_submission reads after the POST: reconcile under the new authority verifies, one POST',{skip:!available},async()=>{
 const r=await fixture();try{
  const held=await continuePreparationPortal(disconnectAt(r,r.options(scripted(r)),'browser.verify_submission'),{expectedRevision:2,fingerprint:r.shown().fingerprint,requestId:'owner-approve-receipt-disconnect'});
  assert.equal(held.state==='held'&&held.interruption,'authority');
  assert.deepEqual(brief(r),{status:'blocked',blocker:'PORTAL_CONTINUATION_INTERRUPTED',recovery:'clean',pending:undefined,submission:'uncertain',posts:1,contexts:0});
  assert.equal((await reconcilePreparationPortal(fresh(r,scripted(r)))).state,'verified');assert.equal(r.records().length,1);
 }finally{await r.close();}
});

test('disconnect WHILE browser.inspect reads before any write: only a fresh explicit current approval continues the same task, one POST',{skip:!available},async()=>{
 const i=await fixture();try{
  const first={expectedRevision:2,fingerprint:i.shown().fingerprint,requestId:'owner-approve-inspect-disconnect'};
  const held=await continuePreparationPortal(disconnectAt(i,i.options(scripted(i)),'browser.inspect'),first);
  assert.equal(held.state==='held'&&held.interruption,'authority');
  assert.deepEqual(brief(i),{status:'blocked',blocker:'PORTAL_CONTINUATION_INTERRUPTED',recovery:'clean',pending:undefined,submission:undefined,posts:0,contexts:0});
  await assert.rejects(reconcilePreparationPortal(fresh(i,scripted(i))),/NO_SUBMISSION/);
  await assert.rejects(continuePreparationPortal(fresh(i,scripted(i)),{...first,fingerprint:i.shown().fingerprint}),/REQUEST_ALREADY_USED/);
  const done=await continuePreparationPortal(fresh(i,scripted(i,{ownRunOnly:true})),{expectedRevision:2,fingerprint:i.shown().fingerprint,requestId:'owner-approve-inspect-resumed'}),t=i.tasks.get(i.taskId);
  assert.equal(done.state,'verified',JSON.stringify(brief(i)));assert.equal(t.id,i.taskId);assert.equal(i.tasks.tasks(i.ns).length,1);assert.equal(i.records().length,1);
  assert.deepEqual(t.browser!.approvalHistory!.requests.map(a=>[a.requestId,a.revoked,a.superseded]),[['owner-approve-inspect-disconnect',true,true],['owner-approve-inspect-resumed',false,false]]);
 }finally{await i.close();}
});

test('guard: the same supersede with the submit WRITE in flight keeps it pending and reconciliation_required',{skip:!available},async()=>{
 const w=await fixture();try{
  const approval={expectedRevision:2,fingerprint:w.shown().fingerprint,requestId:'owner-approve-submit-disconnect'};
  const held=await continuePreparationPortal(disconnectAt(w,w.options(scripted(w)),'browser.submit'),approval);
  assert.equal(held.state==='held'&&held.code,'PORTAL_CONTINUATION_RECONCILIATION_REQUIRED');
  assert.deepEqual(brief(w),{status:'blocked',blocker:'PORTAL_CONTINUATION_INTERRUPTED',recovery:'reconciliation_required',pending:'browser.submit',submission:undefined,posts:0,contexts:0});
  // Write uncertainty stays coordinator-owned: neither a fresh approval nor read-only reconcile admits it.
  await assert.rejects(continuePreparationPortal(fresh(w,scripted(w)),{...approval,requestId:'owner-approve-submit-disconnect-2'}),/TASK_NOT_READY/);
  await assert.rejects(reconcilePreparationPortal(fresh(w,scripted(w))),/NO_SUBMISSION/);
  assert.equal(w.tasks.get(w.taskId).pending?.tool,'browser.submit');assert.equal(w.records().length,0);
 }finally{await w.close();}
});

test('owner-action audit failure after host.approve revokes the approval: no live write authority and no POST even after generic recover',{skip:!available},async()=>{
 const f=await fixture();try{
  // Real saturation of the namespace action history (4096) by unrelated invented actions.
  for(let i=0;i<4096;i++)f.tasks.recordPreparationAction(f.ns,{action:'request',actionId:'invented-filler-'+i,disposition:'invented',taskId:'invented-other-task',runId:'invented-run',generation:0,observedAt:new Date().toISOString(),caller:'account_api'});
  const before=f.tasks.get(f.taskId),approval={expectedRevision:2,fingerprint:f.shown().fingerprint,requestId:'owner-approve-unaudited'};
  await assert.rejects(continuePreparationPortal(f.options(scripted(f)),approval),/PREPARATION_ACTION_HISTORY_FULL/);
  const t=f.tasks.get(f.taskId);
  assert.equal(t.status,'ready');assert.equal(t.generation,before.generation);assert.equal(f.tasks.preparationActions(f.ns,f.taskId).length,0);
  assert.equal(t.browser!.approval!.revoked,true);assert.ok(t.browser!.approvalHistory!.requests.every(a=>a.revoked));assert.equal(f.records().length,0);assert.equal(contexts(),0);
  // A later host with the same authority/session after a generic recover still cannot write.
  const o=f.options(scripted(f)),host=await createTaskBrowserTools({...o.browser,tasks:f.tasks,store:f.store,namespace:f.ns,taskId:f.taskId,destination:f.target.portal.destination,submissionUrl:f.target.portal.submissionUrl});
  try{f.tasks.recover(f.taskId);await new AgentRuntime(f.tasks,host.tools).run(f.taskId,scripted(f),12,{scope:o.scope,approveExternalWrite:host.execution.approveExternalWrite,timeoutMs:20000});}finally{await host.close();}
  const after=f.tasks.get(f.taskId);assert.equal(after.status,'blocked');assert.deepEqual(after.browser!.writes,{});assert.equal(f.records().length,0);assert.equal(contexts(),0);
 }finally{await f.close();}
});
