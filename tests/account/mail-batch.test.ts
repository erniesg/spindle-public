import {test} from 'node:test';import assert from 'node:assert/strict';
import {MailService} from '../../core/mail/service.js';import {mailFixture} from './mail-fixture.js';

for(const batch of [1,2,4,'native'] as const)test('production model batch '+batch+' retains drafts and real results reach the next turn',async()=>{
 const f=await mailFixture({batch});try{
  const source=f.prepared(),admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented email using the selected PDF',requestId:'batch-'+batch,processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any;
  const result=await f.until(admitted.taskId),count=typeof batch==='number'?batch:1;assert.equal(result.state,'ready',JSON.stringify(result));assert.equal(result.recovery,'clean');assert.equal(result.drafts.length,count);assert.equal(f.counts().modelCalls,2);
  const observed=f.modelStates[1].untrustedTask.observations;assert.equal(observed.length,count);
  for(let i=0;i<count;i++){assert.equal(observed[i].callId,'draft-member-'+i);assert.equal(observed[i].status,'ok');assert.equal(observed[i].data.state,'local_draft');assert.ok(result.drafts.some((d:any)=>d.draft.sha256===observed[i].data.draft.sha256));}
  for(const d of result.drafts){const detail=await f.client.mailAction('draft',{taskId:admitted.taskId,draft:d.draft}) as any;assert.equal(detail.attachmentsComplete,true);assert.equal(detail.attachments[0].sha256,source.sha256);}
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.includes('/gmail/')).length,0,'local batches confer no Gmail authority');
 }finally{await f.close();}
});

for(const forged of ['unadmitted','sibling-wrong-tool'] as const)test('production batch denies '+forged+' invocation before local effects',async()=>{
 // Inject a corrupted invocation context, not a different runtime decision or a
 // replacement fence. The accepted batch and ordinary RPC/adapter stay real.
 const prototype=MailService.prototype as any,original=prototype.tools;let injected=false;
 prototype.tools=async function(...args:any[]){const composed=await original.apply(this,args);return {...composed,tools:composed.tools.map((tool:any)=>tool.name!=='mail.draft.create'?tool:{...tool,invoke:(value:unknown,ctx:any)=>{injected=true;return tool.invoke(value,{...ctx,callId:forged==='unadmitted'?'not-admitted':'read-member'});}})};};
 const f=await mailFixture({batch:forged==='unadmitted'?1:'mixed'});try{
  const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented email',requestId:'forged-'+forged,processingConsent:true}) as any,result=await f.until(admitted.taskId);
  assert.equal(injected,true);assert.equal(result.state,'blocked');assert.equal(result.drafts.length,0,'no artifact may be minted by an unadmitted member identity');assert.equal(f.counts().modelCalls,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.includes('/gmail/')).length,0);
 }finally{prototype.tools=original;await f.close();}
});
