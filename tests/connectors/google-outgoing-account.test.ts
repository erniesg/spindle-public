import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createOutgoingMailTools} from '../../core/connectors/google/outgoing-tools.js';
import {mailSendGrants,type MailSendHost} from '../../core/connectors/google/outgoing.js';
import type {ToolContext} from '../../core/agent/contracts.js';

function fixture(){
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/owner-mail-')),store=new EvidenceStore(dir);
 const ns={workspaceId:'account-private',accountId:'owner-uuid'},sender='selected@example.test';
 const context:ToolContext={...ns,taskId:'task',runId:'run',callId:'call',scope:{sources:[],destinations:[],grants:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
 return {store,ns,sender,context,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('shared-account local drafts keep tenant UUID separate from trusted selected Google sender and immutable MIME',async()=>{
 const f=fixture();try{
  const tools=createOutgoingMailTools({store:f.store,namespace:f.ns,sender:f.sender} as any);
  const result=await tools.find(t=>t.name==='mail.draft.create')!.invoke({content:{to:[{address:'recipient@example.test'}],subject:'Invented review',text:'Invented body'},provenanceIds:[]},f.context);
  assert.equal(result.status,'ok',JSON.stringify(result));const data=result.data as any;
  assert.equal(data.record.accountId,f.ns.accountId);assert.equal(data.record.sender,f.sender);
  const mime=f.store.read(f.ns,data.record.mime.artifactId);assert.match(mime.toString(),/^From: selected@example\.test\r\n/);assert.doesNotMatch(mime.toString(),/From: owner-uuid/);
  const wrong=createOutgoingMailTools({store:f.store,namespace:f.ns,sender:'other@example.test'} as any);
  assert.equal((await wrong.find(t=>t.name==='mail.draft.read')!.invoke({draft:data.draft},f.context)).status,'needs_input');
  const otherNs={...f.ns,accountId:'another-owner-uuid'},other=createOutgoingMailTools({store:f.store,namespace:otherNs,sender:f.sender} as any);
  assert.equal((await other.find(t=>t.name==='mail.draft.read')!.invoke({draft:data.draft},{...f.context,...otherNs})).status,'needs_input');
  assert.deepEqual(f.store.read(f.ns,data.record.mime.artifactId),mime);
 }finally{f.close();}
});
test('send binds protected Google identity independently of account tenant; wrong selected identity never dispatches',async()=>{
 const f=fixture();let posts=0;try{
  let googleAccount=f.sender;
  const host:MailSendHost={connectionId:'connection',connectionEpoch:'epoch',grant:mailSendGrants.send,
   oauth:{connectorAccess:async()=>({accountId:googleAccount,connectionEpoch:'epoch',assertCurrent:async()=>{},token:async()=> 'invented-token'})} as any,
   approval:async(_ctx,binding)=>({id:'approval',binding:structuredClone(binding)}),assertCurrent:async()=>{},
   journal:{reserve:async()=> 'new',assertReserved:async()=>{},settle:async()=>{}},
   http:async(_url,init)=>{posts++;const mime=Buffer.from(JSON.parse(String(init?.body)).raw,'base64url').toString();assert.match(mime,/^From: selected@example\.test\r\n/);return Response.json({id:'observed-message',threadId:'observed-thread'});}};
  const tools=createOutgoingMailTools({store:f.store,namespace:f.ns,sender:f.sender,send:host} as any),ctx=f.context;
  const created=await tools.find(t=>t.name==='mail.draft.create')!.invoke({content:{to:[{address:'recipient@example.test'}],subject:'Invented',text:'No real mail'},provenanceIds:[]},ctx);assert.equal(created.status,'ok');const draft=(created.data as any).draft;
  googleAccount='wrong@example.test';const denied=await tools.find(t=>t.name==='mail.send')!.invoke({draft},ctx);assert.equal((denied.data as any).state,'denied');assert.equal(posts,0);
  googleAccount=f.sender;const sent=await tools.find(t=>t.name==='mail.send')!.invoke({draft},ctx);assert.equal(sent.status,'ok',JSON.stringify(sent));assert.equal((sent.data as any).messageId,'observed-message');assert.equal(posts,1);
 }finally{f.close();}
});
