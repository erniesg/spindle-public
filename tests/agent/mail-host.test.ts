import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {mailSendGrants} from '../../core/connectors/google/outgoing.js';
import type {AgentProvider,Task,ToolContext} from '../../core/agent/contracts.js';
const modulePath='../../core/agent/mail-host.js';
async function editDraft(f:any){const before=f.tasks.get(f.taskId).observations.length;f.resume();const provider:AgentProvider={id:'invented-edit-provider',async next(t){return t.observations.length>before?{kind:'ready',result:'Updated local draft'}:{kind:'tool',name:'mail.draft.edit',args:{draft:f.draft,content:{to:[{address:'recipient@example.test'}],subject:'Changed invented subject',text:'Changed invented body'},provenanceIds:[]}};}};await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,provider,3,f.host.execution);const result=f.tasks.get(f.taskId).observations.slice(before).find((o:any)=>o.status==='ok'&&o.data?.draft);assert.ok(result,'the actual local edit must succeed even if a later Ready is refused by an unknown send');return(result.data as any).draft;}
async function sendOnce(f:any,draft=f.draft){f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,{id:'invented-one-send',async next(){return{kind:'tool',name:'mail.send',args:{draft}};}},1,f.host.execution);}
async function fixture(loseAck=false){
 const {createTaskMailTools}=await import(modulePath);mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/task-mail-')),ns={workspaceId:'account-private',accountId:'owner-uuid'},sender='selected@example.test';
 let tasks=new AgentStore(join(dir,'tasks.sqlite')),store=new EvidenceStore(join(dir,'evidence')),posts=0,current=true;
 const http:typeof fetch=async()=>{posts++;if(loseAck)throw Error('Invented lost ACK');return Response.json({id:'actual-fixture-message',threadId:'actual-fixture-thread'});};
 const send={connectionId:'connection',connectionEpoch:'epoch',grant:mailSendGrants.send,oauth:{connectorAccess:async()=>({accountId:sender,connectionEpoch:'epoch',assertCurrent:async()=>{},token:async()=> 'INVENTED_TOKEN'})},http,assertCurrent:async()=>{if(!current)throw Error('Revoked host authority');}};
 const make=()=>createTaskMailTools({tasks,store,namespace:ns,sender,send});let host=make();
 const task=tasks.admit({...ns,messageId:'invented-message',outcome:'Prepare then explicitly approve an invented email'},40);
 const draftProvider:AgentProvider={id:'invented-scripted-provider',async next(t){return t.observations.length?{kind:'ready',result:'Local draft retained; not sent'}:{kind:'tool',name:'mail.draft.create',args:{content:{to:[{address:'recipient@example.test'}],subject:'Invented task mail',text:'Invented body'},provenanceIds:[]}};}};
 await new AgentRuntime(tasks,host.tools).run(task.id,draftProvider,4,host.execution);const draft=(tasks.get(task.id).observations[0].data as any).draft;
 const resume=()=>tasks.update(task.id,t=>{t.status='working';t.generation++;delete t.currentResult;});
 const sendProvider:AgentProvider={id:'invented-send-provider',async next(t){return t.observations.some(o=>(o.data as any)?.state==='sent'||(o.data as any)?.state==='uncertain')?{kind:'ready',result:'Observed actual tool outcome; no delivery inference'}:{kind:'tool',name:'mail.send',args:{draft}};}};
 return {get tasks(){return tasks;},get store(){return store;},get host(){return host;},ns,sender,taskId:task.id,draft,posts:()=>posts,resume,sendProvider,revokeHost(){current=false;},async reopen(){tasks.close();store.close();tasks=new AgentStore(join(dir,'tasks.sqlite'));store=new EvidenceStore(join(dir,'evidence'));host=make();},close(){tasks.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('ordinary runtime observes durable local draft; only trusted exact approval admits send, and provider facts survive reopen',async()=>{
 const f=await fixture();try{
  f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,f.sendProvider,2,f.host.execution);assert.equal(f.posts(),0);assert.equal(f.tasks.get(f.taskId).status,'blocked');
  const approval=f.host.approve(f.taskId,f.draft,'owner-submit-request');assert.ok(approval.id);f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,f.sendProvider,3,f.host.execution);assert.equal(f.posts(),1);
  assert.ok(f.tasks.get(f.taskId).observations.some(o=>(o.data as any)?.messageId==='actual-fixture-message'));
  await f.reopen();const state=f.host.status(f.taskId);assert.equal(state.sends[approval.id].outcome.state,'sent');assert.equal(state.sends[approval.id].outcome.messageId,'actual-fixture-message');
  assert.equal(f.host.approve(f.taskId,f.draft,'owner-submit-request').id,approval.id);assert.equal(f.posts(),1);
 }finally{f.close();}
});
test('edit revokes old exact approval; reading an old draft cannot make it current again',async()=>{
 const f=await fixture();try{const old=f.host.approve(f.taskId,f.draft,'owner-approval');const newer=await editDraft(f);assert.notEqual(newer.sha256,f.draft.sha256);const before=f.tasks.get(f.taskId).observations.length;f.resume();const reader:AgentProvider={id:'invented-read-old',async next(t){return t.observations.length>before?{kind:'ready',result:'Read retained old immutable draft'}:{kind:'tool',name:'mail.draft.read',args:{draft:f.draft}};}};await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,reader,3,f.host.execution);assert.equal(f.host.status(f.taskId).approvals[f.draft.draftId].revoked,true);assert.throws(()=>f.host.approve(f.taskId,f.draft,'stale-request'),/CURRENT/);assert.ok(f.host.approve(f.taskId,newer,'new-review').id!==old.id);assert.equal(f.posts(),0);}finally{f.close();}
});
test('unknown previous revision cannot be bypassed by editing the same logical draft',async()=>{
 const f=await fixture(true);try{f.host.approve(f.taskId,f.draft,'owner-approval');f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,f.sendProvider,3,f.host.execution);const newer=await editDraft(f);assert.throws(()=>f.host.approve(f.taskId,newer,'changed-revision-request'),/RECONCILIATION/);assert.equal(f.posts(),1);}finally{f.close();}
});
test('retained acknowledgement still requires current host authority and cannot rePOST',async()=>{
 const f=await fixture();try{f.host.approve(f.taskId,f.draft,'owner-approval');f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,f.sendProvider,3,f.host.execution);assert.equal(f.posts(),1);f.revokeHost();f.resume();const provider:AgentProvider={id:'invented-duplicate-provider',async next(){return{kind:'tool',name:'mail.send',args:{draft:f.draft}};}};await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,provider,1,f.host.execution);assert.equal(f.tasks.get(f.taskId).status,'blocked');assert.equal(f.posts(),1);}finally{f.close();}
});
test('older owner request cannot authorize a third POST after another request and full reopen',async()=>{
 const f=await fixture();try{const a=f.host.approve(f.taskId,f.draft,'owner-A');await sendOnce(f);const b=f.host.approve(f.taskId,f.draft,'owner-B');await sendOnce(f);await f.reopen();const replay=f.host.approve(f.taskId,f.draft,'owner-A');await sendOnce(f);assert.equal(f.posts(),2);assert.equal(replay.id,a.id);assert.equal(replay.revoked,true);const state=f.host.status(f.taskId)as any;assert.equal(state.approvals[f.draft.draftId].id,b.id);assert.equal(Object.keys(state.sends).length,2);assert.equal(Object.keys(state.requests).length,2);for(let i=0;i<40;i++)assert.equal(f.host.approve(f.taskId,f.draft,'owner-A').id,a.id);await f.reopen();assert.equal(Object.values(f.host.status(f.taskId).requests!).length,2);assert.equal(f.posts(),2);}finally{f.close();}
});
test('request identity cannot be rebound to edited draft or another application revision',async()=>{
 const f=await fixture();try{f.host.approve(f.taskId,f.draft,'owner-A');const newer=await editDraft(f);f.host.approve(f.taskId,newer,'owner-B');assert.throws(()=>f.host.approve(f.taskId,newer,'owner-A'),/REQUEST_ID_CONFLICT/);f.tasks.update(f.taskId,t=>{t.applicationRevision={applicationId:'invented-application',revision:2,contentHash:'a'.repeat(64)};});assert.throws(()=>f.host.approve(f.taskId,newer,'owner-B'),/REQUEST_ID_CONFLICT/);assert.equal(f.posts(),0);}finally{f.close();}
});
test('revoked and prototype-like owner request IDs remain retained without reactivation',async()=>{
 const f=await fixture();try{const a=f.host.approve(f.taskId,f.draft,'__proto__');f.host.revoke(f.taskId,a.id);f.host.approve(f.taskId,f.draft,'constructor');await f.reopen();const replay=f.host.approve(f.taskId,f.draft,'__proto__');assert.equal(replay.id,a.id);assert.equal(replay.revoked,true);assert.equal(Object.keys(f.host.status(f.taskId).requests!).length,2);assert.equal(f.posts(),0);}finally{f.close();}
});
test('legacy incomplete request history permits retained current facts but not fresh approval',async()=>{
 const f=await fixture();try{const a=f.host.approve(f.taskId,f.draft,'owner-A');f.tasks.update(f.taskId,t=>{delete(t.mail as any).requests;});await f.reopen();assert.equal(f.host.approve(f.taskId,f.draft,'owner-A').id,a.id);assert.throws(()=>f.host.approve(f.taskId,f.draft,'owner-B'),/HISTORY_RECONCILIATION_REQUIRED/);assert.equal(f.posts(),0);}finally{f.close();}
});
test('a different same-account task cannot read or edit another task draft reference',async()=>{
 const f=await fixture();try{for(const name of ['mail.draft.read','mail.draft.edit']){
  const other=f.tasks.admit({...f.ns,messageId:name,outcome:'Another invented task'},10);
  await new AgentRuntime(f.tasks,f.host.tools).run(other.id,{id:'invented-cross-task',async next(){return {kind:'tool',name,args:{draft:f.draft,...(name==='mail.draft.edit'?{content:{to:[{address:'other@example.test'}],subject:'Unrelated',text:'Unrelated'},provenanceIds:[]}:{})}};}},1,f.host.execution);
  assert.equal(f.tasks.get(other.id).status,'blocked');assert.equal(f.tasks.get(other.id).observations.length,0);assert.equal(f.posts(),0);
 }}finally{f.close();}
});
test('lost send ACK retains pre-dispatch intent across restart and blocks fresh authorization/rePOST',async()=>{
 const f=await fixture(true);try{
  const approval=f.host.approve(f.taskId,f.draft,'owner-submit-request');f.resume();await new AgentRuntime(f.tasks,f.host.tools).run(f.taskId,f.sendProvider,4,f.host.execution);assert.equal(f.posts(),1);
  // The uncertain send refuses Ready (READY_REJECTED) each time; the third refusal stops the run.
  assert.equal(f.tasks.get(f.taskId).status,'blocked');assert.equal(f.tasks.get(f.taskId).blocker,'Repeated READY_REJECTED');assert.equal(f.tasks.get(f.taskId).currentResult,undefined);
  await f.reopen();assert.equal(f.host.status(f.taskId).sends[approval.id].outcome.state,'uncertain');assert.throws(()=>f.host.approve(f.taskId,f.draft,'new-request'),/RECONCILIATION/);assert.equal(f.posts(),1);
 }finally{f.close();}
});
