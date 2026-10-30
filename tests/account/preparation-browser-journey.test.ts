import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer,type IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import type {ModelDeclaration} from '../../core/models/provider.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {PreparationConfig} from '../../core/preparation/service.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import {startFictionalPortal} from '../../core/preparation/fictional-portal.js';
import {fictionalPortalContinuation} from '../../core/preparation/portal-production.js';
import {inventedPdf,inventedPng} from '../portal/fixtures.js';

// PILOT, FIXTURE PROOF ONLY. Real account server/API, real NebiusAgentProvider adapter against a
// SCRIPTED loopback model (not an LLM, no external model call), real existing Chromium posting to the
// owned loopback fictional portal. The completed preparation is SIMULATED in the task store. Invented data.
const chromium=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const available=existsSync(chromium);
const scratch=process.env.TMPDIR??'/home/ubuntu/.local/state/rucksack/scratch/pa';
const report:Record<string,unknown>={};
after(()=>{if(process.env.SPINDLE_PILOT_REPORT)writeFileSync(process.env.SPINDLE_PILOT_REPORT,JSON.stringify(report,null,1));});
const model:ModelDeclaration={provider:'nebius',id:'invented-scripted-loopback-model',text:true,jsonObject:true,inputContextTokens:131072,maxOutputTokens:1024,pricing:{inputUsdPerMillion:0.01,outputUsdPerMillion:0.01,verifiedAt:'2026-10-29T00:00:00Z',source:'https://example.test/invented-pricing'}};
interface View {snapshotRef:string;fields:{ref:string;name:string;type:string}[];actions:{ref:string}[]}

/** Scripted OpenAI-compatible loopback model: reads the adapter's actual request and plays the approved plan. */
async function scriptedModel(){
 const bodies:number[]=[];let hold=false,held=0,aborted=0;
 const decide=(body:{messages:{content:string}[]})=>{
  const user=JSON.parse(body.messages[1]!.content) as {untrustedTask:{decisions:{kind:string;name?:string;calls?:{args:{fieldRef?:string}}[]}[];observations:{data:unknown}[]};approvedReview?:{controls:{name:string;value:unknown}[];files:{field:string;artifactId:string}[]};registeredTools:{name:string}[]};
  const t=user.untrustedTask,review=user.approvedReview!,tools=user.registeredTools.map(x=>x.name);
  const last=(t.observations.at(-1)?.data as {state?:string}|undefined)?.state;
  if(!tools.includes('browser.submit'))return last==='verified'?{kind:'ready',result:'Receipt verified read-only'}:{kind:'tool',name:'browser.verify_submission',args:{}};
  let view:View|undefined;for(const o of t.observations){const v=o.data as View|undefined;if(v?.snapshotRef&&v.fields)view=v;}
  if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
  const done=new Set(t.decisions.flatMap(d=>d.kind==='batch'?d.calls!.map(c=>c.args.fieldRef):[]));
  const open=view.fields.filter(x=>!done.has(x.ref)).slice(0,4);
  if(open.length)return {kind:'batch',calls:open.map(x=>x.type==='file'?{callId:randomUUID(),name:'browser.upload',args:{snapshotRef:view!.snapshotRef,fieldRef:x.ref,artifactId:review.files.find(f=>f.field===x.name)!.artifactId}}:{callId:randomUUID(),name:'browser.fill',args:{snapshotRef:view!.snapshotRef,fieldRef:x.ref,value:review.controls.find(c=>c.name===x.name)!.value}})};
  if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};
  return last==='verified'?{kind:'ready',result:'Observed persisted receipt and revisit'}:{kind:'tool',name:'browser.verify_submission',args:{}};
 };
 const server=createServer(async(req:IncomingMessage,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);const raw=Buffer.concat(chunks);bodies.push(raw.length);
  if(hold){held++;res.on('close',()=>{if(!res.writableEnded)aborted++;});return;}
  const next_action=decide(JSON.parse(raw.toString()));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({next_action})}}],usage:{prompt_tokens:Math.ceil(raw.length/4),completion_tokens:40}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
 return {url,bodies,set hold(v:boolean){hold=v;},get held(){return held;},get aborted(){return aborted;},close:()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));}};
}

async function journey(){
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'pj-')),key=randomBytes(32);
 const tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const portal=await startFictionalPortal(join(root,'portal')),llm=await scriptedModel();
 const journal=join(root,'invented-budget.json');writeFileSync(journal,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const continuation=fictionalPortalContinuation({origin:portal.origin,chromiumExecutable:chromium,budget:new FileCallBudget(journal),decisionModel:model,credential:async()=>'INVENTED_LOOPBACK_KEY',modelTransport:(_input,init)=>fetch(llm.url,init),timeoutMs:60000,browserTimeoutMs:10000,providerTimeoutMs:30000});
 const google={clientId:'invented-client',clientSecret:'INVENTED_SECRET',http:async(input:Parameters<typeof fetch>[0])=>{
  const u=new URL(String(input));
  if(u.pathname==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(u.pathname==='/drive/v3/files')return Response.json({files:[]});
  throw Error('Unexpected invented Google path');
 }};
 // The preparation phase itself is not under test: its fixture provider stops at once.
 const config:PreparationConfig={tasks,store,workspaceId:'account-private',buildIdentity:'invented-journey-build',provider:()=>({id:'offline-fixture',next:async()=>{throw Error('INVENTED_PREPARATION_FIXTURE');}}),tools:()=>[],browserContinuation:continuation};
 const server=await startTrackingServer(join(root,'account'),key,0,undefined,google,config);
 const close=async()=>{await server.close();await portal.close();await llm.close();tasks.close();store.close();key.fill(0);rmSync(root,{recursive:true,force:true});};
 try{
 const client=new AccountClient(server.origin);await client.signin('invented-owner','invented-password-123',true);
 const flow=await client.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);
 callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);
 await client.selectGoogleRoots(flow.connectionId,['root']);
 const admitted=await client.prepareApplication({connectionId:flow.connectionId,rootId:'root',request:'Apply to the invented workshop',requestId:'invented-intent',processingConsent:true,saveOutputs:false});
 for(let n=0;n<400&&(await client.preparationTask(admitted.taskId)).execution?.state!=='idle';n++)await new Promise(r=>setTimeout(r,10));
 const taskId=admitted.taskId,ns={workspaceId:'account-private',accountId:client.account!.id};
 // SIMULATED completed preparation (revision 2 after one owner correction): grounded fields, a stale
 // revision-1 PDF, and current PDF + PNG outputs derived from the request source.
 const t0=tasks.get(taskId),sourceArtifact=t0.preparation!.sources[0]!.snapshotArtifactId;
 const put=(bytes:Buffer,mime:string)=>store.put(ns,bytes,mime,[sourceArtifact]).artifact;
 const stale=put(Buffer.from(inventedPdf().replace('%PDF-1.4','%PDF-1.4\n% revision 1')),'application/pdf'),pdf=put(Buffer.from(inventedPdf()),'application/pdf'),png=put(inventedPng(),'image/png');
 tasks.update(taskId,t=>{
  const p=t.preparation!,cite=[{artifactId:sourceArtifact,sourceId:p.sources[0]!.id,sourceVersion:p.sources[0]!.sha256}];
  p.fields=[{id:'applicant_name',label:'Applicant name',value:'Mira Example',unresolved:false,citations:cite},{id:'contact_email',label:'Contact email',value:'mira.old@example.test',unresolved:false,citations:cite},{id:'programme',label:'Programme',value:'Invented Weaving Workshop',unresolved:false,citations:cite}];
  p.artifactIds.push(stale.id);(p.artifactRevisions??={})[stale.id]=1;(p.artifactBindings??={})[stale.id]=preparationArtifactBinding(p,stale.sha256,['applicant_name','contact_email']);
  p.revision=2;p.fields[1]!.value='mira@example.test';p.fields[1]!.corrected=true;p.revisions.push({revision:2,fieldId:'contact_email',value:'mira@example.test'});
  for(const [a,fields] of [[pdf,['applicant_name','contact_email']],[png,[]]] as const){p.artifactIds.push(a.id);p.artifactRevisions![a.id]=2;p.artifactBindings![a.id]=preparationArtifactBinding(p,a.sha256,fields);}
  t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-revision-2'};
  t.status='ready';delete t.blocker;t.currentResult='Prepared for owner review';t.nextAction='Review and approve';
 });
 const prepared=structuredClone(tasks.get(taskId).preparation!);
 const receipts=()=>readdirSync(join(root,'portal')).filter(x=>x.endsWith('.json'));
 const settle=async()=>{for(let n=0;n<600;n++){const s=await client.preparationTask(taskId) as any;if(s.execution?.state!=='running'&&s.portal?.state!=='running')return s;await new Promise(r=>setTimeout(r,100));}throw Error('Browser run did not settle');};
 return {root,server,client,tasks,store,taskId,ns,portal,llm,continuation,journal,pdf,stale,png,prepared,receipts,settle,flow,
  contexts:async()=>(await continuation.browser()).contexts().length,
  close};
 }catch(error){await close();throw error;}
}

test('pilot happy path: API review -> explicit approval -> production adapter (scripted loopback model) -> real Chromium POST -> verified receipt; replay and read-only reconcile add nothing',{skip:!available},async()=>{
 const j=await journey();try{
  const config=await j.client.request('/preparation/config',{}) as any;assert.deepEqual(config.browserApproval,{available:true,mode:'developer_fictional',destination:j.portal.origin+'/'});
  // Read-only review: server-owned mapping; page-supplied mapping refused; nothing launched or approved.
  await assert.rejects(j.client.request('/preparation/browser-review',{taskId:j.taskId,expectedRevision:2,fields:[{fieldId:'programme',name:'applicant_name'}],files:[]}),/MAPPING_SERVER_OWNED/);
  const review=await j.client.request('/preparation/browser-review',{taskId:j.taskId,expectedRevision:2}) as any;
  assert.equal(review.destination,j.portal.origin+'/');assert.equal(review.revision,2);assert.match(review.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(review.fields.map((f:any)=>[f.name,f.value,!!f.corrected,f.citations.length]),[['applicant_name','Mira Example',false,1],['contact_email','mira@example.test',true,1],['programme','Invented Weaving Workshop',false,1]]);
  assert.deepEqual(review.files.map((f:any)=>[f.field,f.artifactId,f.sha256]),[['statement',j.pdf.id,j.pdf.sha256],['photo',j.png.id,j.png.sha256]],'current PDF/PNG, never the stale revision-1 PDF');
  assert.deepEqual(review.required,{controls:['applicant_name','contact_email','programme','idempotencyKey'],files:['statement','photo']});
  assert.equal(j.tasks.get(j.taskId).browser,undefined);assert.equal(j.llm.bodies.length,0);
  const approval={taskId:j.taskId,expectedRevision:2,fingerprint:review.fingerprint,requestId:'owner-approval-1'};
  report.approvalRequestBytes=Buffer.byteLength(JSON.stringify(approval));report.reviewResponseBytes=Buffer.byteLength(JSON.stringify(review));
  const admitted=await j.client.request('/preparation/browser-approve',approval) as any;assert.deepEqual(admitted.browser,{action:'approve',state:'running'});
  const s=await j.settle(),t=j.tasks.get(j.taskId);
  assert.equal(s.portal.state,'verified',JSON.stringify({portal:s.portal,blocker:t.blocker,obs:t.observations.map(o=>[o.status,o.error?.code])}));
  assert.equal(s.state,'ready');assert.equal(s.browser.submission.state,'verified');assert.equal(s.browser.submission.receipt.destination,j.portal.origin+'/');
  assert.equal(j.receipts().length,1);
  const persisted=JSON.parse(readFileSync(join(j.root,'portal',j.receipts()[0]!),'utf8'));
  assert.deepEqual(persisted.fields,{applicant_name:'Mira Example',contact_email:'mira@example.test',programme:'Invented Weaving Workshop'});
  assert.deepEqual(persisted.files.map((f:any)=>[f.name,f.sha256]),[['statement',j.pdf.sha256],['photo',j.png.sha256]]);
  assert.equal(s.browser.submission.receipt.receiptId,persisted.reference);
  // Same task, prepared answers/citations/corrections/artifacts preserved; budgets consumed, never reset.
  assert.equal(t.id,j.taskId);assert.equal(j.tasks.tasks(j.ns).length,1);assert.deepEqual(t.preparation!.fields,j.prepared.fields);assert.deepEqual(t.preparation!.revisions,j.prepared.revisions);assert.deepEqual(t.preparation!.artifactIds,j.prepared.artifactIds);
  const calls=j.llm.bodies.length;assert.ok(calls>=6&&calls<=9,'inspect, two write batches, one submit, verify, ready: '+calls);
  assert.equal(t.preparation!.modelBudget.decisionCalls,j.prepared.modelBudget.decisionCalls+calls);assert.equal(new FileCallBudget(j.journal).snapshot().calls,calls);
  assert.ok(t.decisions.filter(d=>d.kind==='tool'&&d.name==='browser.submit').length===1);
  report.modelRequestBytes=[...j.llm.bodies];report.modelRequestMaxBytes=Math.max(...j.llm.bodies);report.adapterLimitBytes=65536;
  assert.ok(Math.max(...j.llm.bodies)<65536);
  assert.equal(await j.contexts(),0,'each run owns and closes its own context');
  // Same owner request replays the retained fact; read-only reconcile of a verified task also adds nothing.
  await j.client.request('/preparation/browser-approve',approval);const replay=await j.settle();
  assert.equal(replay.portal.state,'verified');await j.client.request('/preparation/browser-reconcile',{taskId:j.taskId});const checked=await j.settle();
  assert.equal(checked.portal.state,'verified');assert.equal(j.llm.bodies.length,calls);assert.equal(j.receipts().length,1);
  await assert.rejects(j.client.request('/preparation/browser-approve',{...approval,requestId:'owner-approval-2'}).then(()=>j.settle()).then(v=>{if(v.portal.state==='refused')throw Error(v.portal.code);return v;}),/PREPARATION_PORTAL_REVIEW_CHANGED|PREPARATION_PORTAL_SUBMISSION_EXISTS/);
  assert.equal(j.receipts().length,1);
 }finally{await j.close();}
});

test('pilot refusals before any effect: foreign owner and a changed review start no browser, model call or POST',{skip:!available},async()=>{
 const j=await journey();try{
  const review=await j.client.request('/preparation/browser-review',{taskId:j.taskId,expectedRevision:2}) as any;
  const other=new AccountClient(j.server.origin);await other.signin('invented-other','invented-password-456',true);
  await assert.rejects(other.request('/preparation/browser-approve',{taskId:j.taskId,expectedRevision:2,fingerprint:review.fingerprint,requestId:'foreign-1'}),/PREPARATION_NOT_FOUND/);
  await assert.rejects(other.request('/preparation/browser-reconcile',{taskId:j.taskId}),/PREPARATION_NOT_FOUND/);
  // A change after display (simulated concurrent edit) invalidates the displayed fingerprint.
  j.tasks.update(j.taskId,t=>{t.preparation!.fields[2]!.value='Changed Workshop';});
  await assert.rejects(j.client.request('/preparation/browser-approve',{taskId:j.taskId,expectedRevision:2,fingerprint:review.fingerprint,requestId:'stale-1'}),/PREPARATION_PORTAL_REVIEW_CHANGED/);
  await assert.rejects(j.client.request('/preparation/browser-approve',{taskId:j.taskId,expectedRevision:1,fingerprint:review.fingerprint,requestId:'stale-2'}),/PREPARATION_BROWSER_STALE_REVISION/);
  assert.equal(j.tasks.get(j.taskId).browser,undefined);assert.equal(j.llm.bodies.length,0);assert.equal(j.receipts().length,0);assert.equal(j.tasks.get(j.taskId).status,'ready');
 }finally{await j.close();}
});

test('pilot owner cancel while the production adapter awaits the loopback model: next() settles on abort, the model request is aborted, no POST (LOW-1)',{skip:!available},async()=>{
 const j=await journey();try{
  const review=await j.client.request('/preparation/browser-review',{taskId:j.taskId,expectedRevision:2}) as any;
  j.llm.hold=true;
  await j.client.request('/preparation/browser-approve',{taskId:j.taskId,expectedRevision:2,fingerprint:review.fingerprint,requestId:'owner-approval-1'});
  for(let n=0;n<300&&!j.llm.held;n++)await new Promise(r=>setTimeout(r,20));assert.equal(j.llm.held,1,'first model request is pending at the loopback model');
  const started=Date.now();await j.client.cancelPreparation(j.taskId);const s=await j.settle();
  report.cancelSettledMs=Date.now()-started;
  assert.equal(s.state,'cancelled');assert.equal(s.portal.state,'cancelled');assert.ok(Date.now()-started<5000,'continuation settled without waiting for the model response');
  for(let n=0;n<100&&!j.llm.aborted;n++)await new Promise(r=>setTimeout(r,20));assert.equal(j.llm.aborted,1,'the adapter aborted its actual HTTP request');
  assert.equal(j.receipts().length,0);assert.equal(await j.contexts(),0);
  await assert.rejects(j.client.request('/preparation/browser-reconcile',{taskId:j.taskId}).then(()=>j.settle()).then(v=>{if(v.portal.state==='refused')throw Error(v.portal.code);}),/PREPARATION_PORTAL_NO_SUBMISSION|PREPARATION_PORTAL/);
 }finally{await j.close();}
});

test('pilot signout retires the run authority synchronously: held as interrupted, no POST, no later model dispatch',{skip:!available},async()=>{
 const j=await journey();try{
  const review=await j.client.request('/preparation/browser-review',{taskId:j.taskId,expectedRevision:2}) as any;
  j.llm.hold=true;
  await j.client.request('/preparation/browser-approve',{taskId:j.taskId,expectedRevision:2,fingerprint:review.fingerprint,requestId:'owner-approval-1'});
  for(let n=0;n<300&&!j.llm.held;n++)await new Promise(r=>setTimeout(r,20));assert.equal(j.llm.held,1);
  await j.client.signout();
  let t=j.tasks.get(j.taskId);for(let n=0;n<300&&t.status==='working';n++){await new Promise(r=>setTimeout(r,20));t=j.tasks.get(j.taskId);}
  assert.equal(t.status,'blocked');assert.equal(t.blocker,'PORTAL_CONTINUATION_INTERRUPTED');assert.equal(t.recovery,'clean');assert.equal(t.pending,undefined);
  for(let n=0;n<100&&!j.llm.aborted;n++)await new Promise(r=>setTimeout(r,20));assert.equal(j.llm.aborted,1);assert.equal(j.llm.bodies.length,1);
  assert.equal(j.receipts().length,0);
 }finally{await j.close();}
});
