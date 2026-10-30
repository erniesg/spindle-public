import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationBrowserReview} from '../../core/preparation/browser-review.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import {inventedPdf} from '../portal/fixtures.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'prep-browser-review-')),ns={workspaceId:'invented-workspace',accountId:'invented-owner'};
 const tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const source=store.put(ns,Buffer.from('Invented source: Mira Example'),'text/plain',[],{provider:'user',providerId:'invented-source',providerVersion:'1'}),pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[source.artifact.id]);
 const task=tasks.admit({...ns,messageId:'invented-preparation',outcome:'Prepare the invented application'},128);
 tasks.update(task.id,t=>{
  t.status='blocked';t.blocker='Retained partial work';t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-revision-2'};
  t.preparation={connectionId:'invented-connection',rootId:'invented-root',incarnation:'invented-epoch',rootRevision:1,googleAccountId:'invented@example.test',requestId:'invented-request',request:'Invented application',revision:2,processingConsent:true,saveOutputs:false,sources:[source.source!],artifactIds:[source.artifact.id,pdf.artifact.id],artifactRevisions:{[source.artifact.id]:1,[pdf.artifact.id]:2},fields:[{id:'name',label:'Name',value:'Mira Corrected',unresolved:false,corrected:true,citations:[]},{id:'email',label:'Email',value:'mira@example.test',unresolved:false,citations:[]}],revisions:[{revision:2,fieldId:'name',value:'Mira Corrected'}],uploads:[],modelBudget:{limitUsd:.3,maximumDecisionCalls:16,maximumVisionCalls:3,decisionCalls:0,visionCalls:0,reservedUsd:0}};
  t.preparation.artifactBindings={[pdf.artifact.id]:preparationArtifactBinding(t.preparation,pdf.artifact.sha256,['name'])};
 });
 const selection={expectedRevision:2,fields:[{fieldId:'name',name:'participant_a'},{fieldId:'email',name:'contact_a'}],files:[{artifactId:pdf.artifact.id,field:'statement_a',filename:'invented-prepared.pdf'}]};
 const portal={destination:'http://127.0.0.1:43199/',submissionUrl:'http://127.0.0.1:43199/applications',receiptUrl:'http://127.0.0.1:43199/receipts/invented',encoding:'multipart' as const,constants:[{name:'idempotencyKey',value:'invented-reviewed-submission'}]};
 return {root,ns,tasks,store,taskId:task.id,pdf,selection,portal,read:()=>preparationBrowserReview(tasks,store,ns,task.id,selection,portal),close(){tasks.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('existing corrected partial prep maps exact values/files to portal review without creating tasks, approval or effects',()=>{
 const f=fixture();try{
  const before=JSON.stringify(f.tasks.get(f.taskId)),snapshot=f.read();
  assert.equal(snapshot.review.revision.revision,2);assert.equal(snapshot.review.controls[0]!.value,'Mira Corrected');assert.equal(snapshot.files[0]!.sha256,f.pdf.artifact.sha256);assert.equal(snapshot.files[0]!.bytes,f.pdf.artifact.bytes);assert.equal(snapshot.destination,f.portal.destination);assert.equal(snapshot.review.post.url,f.portal.submissionUrl);assert.equal(snapshot.review.post.files[0]!.artifactId,f.pdf.artifact.id);
  snapshot.assertCurrent();assert.equal(JSON.stringify(f.tasks.get(f.taskId)),before);assert.equal(f.tasks.get(f.taskId).browser,undefined);
 }finally{f.close();}
});

test('wrong owner, stale revision, missing/unresolved fields and foreign files fail closed',()=>{
 const f=fixture();try{
  assert.throws(()=>preparationBrowserReview(f.tasks,f.store,{...f.ns,accountId:'foreign'},f.taskId,f.selection,f.portal),/TASK_NOT_FOUND/);
  assert.throws(()=>preparationBrowserReview(f.tasks,f.store,f.ns,f.taskId,{...f.selection,expectedRevision:1},f.portal),/STALE_REVISION/);
  assert.throws(()=>preparationBrowserReview(f.tasks,f.store,f.ns,f.taskId,{...f.selection,files:[{...f.selection.files[0]!,artifactId:'foreign-file'}]},f.portal),/FILE_NOT_CURRENT/);
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[0]!.unresolved=true;});assert.throws(f.read,/FIELD_UNAVAILABLE/);
 }finally{f.close();}
});

test('correction, source-binding changes and silent field changes invalidate the displayed review',()=>{
 const f=fixture();try{
  const first=f.read();f.tasks.update(f.taskId,t=>{t.preparation!.fields[1]!.value='changed@example.test';});assert.throws(first.assertCurrent,/REVIEW_CHANGED/);
  const second=f.read();f.tasks.update(f.taskId,t=>{t.preparation!.rootRevision++;});assert.throws(second.assertCurrent,/REVIEW_CHANGED/);
  const third=f.read();f.tasks.update(f.taskId,t=>{t.preparation!.revision++;t.applicationRevision!.revision++;});assert.throws(third.assertCurrent,/STALE_REVISION/);
 }finally{f.close();}
});

test('cancelled/running/uncertain work and stale or corrupted file bytes cannot be approved through a snapshot',()=>{
 const f=fixture();try{
  const shown=f.read();f.tasks.update(f.taskId,t=>{t.status='cancelled';});assert.throws(shown.assertCurrent,/NOT_SETTLED/);
  f.tasks.update(f.taskId,t=>{t.status='working';});assert.throws(f.read,/NOT_SETTLED/);
  f.tasks.update(f.taskId,t=>{t.status='blocked';t.recovery='reconciliation_required';});assert.throws(f.read,/NOT_SETTLED/);
  f.tasks.update(f.taskId,t=>{t.recovery='clean';t.preparation!.fields[0]!.value='Correction after file creation';});assert.throws(f.read,/FILE_NOT_CURRENT/);
  f.tasks.update(f.taskId,t=>{t.preparation!.fields[0]!.value='Mira Corrected';});writeFileSync(join(f.root,'evidence','artifacts',f.pdf.artifact.id),'Corrupt invented bytes');assert.throws(f.read);
 }finally{f.close();}
});

test('ambiguous control mappings and cross-origin destinations are rejected; returned-data mutation is not a new review',()=>{
 const f=fixture();try{
  assert.throws(()=>preparationBrowserReview(f.tasks,f.store,f.ns,f.taskId,{...f.selection,fields:[f.selection.fields[0]!,{...f.selection.fields[1]!,name:'participant_a'}]},f.portal),/AMBIGUOUS_CONTROL/);
  assert.throws(()=>preparationBrowserReview(f.tasks,f.store,f.ns,f.taskId,f.selection,{...f.portal,submissionUrl:'https://foreign.example.test/submit'}),/INVALID_DESTINATION/);
  const snapshot=f.read();(snapshot.review.controls[0]as {value:string}).value='Changed after display';assert.throws(snapshot.assertCurrent,/REVIEW_CHANGED/);
 }finally{f.close();}
});
