import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {createTaskBrowserTools,type TaskBrowserOptions,type TaskBrowserReview} from '../../core/agent/browser-host.js';
import type {AgentProvider,ApplicationRevisionRef,Task,ToolContext} from '../../core/agent/contracts.js';
import {startPortal,type PortalConfig} from '../../examples/application-portal/server.js';
import {inventedPdf} from '../portal/fixtures.js';

const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const scratch=process.env.TMPDIR??'/home/ubuntu/.local/state/rucksack/scratch/bt';
const revision:ApplicationRevisionRef={applicationId:'invented-application',revision:1,contentHash:digest(Buffer.from('invented approved application'))};
interface View {snapshotRef:string;fields:{ref:string;name:string;type:string;label:string}[];actions:{ref:string}[]}
const data=(t:Readonly<Task>)=>t.observations.at(-1)?.data as {state?:string}|undefined;
async function fixture(variant=0,lose=false,dispatch?:TaskBrowserOptions['authority']['dispatch']){
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'bt-'));
 const portalConfig:PortalConfig={title:'Invented normal-runtime form',fields:variant?[{name:'reply_z',label:'Reply mailbox',required:true,type:'email'},{name:'visitor_z',label:'Workshop guest',required:true}]:[{name:'visitor_a',label:'Participant',required:true},{name:'email_a',label:'Contact address',required:true,type:'email'}],attachments:[{name:variant?'document_z':'proposal_a',label:variant?'Workshop narrative':'Written proposal',required:true,type:'application/pdf',maxBytes:50000}]};
 const portal=await startPortal(join(root,'portal'),portalConfig,{loseResponseOnce:lose});
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true});
 let tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const ns={accountId:'owner',workspaceId:'workspace'};
 const task=tasks.admit({...ns,messageId:'invented-trigger',outcome:'Submit this reviewed invented application and verify receipt'},120);
 tasks.update(task.id,t=>{t.applicationRevision=revision;});
 const pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[],{provider:'user',providerId:'invented-source',providerVersion:'1'});
 const scope={sources:[pdf.source!],destinations:[portal.origin+'/'],grants:[]};
 const key='invented-key-'+task.id,fields=portalConfig.fields.map(f=>({name:f.name,value:f.type==='email'?'invented@example.test':'Reviewed invented guest'}));
 const review:TaskBrowserReview={revision,controls:[...fields,{name:'idempotencyKey',value:key}],post:{url:portal.origin+'/applications',encoding:'multipart',fields:[...fields,{name:'idempotencyKey',value:key}],files:[{field:portalConfig.attachments[0]!.name,artifactId:pdf.artifact.id,filename:'reviewed.pdf'}]},receiptUrl:portal.origin+'/receipts/'+digest(Buffer.from(key))};
 const authoritySignal=new AbortController();let ownerCurrent=true;
 const makeOptions=():TaskBrowserOptions=>({tasks,store,namespace:ns,taskId:task.id,browser,sessionId:'stable-owner-session',destination:portal.origin+'/',submissionUrl:portal.origin+'/applications',readUrls:[],allowLoopback:true,timeoutMs:5000,authority:{id:'owner-session-epoch',signal:authoritySignal.signal,isCurrent:()=>ownerCurrent,dispatch},
  readReceipt:async(page,intent,_ctx,saved)=>{
   const actual=JSON.parse(await page.locator('pre').innerText()) as {reference:string;status:string;digest:string};
   const expectedFields=Object.fromEntries(saved.review.post.fields.filter(f=>f.name!=='idempotencyKey').map(f=>[f.name,f.value]));
   const files=saved.review.post.files.map(f=>{const a=saved.files.find(a=>a.id===f.artifactId)!;return {name:f.field,filename:f.filename,type:a.mimeType,bytes:a.bytes,sha256:a.sha256};});
   if(actual.status!=='submitted'||!intent.receiptUrl.endsWith(actual.reference)||actual.digest!==digest(Buffer.from(JSON.stringify({fields:expectedFields,files}))))return undefined;
   return {receiptId:actual.reference,contentHash:actual.digest,destination:intent.destination,revision:intent.revision};
  }});
 let host=await createTaskBrowserTools(makeOptions());
 const resume=()=>tasks.update(task.id,t=>{t.status='working';t.generation++;delete t.currentResult;});
 const run=async(provider:AgentProvider,turns=20)=>new AgentRuntime(tasks,host.tools).run(task.id,provider,turns,{...host.execution,scope,timeoutMs:20000});
 // stubborn: once a submission is unknown, keep declaring Ready and never verify (Ready must keep being refused).
 const provider=(approve=true,stubborn=false):AgentProvider=>({id:'scripted-invented-browser-NOT-LLM',async next(t,metadata){
  assert.ok(metadata.some(m=>m.name==='browser.fill'&&m.effect==='external_write'));
  let view:View|undefined;for(const observation of t.observations){const v=observation.data as View|undefined;if(v?.snapshotRef&&v.fields)view=v;}
  if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
  if(approve&&!host.status().approval)host.approve(review,'one-owner-submit-instruction');
  const field=view.fields.find(f=>!t.decisions.some(d=>d.kind==='tool'&&['browser.fill','browser.upload'].includes(d.name)&&(d.args as {fieldRef?:string}).fieldRef===f.ref));
  if(field){if(field.type==='file')return {kind:'tool',name:'browser.upload',args:{snapshotRef:view.snapshotRef,fieldRef:field.ref,artifactId:pdf.artifact.id}};
   const value=field.label.startsWith('Submission identity')?key:field.type==='email'?'invented@example.test':'Reviewed invented guest';
   return {kind:'tool',name:'browser.fill',args:{snapshotRef:view.snapshotRef,fieldRef:field.ref,value}};}
  if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};
  if(data(t)?.state==='uncertain'||stubborn&&t.observations.some(o=>(o.data as {state?:string}|null)?.state==='uncertain')&&!t.observations.some(o=>(o.data as {state?:string}|null)?.state==='verified'))return {kind:'ready',result:'This must not bypass uncertainty'};
  if(data(t)?.state!=='verified')return {kind:'tool',name:'browser.verify_submission',args:{}};
  return {kind:'ready',result:'Observed actual persisted receipt and revisit'};
 }});
 return {root,portal,browser,ns,taskId:task.id,scope,review,pdf,run,provider,resume,makeOptions,get tasks(){return tasks;},get store(){return store;},get host(){return host;},revokeSession(){ownerCurrent=false;authoritySignal.abort();},async reopen(){await host.close();tasks.close();store.close();tasks=new AgentStore(join(root,'tasks.sqlite'));store=new EvidenceStore(join(root,'evidence'));host=await createTaskBrowserTools(makeOptions());},async close(){await host.close();await browser.close();await portal.close();tasks.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('packet dispatch uses the protected gate for actual GET and POST without changing the normal receipt journey',async()=>{
 let packets=0;const f=await fixture(0,false,async(guard,start,signal)=>{signal.throwIfAborted();assert.equal(guard(),true);packets++;return {started:start()};});try{
  await f.run(f.provider());assert.equal(f.tasks.get(f.taskId).status,'ready');assert.equal(f.host.status().submission?.state,'verified');assert.ok(packets>=3);
  assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);
 }finally{await f.close();}
});

test('an earlier owner check cannot bypass final protected source rejection at the actual POST',async()=>{
 let submitting=false,denied=0;const f=await fixture(0,false,async(guard,start,signal)=>{
  signal.throwIfAborted();assert.equal(guard(),true);
  if(submitting){denied++;throw Error('INVENTED_FINAL_ROOT_REVOKED');}
  return {started:start()};
 });try{
  const scripted=f.provider();await f.run({...scripted,async next(...args){const decision=await scripted.next(...args);if(decision.kind==='tool'&&decision.name==='browser.submit')submitting=true;return decision;}});
  assert.ok(denied>0);assert.notEqual(f.tasks.get(f.taskId).status,'ready');
  assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,0,'no submitted receipt may exist');
 }finally{await f.close();}
});

test('actual normal runtime: observed refs -> one owner approval -> real fill/PDF/POST -> later verified receipt, two changed forms',async()=>{
 for(const variant of [0,1]){const f=await fixture(variant);try{
  await f.run(f.provider());const task=f.tasks.get(f.taskId),state=f.host.status();
  assert.equal(task.status,'ready',JSON.stringify({blocker:task.blocker,observations:task.observations.map(o=>({status:o.status,error:o.error,data:o.data}))}));
  assert.equal(state.submission?.state,'verified');assert.equal(state.recovery,'clean');assert.equal(task.externalAction?.state,'verified');assert.ok(state.submission!.artifacts.length>0);
  assert.equal(Object.values(state.writes).filter(w=>w.operation==='submit').length,1);assert.ok(Object.values(state.writes).every(w=>['dispatched','verified'].includes(w.state)));
  const records=readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json'));assert.equal(records.length,1);
  const receipt=JSON.parse(readFileSync(join(f.root,'portal',records[0]!),'utf8')) as {files:{sha256:string}[]};assert.deepEqual(readFileSync(join(f.root,'portal',receipt.files[0]!.sha256+'.upload')),Buffer.from(inventedPdf()));
  assert.equal(task.pending,undefined);assert.equal(task.recovery,'clean');assert.ok(task.budget.used>10);assert.ok(task.generation>0);
 }finally{await f.close();}}
});

test('normal runtime can inspect before an application revision or Submit approval exists',async()=>{
 const f=await fixture();try{
  f.tasks.update(f.taskId,t=>{delete t.applicationRevision;});let observed=false;
  await f.run({id:'scripted-read-before-review',async next(t){if(!t.observations.length)return {kind:'tool',name:'browser.inspect',args:{}};assert.ok((t.observations[0]!.data as View).fields.length);observed=true;return {kind:'ready',result:'Read only; no application or approval'};}},2);
  assert.equal(observed,true);assert.equal(f.tasks.get(f.taskId).status,'ready');assert.equal(f.host.status().approval,undefined);assert.equal(Object.keys(f.host.status().writes).length,0);assert.equal(readdirSync(join(f.root,'portal')).length,0);
 }finally{await f.close();}
});

test('unapproved runtime writes, wrong tenant and changed revision cannot dispatch',async()=>{
 const f=await fixture();try{
  await f.run(f.provider(false),2);assert.equal(f.tasks.get(f.taskId).status,'blocked');assert.equal(readdirSync(join(f.root,'portal')).length,0);
  const wrong={...f.makeOptions(),namespace:{accountId:'other',workspaceId:'workspace'}};await assert.rejects(createTaskBrowserTools(wrong),/TASK_NOT_FOUND/);
  f.tasks.update(f.taskId,t=>{t.applicationRevision={...revision,revision:2};});assert.throws(()=>f.host.approve(f.review,'wrong-revision'),/REVIEW_NOT_CURRENT/);assert.equal(f.host.status().approval,undefined);
 }finally{await f.close();}
});

test('revoked owner approval and changed immutable attachment fail before any POST',async()=>{
 const f=await fixture();try{
  const approval=f.host.approve(f.review,'owner-submit');await f.host.revoke(approval.id);f.resume();await f.run(f.provider(false));assert.equal(readdirSync(join(f.root,'portal')).length,0);
  f.resume();f.host.approve(f.review,'renewed-owner-submit');writeFileSync(join(f.root,'evidence','artifacts',f.pdf.artifact.id),'Corrupted invented bytes');
  await f.run(f.provider(false));assert.equal(readdirSync(join(f.root,'portal')).length,0);assert.equal(f.host.status().submission,undefined);
 }finally{await f.close();}
});

test('lost ACK survives complete stores reopen; unknown blocks new approval/Ready after runtime clears pending, recovery never rePOSTs',async()=>{
 const f=await fixture(0,true);try{
  await f.run(f.provider(true,true));const task=f.tasks.get(f.taskId),before=f.host.status();
  // Ready is refused as feedback while the submission is unknown; repeated refusals stop the run, the host keeps the hold.
  assert.equal(task.status,'blocked');assert.equal(task.blocker,'Repeated READY_REJECTED');assert.ok(task.observations.filter(o=>o.error?.code==='READY_REJECTED').every(o=>/BROWSER_RECONCILIATION/.test(o.error!.message)));assert.equal(task.currentResult,undefined);assert.equal(task.pending,undefined);assert.equal(before.recovery,'reconciliation_required');assert.equal(before.submission?.state,'uncertain');
  assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);
  const preserved={budget:task.budget,generation:task.generation,run:task.run,recovery:task.recovery};await f.reopen();assert.deepEqual({budget:f.tasks.get(f.taskId).budget,generation:f.tasks.get(f.taskId).generation,run:f.tasks.get(f.taskId).run,recovery:f.tasks.get(f.taskId).recovery},preserved);
  assert.equal(f.host.status().submission!.intent.id,before.submission!.intent.id);assert.throws(()=>f.host.approve(f.review,'new-approval-cannot-reset'),/RECONCILIATION/);
  f.resume();let observed=false;await f.run({id:'scripted-receipt-recovery-NOT-model',async next(t){if(data(t)?.state!=='verified')return {kind:'tool',name:'browser.verify_submission',args:{}};observed=true;return {kind:'ready',result:'Actual persisted receipt reconciled without POST'};}},3);
  assert.equal(observed,true);assert.equal(f.tasks.get(f.taskId).status,'ready');assert.equal(f.host.status().submission?.state,'verified');assert.equal(f.host.status().recovery,'clean');
  const intent=f.host.status().submission!.intent;await f.reopen();f.resume();await f.run(f.provider(false),1);assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);assert.equal(f.host.status().submission!.intent.id,intent.id);
 }finally{await f.close();}
});

test('new revision cannot erase unknown old receipt; read-only original-intent recovery preserves current Task revision',async()=>{
 const f=await fixture(1,true);try{
  await f.run(f.provider(true,true));assert.equal(f.host.status().submission?.state,'uncertain');const original=f.host.status().submission!.intent;
  const newer={...revision,revision:2,contentHash:digest(Buffer.from('edited revision'))};f.tasks.update(f.taskId,t=>{t.applicationRevision=newer;});await f.reopen();
  assert.throws(()=>f.host.approve({...f.review,revision:newer},'cannot-bypass-old'),/RECONCILIATION/);
  f.resume();await f.run({id:'scripted-old-receipt-read',async next(){return {kind:'tool',name:'browser.verify_submission',args:{}};}},1);
  assert.equal(f.host.status().submission?.state,'verified');assert.equal(f.host.status().submission!.intent.id,original.id);assert.deepEqual(f.tasks.get(f.taskId).applicationRevision,newer);assert.throws(()=>f.host.execution.assertReady(f.tasks.get(f.taskId)),/PRIOR_REVISION/);
 }finally{await f.close();}
});

test('real unknown autosave remains a browser recovery hold with no submission intent, even after pending is cleared',async()=>{
 const root=mkdtempSync(join(scratch,'bt-'));let posts=0;
 const server=createServer(async(req,res)=>{if(req.method==='POST'){for await(const _ of req){}posts++;req.socket.destroy();return;}res.setHeader('Content-Type','text/html');res.end('<form method="post" action="/applications"><label>Visitor<input name="visitor" required></label><button>Send</button></form><script>document.querySelector("input").addEventListener("input",e=>{fetch("/save",{method:"POST",body:new URLSearchParams({visitor:e.target.value})}).catch(()=>{});});</script>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true});let tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const ns={accountId:'a',workspaceId:'w'},task=tasks.admit({...ns,messageId:'autosave',outcome:'Approved invented action'},30);tasks.update(task.id,t=>{t.applicationRevision=revision;});const signal=new AbortController().signal;
 const config=():TaskBrowserOptions=>({tasks,store,namespace:ns,taskId:task.id,browser,sessionId:'autosave-session',destination:origin+'/',submissionUrl:origin+'/applications',readUrls:[],allowLoopback:true,authority:{id:'owner',signal,isCurrent:()=>true},readReceipt:async()=>undefined});
 let host=await createTaskBrowserTools(config());
 const review:TaskBrowserReview={revision,controls:[{name:'visitor',value:'Reviewed invented value'}],post:{url:origin+'/applications',encoding:'urlencoded',fields:[{name:'visitor',value:'Reviewed invented value'}],files:[]},receiptUrl:origin+'/receipt',effects:[{operation:'fill',name:'visitor',post:{url:origin+'/save',encoding:'urlencoded',fields:[{name:'visitor',value:'Reviewed invented value'}],files:[]}}]};
 try{
  host.approve(review,'owner-submit');await new AgentRuntime(tasks,host.tools).run(task.id,{id:'scripted-autosave-NOT-model',async next(t){if(!t.observations.length)return {kind:'tool',name:'browser.inspect',args:{}};if(t.observations.length===1){const view=t.observations[0]!.data as View;return {kind:'tool',name:'browser.fill',args:{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'}};}return {kind:'ready',result:'Must be blocked'};}},6,{...host.execution,scope:{sources:[],destinations:[origin+'/'],grants:[]}});
  assert.equal(posts,1);assert.equal(tasks.get(task.id).pending,undefined);assert.equal(host.status().submission,undefined);assert.equal(host.status().recovery,'reconciliation_required');assert.equal(tasks.get(task.id).status,'blocked');
  await host.close();tasks.close();store.close();tasks=new AgentStore(join(root,'tasks.sqlite'));store=new EvidenceStore(join(root,'evidence'));host=await createTaskBrowserTools(config());
  assert.equal(host.status().recovery,'reconciliation_required');const newer={...revision,revision:2};tasks.update(task.id,t=>{t.applicationRevision=newer;});assert.throws(()=>host.approve({...review,revision:newer},'cannot-clear-unknown'),/RECONCILIATION/);assert.throws(()=>host.execution.assertReady(tasks.get(task.id)),/RECONCILIATION/);assert.equal(posts,1);
 }finally{await host.close();await browser.close();await new Promise<void>(r=>server.close(()=>r()));tasks.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('actual verified receipt facts and evidence survive cancellation immediately after the atomic receipt commit',async()=>{
 const f=await fixture();try{
  const runtime=new AgentRuntime(f.tasks,f.host.tools),update=f.tasks.update.bind(f.tasks);let cancelled=false;
  f.tasks.update=(id,change)=>{const after=update(id,change);if(!cancelled&&after.browser?.submission?.state==='verified'){cancelled=true;runtime.cancel(id);}return after;};
  await runtime.run(f.taskId,f.provider(),20,{...f.host.execution,scope:f.scope});assert.equal(cancelled,true);
  assert.equal(f.tasks.get(f.taskId).status,'cancelled');const known=f.host.status().submission!;assert.equal(known.state,'verified');assert.ok(known.receipt?.contentHash);assert.ok(known.evidence);assert.equal(f.tasks.get(f.taskId).externalAction?.state,'verified');
  assert.ok(f.store.read(f.ns,known.evidence!.artifactId).toString().includes(known.receipt!.receiptId));
  await f.reopen();assert.deepEqual(f.host.status().submission!.receipt,known.receipt);assert.equal(f.host.status().submission!.state,'verified');assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);
 }finally{await f.close();}
});

test('revoked A/revoked B/full stores reopen/replay A never reactivates authority or POSTs',async()=>{
 const f=await fixture();try{
  const a=f.host.approve(f.review,'owner-A');await f.host.revoke(a.id);
  const b=f.host.approve(f.review,'owner-B');await f.host.revoke(b.id);await f.reopen();
  const artifactsBefore=Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  let replay:ReturnType<typeof f.host.approve>|undefined;try{replay=f.host.approve(f.review,'owner-A');}catch{}
  const artifactsAfterReplay=Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  await f.run(f.provider(false));
  const receipts=readdirSync(join(f.root,'portal')).filter(n=>n.endsWith('.json'));
  assert.equal(receipts.length,0,'Neither revoked owner action may authorize a POST or persisted receipt');
  assert.equal(Object.keys(f.host.status().writes).length,0);assert.equal(f.host.status().submission,undefined);assert.equal(f.tasks.get(f.taskId).status,'blocked');
  assert.equal(f.host.status().approval?.id,b.id);assert.equal(f.host.status().approval?.revoked,true);
  const history=f.host.status().approvalHistory!.requests;assert.deepEqual(history.map(a=>a.id),[a.id,b.id]);assert.ok(history.every(a=>a.revoked));assert.equal(history[0]!.superseded,true);
  if(replay){assert.equal(replay.id,a.id);assert.equal(replay.revoked,true);}
  assert.equal(artifactsAfterReplay,artifactsBefore,'Replay must not create another approval artifact');
 }finally{await f.close();}
});

test('superseded request retries retain original disposition without replacing the valid current instruction or growing artifacts',async()=>{
 const f=await fixture();try{
  const a=f.host.approve(f.review,'instruction-A'),count=()=>Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  const firstCount=count();for(let i=0;i<3;i++)assert.equal(f.host.approve(f.review,'instruction-A').id,a.id);assert.equal(count(),firstCount);
  const b=f.host.approve(f.review,'instruction-B'),before=count();
  const stale=f.host.approve(f.review,'instruction-A');assert.equal(stale.id,a.id);assert.equal(stale.revoked,true);assert.equal(stale.superseded,true);assert.equal(f.host.status().approval?.id,b.id);assert.equal(f.host.status().approval?.revoked,false);
  await f.host.revoke(a.id);assert.equal(f.host.status().approval?.revoked,false);assert.equal(f.host.approve(f.review,'instruction-B').id,b.id);assert.equal(count(),before);assert.equal(f.host.status().approvalHistory!.requests.length,2);
  await f.reopen();assert.equal(f.host.approve(f.review,'instruction-A').revoked,true);assert.equal(count(),before);
  await f.run(f.provider(false));assert.equal(f.tasks.get(f.taskId).status,'ready');assert.equal(f.host.status().submission?.approvalId,b.id);assert.equal(readdirSync(join(f.root,'portal')).filter(n=>n.endsWith('.json')).length,1);
 }finally{await f.close();}
});

test('a model can reconcile an unknown submission read-only in the same run: Ready refused until verified, never rePOSTed',async()=>{
 const f=await fixture(0,true);try{
  await f.run(f.provider());const task=f.tasks.get(f.taskId),codes=task.observations.map(o=>o.error?.code??(o.data as {state?:string}|null)?.state);
  assert.ok(codes.indexOf('READY_REJECTED')>codes.indexOf('uncertain'),'Ready was refused while the submission was unknown');
  assert.ok(codes.lastIndexOf('verified')>codes.indexOf('READY_REJECTED'),'only a read-only verification followed');
  assert.equal(task.status,'ready');assert.equal(f.host.status().submission?.state,'verified');assert.equal(f.host.status().recovery,'clean');
  assert.equal(task.decisions.filter(d=>d.kind==='tool'&&d.name==='browser.submit').length,1);assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1,'no second POST');
 }finally{await f.close();}
});

test('request IDs cannot rebind review, revision, authority, session or destination and conflicts create no artifacts',async()=>{
 const f=await fixture();try{
  const a=f.host.approve(f.review,'fixed-request'),before=f.host.status(),count=()=>Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n),artifacts=count();
  assert.throws(()=>f.host.approve({...f.review,receiptUrl:f.portal.origin+'/other-receipt'},'fixed-request'),/REQUEST_ID_CONFLICT/);
  assert.throws(()=>f.host.approve({...f.review,controls:[...f.review.controls,{name:'another',value:'different'}]},'fixed-request'),/REQUEST_ID_CONFLICT/);
  for(const patch of [{sessionId:'changed-session'},{authority:{...f.makeOptions().authority,id:'changed-authority'}},{destination:f.portal.origin+'/other-form'},{submissionUrl:f.portal.origin+'/other-post'}]){
   const other=await createTaskBrowserTools({...f.makeOptions(),...patch});try{const review=patch.submissionUrl?{...f.review,post:{...f.review.post,url:patch.submissionUrl}}:f.review;assert.throws(()=>other.approve(review,'fixed-request'),/REQUEST_ID_CONFLICT/);}finally{await other.close();}
  }
  const newer={...revision,revision:2};f.tasks.update(f.taskId,t=>{t.applicationRevision=newer;});assert.throws(()=>f.host.approve({...f.review,revision:newer},'fixed-request'),/REQUEST_ID_CONFLICT/);
  assert.deepEqual(f.host.status(),before);assert.equal(count(),artifacts);assert.equal(f.host.status().approval?.id,a.id);assert.equal(readdirSync(join(f.root,'portal')).length,0);
  const next=f.host.approve({...f.review,revision:newer},'new-reviewed-request');const history=f.host.status().approvalHistory!.requests;
  assert.deepEqual(history.map(a=>a.id),[a.id,next.id]);assert.deepEqual(history[0]!.revision,revision);assert.deepEqual(history[1]!.revision,newer);assert.equal(history[0]!.superseded,true);
  const afterNew=count();assert.throws(()=>f.host.approve({...f.review,revision:newer},'fixed-request'),/REQUEST_ID_CONFLICT/);assert.equal(count(),afterNew);assert.equal(f.host.status().approval?.id,next.id);
 }finally{await f.close();}
});

test('prototype-like request IDs retain tombstones safely across full reopen and never revive revoked instructions',async()=>{
 const f=await fixture();try{
  const ids=['__proto__','constructor','hasOwnProperty','toString'],approvals=ids.map(id=>f.host.approve(f.review,id));
  await f.host.revoke(approvals.at(-1)!.id);await f.reopen();const count=Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  for(let i=0;i<ids.length;i++){const replay=f.host.approve(f.review,ids[i]!);assert.equal(replay.id,approvals[i]!.id);assert.equal(replay.revoked,true);}
  assert.throws(()=>f.host.approve(f.review,{toString:()=> '__proto__'} as unknown as string),/REVIEW_NOT_CURRENT/);
  assert.equal(f.host.status().approvalHistory!.requests.length,ids.length);assert.equal(f.host.status().approval!.id,approvals.at(-1)!.id);assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n),count);
  await f.run(f.provider(false));assert.equal(readdirSync(join(f.root,'portal')).filter(n=>n.endsWith('.json')).length,0);assert.equal(Object.getPrototypeOf(f.host.status()),Object.prototype);
 }finally{await f.close();}
});

test('legacy forgotten history blocks even an apparently active approval, while pristine legacy state can accept its first request',async()=>{
 const f=await fixture();try{
  const a=f.host.approve(f.review,'legacy-A');await f.host.revoke(a.id);const b=f.host.approve(f.review,'legacy-B');await f.host.revoke(b.id);const c=f.host.approve(f.review,'legacy-C');
  f.tasks.update(f.taskId,t=>{delete t.browser!.approvalHistory;delete t.browser!.approval!.superseded;});await f.reopen();
  const legacy=f.host.status(),count=Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  for(const id of ['legacy-A','legacy-B','legacy-C','fresh-but-unprovable'])assert.throws(()=>f.host.approve(f.review,id),/REQUEST_HISTORY_UNAVAILABLE/);
  assert.deepEqual(f.host.status(),legacy);assert.equal(f.host.status().approval!.id,c.id);assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n),count);
  await f.run(f.provider(false));assert.equal(readdirSync(join(f.root,'portal')).filter(n=>n.endsWith('.json')).length,0);
  const fresh=f.tasks.admit({...f.ns,messageId:'pristine-legacy',outcome:'First invented instruction'},20);f.tasks.update(fresh.id,t=>{t.applicationRevision=revision;t.browser={writes:{},recovery:'clean'};});
  const first=await createTaskBrowserTools({...f.makeOptions(),taskId:fresh.id});try{const approved=first.approve(f.review,'genuinely-first');assert.equal(first.status().approvalHistory!.requests.length,1);assert.equal(first.approve(f.review,'genuinely-first').id,approved.id);}finally{await first.close();}
 }finally{await f.close();}
});

test('legacy history loss cannot clear unknown claims and does not prevent honest existing receipt reconciliation',async()=>{
 const f=await fixture(0,true);try{
  await f.run(f.provider(true,true));assert.equal(f.host.status().submission?.state,'uncertain');const intent=f.host.status().submission!.intent;
  f.tasks.update(f.taskId,t=>{delete t.browser!.approvalHistory;});await f.reopen();
  assert.throws(()=>f.host.approve(f.review,'one-owner-submit-instruction'),/RECONCILIATION/);assert.throws(()=>f.host.approve(f.review,'unseen-retry'),/RECONCILIATION/);assert.equal(f.host.status().submission!.intent.id,intent.id);
  f.resume();await f.run({id:'scripted-legacy-receipt-NOT-model',async next(t){return data(t)?.state==='verified'?{kind:'ready',result:'Observed existing receipt only'}:{kind:'tool',name:'browser.verify_submission',args:{}};}},3);
  assert.equal(f.host.status().submission!.state,'verified');assert.equal(f.host.status().submission!.intent.id,intent.id);assert.equal(readdirSync(join(f.root,'portal')).filter(n=>n.endsWith('.json')).length,1);assert.equal(f.host.status().approvalHistory,undefined);
 }finally{await f.close();}
});

test('direct tool invocation without normal runtime pending cannot mint dispatch authority',async()=>{
 const f=await fixture();try{
  f.host.approve(f.review,'owner-submit');const t=f.tasks.get(f.taskId);
  const ctx:ToolContext={...f.ns,taskId:t.id,runId:t.run.id,callId:'not-runtime-reserved',budget:t.budget,scope:f.scope,applicationRevision:revision,signal:new AbortController().signal,isCurrent:()=>true};
  const inspected=await f.host.tools.find(t=>t.name==='browser.inspect')!.invoke({},ctx),view=inspected.data as View;const field=view.fields.find(f=>f.type==='text')!;
  const result=await f.host.tools.find(t=>t.name==='browser.fill')!.invoke({snapshotRef:view.snapshotRef,fieldRef:field.ref,value:'Reviewed invented guest'},ctx);
  assert.equal(result.status,'needs_input');assert.equal(result.effect,'none');assert.equal(Object.keys(f.host.status().writes).length,0);assert.equal(readdirSync(join(f.root,'portal')).length,0);
 }finally{await f.close();}
});
