import {test} from 'node:test';import assert from 'node:assert/strict';
import {mailFixture} from './mail-fixture.js';import {AccountClient} from '../../core/account/client.js';
const request=(connectionId:string,source:{taskId:string;artifactId:string})=>({connectionId,request:'Draft an application email using the selected prepared PDF.',requestId:'prepared-mail-request',processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]});
async function grant(f:Awaited<ReturnType<typeof mailFixture>>){f.setCompose(true);const flow=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(flow.authorizationUrl);}

test('explicit current prepared PDF selection reaches real MIME/Gmail draft/send without a Drive importer or Ready-only source rule',async()=>{
 const f=await mailFixture();try{
  const source=f.prepared(),listed=await f.client.mailAction('sources',{sourceTaskId:source.taskId}) as any;assert.ok(listed.artifacts.some((a:any)=>a.artifactId===source.artifactId));
  const other=new AccountClient(f.app.origin);await other.signin('invented-source-other','invented-password-123',true);await assert.rejects(other.mailAction('sources',{sourceTaskId:source.taskId}));
  await assert.rejects(f.client.mailAction('request',{...request(f.flow.connectionId,source),attachmentIds:['unadmitted-artifact']}));assert.equal(f.counts().modelCalls,0);
  const admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;
  assert.equal(ready.source.current,true);assert.equal(ready.drafts[0].attachments[0].sha256,source.sha256);assert.equal(ready.drafts[0].attachments[0].bytes,source.bytes.length);
  await grant(f);const saved=await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'publish-prepared'}) as any;assert.equal(saved.drafts[0].publish.state,'verified');
  const post=f.calls.find(c=>c.method==='POST'&&c.path.endsWith('/drafts'))!,mime=Buffer.from(post.body.message.raw,'base64url').toString();assert.ok(mime.includes(source.bytes.toString('base64').match(/.{1,76}/g)!.join('\r\n')));
  const sent=await f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'send-prepared'}) as any;assert.equal(sent.drafts[0].send.state,'sent');assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,1);assert.equal(f.counts().modelCalls,2);
 }finally{await f.close();}
});

test('source revision change preserves the local draft but rejects publish/send before any effect',async()=>{
 const f=await mailFixture();try{const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;source.change();
  const status=await f.client.mailAction('status',{taskId:admitted.taskId}) as any;assert.equal(status.source.current,false);assert.equal(status.drafts[0].draft.sha256,draft.sha256);
  for(const action of ['publish','send'] as const)await assert.rejects(f.client.mailAction(action,{taskId:admitted.taskId,draft,requestId:'stale-'+action}),/MAIL_SOURCE_CHANGED/);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.includes('/gmail/')).length,0);assert.equal(f.counts().modelCalls,2);
 }finally{await f.close();}
});

test('owner replaces source-changed attachments in a new local revision without another AI call',async()=>{
 const f=await mailFixture();try{const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft,updated=source.change();
  const detail=await f.client.mailAction('draft',{taskId:admitted.taskId,draft}) as any;
  const revised=await f.client.mailAction('edit',{taskId:admitted.taskId,draft,content:detail.content,sourceTaskId:source.taskId,attachmentIds:[updated.artifactId],requestId:'replace-current'}) as any;
  assert.equal(revised.state,'ready');assert.equal(revised.drafts[0].attachmentsComplete,true);assert.equal(revised.source.current,true);assert.equal(revised.source.revision,2);assert.equal(revised.drafts[0].draft.revision,2);assert.equal(revised.drafts[0].attachments[0].sha256,updated.sha256);assert.notEqual(updated.sha256,source.sha256);assert.equal(f.counts().modelCalls,2);
  await grant(f);const sent=await f.client.mailAction('send',{taskId:admitted.taskId,draft:revised.drafts[0].draft,requestId:'send-new-revision'}) as any;assert.equal(sent.drafts[0].send.state,'sent');
 }finally{await f.close();}
});

test('missing selected attachment blocks Ready/send, and explicit owner correction can apply the selection',async()=>{
 const f=await mailFixture({omitAttachments:true});try{const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,blocked=await f.until(admitted.taskId),draft=blocked.drafts[0].draft;assert.equal(blocked.state,'blocked');assert.equal(blocked.drafts[0].attachmentsComplete,false);
  await assert.rejects(f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'missing-file-send'}),/MAIL_ATTACHMENT_SELECTION_INCOMPLETE/);
  // A rejected Ready is now model feedback (READY_REJECTED) and the run continues until its bound;
  // it never becomes Ready with an incomplete selection. Either way, the owner edit must add no AI.
  const callsBeforeEdit=f.counts().modelCalls;assert.ok(callsBeforeEdit>2,String(callsBeforeEdit));
  assert.ok(f.modelStates.at(-1).untrustedTask.observations.some((o:any)=>o.status==='failed'&&/^ready-check-/.test(o.callId)),'the rejected Ready was fed back to the model');
  const detail=await f.client.mailAction('draft',{taskId:admitted.taskId,draft}) as any,repaired=await f.client.mailAction('edit',{taskId:admitted.taskId,draft,content:detail.content,sourceTaskId:source.taskId,attachmentIds:[source.artifactId],requestId:'apply-files'}) as any;
  assert.equal(repaired.drafts[0].attachmentsComplete,true);assert.equal(repaired.drafts[0].attachments[0].sha256,source.sha256);assert.equal(f.counts().modelCalls,callsBeforeEdit);
 }finally{await f.close();}
});

test('manual incomplete local revision stays blocked, explicit empty selection removes files without AI',async()=>{
 const f=await mailFixture();try{
  const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;
  const detail=await f.client.mailAction('draft',{taskId:admitted.taskId,draft}) as any,content={...detail.content,subject:'Owner corrected subject',attachments:[]};
  const incomplete=await f.client.mailAction('edit',{taskId:admitted.taskId,draft,content,requestId:'omit-selected-file'}) as any;
  assert.equal(incomplete.drafts[0].draft.revision,2);assert.equal(incomplete.source.artifacts.length,1);assert.equal(incomplete.drafts[0].attachmentsComplete,false);assert.equal(incomplete.state,'blocked');
  await assert.rejects(f.client.mailAction('send',{taskId:admitted.taskId,draft:incomplete.drafts[0].draft,requestId:'deny-incomplete'}),/MAIL_ATTACHMENT_SELECTION_INCOMPLETE/);
  const removed=await f.client.mailAction('edit',{taskId:admitted.taskId,draft:incomplete.drafts[0].draft,content,attachmentIds:[],requestId:'explicit-remove-files'}) as any;
  assert.equal(removed.drafts[0].draft.revision,3);assert.equal(removed.source,undefined);assert.equal(removed.drafts[0].attachmentsComplete,true);assert.equal(removed.drafts[0].attachments.length,0);assert.equal(removed.state,'ready');assert.equal(f.counts().modelCalls,2);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.includes('/gmail/')).length,0);
 }finally{await f.close();}
});

test('a Ready declaration without a persisted draft is blocked, not a completed email',async()=>{
 const f=await mailFixture({readyOnly:true});try{const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft an email',requestId:'empty-ready',processingConsent:true}) as any,blocked=await f.until(admitted.taskId);assert.equal(blocked.state,'blocked');assert.equal(blocked.drafts.length,0);}finally{await f.close();}
});

test('a source changed during lazy credential wait prevents model egress',async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;}),f=await mailFixture({credentialGate:gate,onCredential:started});
 try{const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any;await began;source.change();release();const blocked=await f.until(admitted.taskId);assert.equal(blocked.state,'blocked');assert.equal(f.counts().modelCalls,0);}finally{release();await f.close();}
});

for(const cancel of [false,true])test('old unknown Gmail draft can be reconciled read-only after source changes, cancelled='+cancel,async()=>{
 const f=await mailFixture({lostPublish:true});try{const source=f.prepared(),admitted=await f.client.mailAction('request',request(f.flow.connectionId,source)) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;await grant(f);
  const unknown=await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'unknown-publication'}) as any;assert.equal(unknown.drafts[0].publish.state,'uncertain');source.change();if(cancel)await f.client.mailAction('cancel',{taskId:admitted.taskId});f.setCompose(false);
  const recovered=await f.client.mailAction('reconcile',{taskId:admitted.taskId,draft}) as any;assert.equal(recovered.drafts[0].publish.state,'verified');assert.equal(recovered.source.current,false);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/drafts')).length,1);
  await assert.rejects(f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'no-stale-send'}),cancel?/MAIL_CANCELLED/:/MAIL_SOURCE_CHANGED/);assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,0);
 }finally{await f.close();}
});
