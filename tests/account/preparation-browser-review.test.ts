import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import type {PreparationPortal} from '../../core/preparation/browser-review.js';
import {inventedPdf,inventedPng} from '../portal/fixtures.js';

// Ordinary authenticated HTTP/client/stores; invented prepared fixtures, no model or browser.
async function fixture(configured=true){
 const root=process.env.RUCKSACK_SCRATCH_ROOT??join(homedir(),'.local/state/rucksack/scratch/spindle-account-tests');mkdirSync(root,{recursive:true});
 const directory=mkdtempSync(join(root,'browser-review-')),key=Buffer.alloc(32,74),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
 const portal:PreparationPortal={destination:'http://127.0.0.1:43199/',submissionUrl:'http://127.0.0.1:43199/applications',receiptUrl:'http://127.0.0.1:43199/receipts/invented',encoding:'multipart',constants:[{name:'submissionId',value:'invented-reviewed-id'}]};
 let calls=0,headers=new Headers();
 const server=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http:async()=>{calls++;throw Error('Unexpected Google call');}},{tasks,store,workspaceId:'invented-workspace',buildIdentity:'invented-review-api',processingPaused:true,browserPortal:configured?portal:undefined,provider:()=>{calls++;throw Error('Unexpected model');},tools:()=>{calls++;throw Error('Unexpected execution');}});
 const client=new AccountClient(server.origin,async(input,init)=>{if(String(input).endsWith('/preparation/browser-review'))headers=new Headers(init?.headers);return fetch(input,init);});
 try{
  await client.signin('invented-review-owner','invented-password-123',true);
  const ns={workspaceId:'invented-workspace',accountId:client.account!.id},source=store.put(ns,Buffer.from('Invented application facts'),'text/plain',[],{provider:'user',providerId:'invented-source',providerVersion:'1'}),pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[source.artifact.id]),photo=store.put(ns,inventedPng(),'image/png',[source.artifact.id]);
  const task=tasks.admit({...ns,messageId:'invented-prepared',outcome:'Prepare invented document and photo'},128);
  tasks.update(task.id,t=>{t.status='blocked';t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-corrected-revision'};t.preparation={connectionId:'invented-connection',rootId:'invented-root',incarnation:'invented-incarnation',rootRevision:1,googleAccountId:'invented@example.test',requestId:'invented-request',request:'Invented application',revision:2,processingConsent:true,saveOutputs:false,sources:[source.source!],artifactIds:[source.artifact.id,pdf.artifact.id,photo.artifact.id],artifactRevisions:{[pdf.artifact.id]:2,[photo.artifact.id]:2},fields:[{id:'name',label:'Name',value:'Mira Corrected',corrected:true,unresolved:false,citations:[]},{id:'email',label:'Email',value:'mira@example.test',unresolved:false,citations:[]}],revisions:[{revision:2,fieldId:'name',value:'Mira Corrected'}],uploads:[],modelBudget:{limitUsd:.3,maximumDecisionCalls:16,maximumVisionCalls:3,decisionCalls:0,visionCalls:0,reservedUsd:0}};t.preparation.artifactBindings={[pdf.artifact.id]:preparationArtifactBinding(t.preparation,pdf.artifact.sha256,['name']),[photo.artifact.id]:preparationArtifactBinding(t.preparation,photo.artifact.sha256,['name'])};});
  const selection={expectedRevision:2,fields:[{fieldId:'name',name:'participant'},{fieldId:'email',name:'contact'}],files:[{artifactId:pdf.artifact.id,field:'statement',filename:'invented.pdf'},{artifactId:photo.artifact.id,field:'photo',filename:'invented.png'}]};
  return {client,server,tasks,store,taskId:task.id,selection,portal,pdf,photo,headers:()=>new Headers(headers),calls:()=>calls,async close(){await server.close();tasks.close();store.close();key.fill(0);rmSync(directory,{recursive:true,force:true});}};
 }catch(error){await server.close();tasks.close();store.close();rmSync(directory,{recursive:true,force:true});throw error;}
}

test('normal account API displays corrected current fields, document/photo and trusted destination without execution, even paused',async()=>{
 const f=await fixture();try{
  const before=JSON.stringify(f.tasks.get(f.taskId)),view=await f.client.reviewPreparationBrowser(f.taskId,f.selection);
  assert.equal(view.fields[0]!.value,'Mira Corrected');assert.equal(view.destination,f.portal.destination);assert.equal(view.review.post.url,f.portal.submissionUrl);assert.deepEqual(view.review.controls.at(-1),f.portal.constants![0]);assert.deepEqual(view.files.map(a=>[a.sha256,a.mimeType,a.bytes]),[[f.pdf.artifact.sha256,'application/pdf',f.pdf.artifact.bytes],[f.photo.artifact.sha256,'image/png',f.photo.artifact.bytes]]);
  assert.match(view.fingerprint,/^[a-f0-9]{64}$/);assert.equal('assertCurrent' in view,false);assert.equal((await f.client.reviewPreparationBrowser(f.taskId,f.selection)).fingerprint,view.fingerprint);
  assert.equal(JSON.stringify(f.tasks.get(f.taskId)),before);assert.equal(f.tasks.get(f.taskId).browser,undefined);assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('review is owner/session/CSRF/origin bound; client cannot choose the destination',async()=>{
 const f=await fixture();try{
  await f.client.reviewPreparationBrowser(f.taskId,f.selection);const headers=f.headers(),body=JSON.stringify({taskId:f.taskId,...f.selection}),url=f.server.origin+'/preparation/browser-review';
  const foreign=new AccountClient(f.server.origin);await foreign.signin('invented-foreign','invented-password-123',true);await assert.rejects(foreign.reviewPreparationBrowser(f.taskId,f.selection),/PREPARATION_NOT_FOUND/);
  const badCsrf=new Headers(headers);badCsrf.set('X-CSRF-Token','invalid');assert.equal((await fetch(url,{method:'POST',headers:badCsrf,body})).status,403);
  const badOrigin=new Headers(headers);badOrigin.set('Origin','https://foreign.example.test');assert.equal((await fetch(url,{method:'POST',headers:badOrigin,body})).status,403);
  await assert.rejects(f.client.request('/preparation/browser-review',{taskId:f.taskId,...f.selection,portal:{destination:'https://foreign.example.test'}}),/INVALID_PREPARATION_FIELDS/);
  await f.client.signout();assert.equal((await fetch(url,{method:'POST',headers,body})).status,401);assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('stale, malformed, unresolved and foreign-file selections fail closed without approving or calling providers',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,{...f.selection,expectedRevision:1}),/STALE_REVISION/);
  for(const fields of [null,[null],[{fieldId:'name',name:42}],[{fieldId:'name',name:'participant',extra:'denied'}]])await assert.rejects(f.client.request('/preparation/browser-review',{taskId:f.taskId,...f.selection,fields}),/INVALID_SELECTION/);
  await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,{...f.selection,files:[{...f.selection.files[0]!,artifactId:'foreign'}]}),/FILE_NOT_CURRENT/);
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[0]!.unresolved=true;});await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,f.selection),/FIELD_UNAVAILABLE/);
  assert.equal(f.tasks.get(f.taskId).browser,undefined);assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('each request recomputes current bindings; running/cancelled work is not reviewable',async()=>{
 const f=await fixture();try{
  const first=await f.client.reviewPreparationBrowser(f.taskId,f.selection);f.tasks.update(f.taskId,t=>{t.preparation!.rootRevision++;});const next=await f.client.reviewPreparationBrowser(f.taskId,f.selection);assert.notEqual(first.fingerprint,next.fingerprint);
  f.tasks.update(f.taskId,t=>{t.status='working';});await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,f.selection),/NOT_SETTLED/);
  f.tasks.update(f.taskId,t=>{t.status='cancelled';});await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,f.selection),/NOT_SETTLED/);assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('trusted portal configuration is required; endpoint absence never starts a fallback',async()=>{
 const f=await fixture(false);try{await assert.rejects(f.client.reviewPreparationBrowser(f.taskId,f.selection),/BROWSER_NOT_CONFIGURED/);assert.equal(f.calls(),0);assert.equal(f.tasks.get(f.taskId).browser,undefined);}finally{await f.close();}
});
