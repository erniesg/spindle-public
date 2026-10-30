import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {createTaskMailTools} from '../../core/agent/mail-host.js';
import {startTaskReview} from '../../core/assistant/app.js';
import {mailSendGrants} from '../../core/connectors/google/outgoing.js';
import {inventedPdf} from '../portal/fixtures.js';

test('private owner review reads exact partial drafts/unknown facts without model or send; scope and corrupt-sibling isolation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mail-review-')),ns={workspaceId:'workspace',accountId:'owner-uuid'},sender='selected@example.test';let posts=0,reads=0;
 const tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[],{provider:'user',providerId:'invented-pdf',providerVersion:'1'});
 const mail=createTaskMailTools({tasks,store,namespace:ns,sender,send:{connectionId:'connection',connectionEpoch:'epoch',grant:mailSendGrants.send,oauth:{connectorAccess:async()=>({accountId:sender,connectionEpoch:'epoch',assertCurrent:async()=>{},token:async()=> 'INVENTED'})},assertCurrent:async()=>{},http:async()=>{posts++;throw Error('Invented lost acknowledgement');}}});
 const task=tasks.admit({...ns,messageId:'invented-request',outcome:'Prepare an invented email for review'},20),foreign=tasks.admit({...ns,accountId:'another-owner',messageId:'private',outcome:'Unrelated task'},5);
 const run=async(name:string,args:unknown)=>new AgentRuntime(tasks,mail.tools).run(task.id,{id:'scripted-fixture-not-LLM',async next(){return {kind:'tool',name,args};}},1,{...mail.execution,scope:{sources:[pdf.source!],destinations:[],grants:[]}});
 const content={to:[{address:'recipient@example.test',name:'Invented recipient'}],cc:[{address:'copy@example.test'}],bcc:[{address:'private-copy@example.test'}],subject:'Invented retained draft',text:'Invented body 000045',html:'<script>not an executable preview</script>',attachments:[{artifactId:pdf.artifact.id,sha256:pdf.artifact.sha256,name:'invented.pdf'}]};
 await run('mail.draft.create',{content,provenanceIds:[]});const draft=(tasks.get(task.id).observations[0].data as any).draft;
 let app:Awaited<ReturnType<typeof startTaskReview>>|undefined;
 try{
  app=await startTaskReview(tasks,ns,store,undefined,(id:string,after:string)=>{reads++;return mail.review(id,after);});assert.ok(app);
  const url=(id:string)=>`${app!.origin}/api/task-mail?taskId=${encodeURIComponent(id)}`,headers={authorization:`Bearer ${app.token}`};
  assert.equal((await fetch(url(task.id))).status,403);assert.equal((await fetch(url(task.id),{headers:{...headers,origin:'https://unrelated.example'}})).status,403);assert.equal(reads,0);
  for(const id of [foreign.id,'not-an-owner-task'])assert.equal((await fetch(url(id),{headers})).status,404);assert.equal(reads,0);
  const fullTask=tasks.get,fullLookup=tasks.taskInNamespace;tasks.get=()=>{throw Error('Raw task payload must not enter owner readback');};tasks.taskInNamespace=()=>{throw Error('Project owner metadata instead');};
  let response:Response;try{response=await fetch(url(task.id),{headers});}finally{tasks.get=fullTask;tasks.taskInNamespace=fullLookup;}assert.equal(response.status,200);let page=await response.json()as any,views=page.drafts as any[];
  assert.equal(views.length,1);assert.equal(views[0].state,'available');assert.deepEqual(views[0].draft,draft);assert.equal(views[0].record.sender,sender);assert.deepEqual(views[0].record.content,content);assert.equal(views[0].record.attachments[0].sha256,pdf.artifact.sha256);assert.equal(views[0].sends.length,0);assert.equal(tasks.get(task.id).status,'working','review before Ready must not force Ready or resume');assert.equal(posts,0);
  mail.approve(task.id,draft,'invented-owner-action');await run('mail.send',{draft});assert.equal(posts,1);
  response=await fetch(url(task.id),{headers});views=(await response.json()as any).drafts;assert.equal(views[0].sends[0].outcome.state,'uncertain');assert.equal(views[0].sends[0].draft.revision,draft.revision);assert.equal(posts,1,'review must not reconcile/rePOST or call a model');
  // A broken attachment must not hide another valid saved draft in the same task.
  tasks.update(task.id,t=>{t.status='working';t.generation++;});await run('mail.draft.create',{content:{to:content.to,subject:'Second intact draft',text:'Independently retained'},provenanceIds:[]});
  writeFileSync(join(root,'evidence','artifacts',pdf.artifact.id),'Corrupted invented bytes');
  page=await(await fetch(url(task.id),{headers})).json()as any;assert.equal(page.drafts.length,1,'read at most one potentially large body');const following=await(await fetch(url(task.id)+'&after='+encodeURIComponent(page.next),{headers})).json()as any;views=[...page.drafts,...following.drafts];assert.equal(views.length,2);assert.equal(views.find(v=>v.draft.draftId===draft.draftId).state,'unavailable');assert.equal(views.find(v=>v.state==='available').record.content.subject,'Second intact draft');assert.equal(posts,1);
  assert.equal((await fetch(url(task.id),{method:'POST',headers:{...headers,origin:app.origin,'content-type':'application/json'},body:'{}'})).status,404,'read-only route cannot mint approval/correction/continuation');
  await app.close();app=await startTaskReview(tasks,ns,store);assert.equal((await fetch(url(task.id),{headers:{authorization:'Bearer '+app.token}})).status,404,'omitting the trusted hook preserves payload-free preview behavior');
 }finally{await app?.close();tasks.close();store.close();rmSync(root,{recursive:true,force:true});}
});
