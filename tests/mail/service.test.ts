import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {GoogleOAuth,scopes,type CredentialStore} from '../../core/connectors/google/oauth.js';
import {mailSendGrants} from '../../core/connectors/google/outgoing.js';
import type {AgentProvider} from '../../core/agent/contracts.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {CallBudget} from '../../core/models/provider.js';
import {AgentSessionStore} from '../../core/models/agent-session-store.js';
const serviceModule='../../core/mail/service.js';
const content={to:[{address:'recipient@example.test'}],subject:'Invented subject',text:'Invented only body'};
async function fixture(options:{grants?:string[];lostPublish?:boolean;lostSend?:boolean;paused?:boolean;revokeAtToken?:boolean;modelPublish?:boolean;agent?:(store:EvidenceStore)=>AgentProvider}={}){
 const {MailService}=await import(serviceModule);mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/mail-service-'));
 let tasks=new AgentStore(join(dir,'tasks.sqlite')),store=new EvidenceStore(join(dir,'evidence'));
 let raw=JSON.stringify({refreshToken:'INVENTED_REFRESH',accountId:'selected@example.test',connectionEpoch:'epoch',grants:options.grants??[scopes.mail,mailSendGrants.send,mailSendGrants.compose]});
 const credentials:CredentialStore={async get(){return raw;},async set(_id,v){raw=v;},async delete(){raw='';},async compareAndSet(_id,expected,v){if(raw!==expected)return false;raw=v;return true;}};
 const requests:{url:string;init?:RequestInit}[]=[];let remoteRaw='',revoked=false,models=0;
 const http:typeof fetch=async(url,init)=>{
  const u=String(url);requests.push({url:u,init});
  if(u==='https://oauth2.googleapis.com/token'){if(options.revokeAtToken)revoked=true;return Response.json({access_token:'INVENTED_ACCESS'});}
  if(u.endsWith('/drafts')&&init?.method==='POST'){remoteRaw=JSON.parse(String(init.body)).message.raw;if(options.lostPublish)throw Error('Invented lost ACK');return Response.json({id:'gmail-draft',message:{id:'draft-message',threadId:'thread'}});}
  if(u.includes('/drafts/gmail-draft'))return Response.json({id:'gmail-draft',message:{id:'draft-message',threadId:'thread',raw:remoteRaw}});
  if(u.includes('/drafts?'))return Response.json({drafts:remoteRaw?[{id:'gmail-draft',message:{id:'draft-message'}}]:[]});
  if(u.endsWith('/messages/send')||u.endsWith('/drafts/send')){if(options.lostSend)throw Error('Invented lost send ACK');return Response.json({id:'observed-message',threadId:'observed-thread'});}
  if(u.includes('/messages?'))return Response.json({messages:[]});
  throw Error('Unexpected invented transport path '+u);
 };
 const oauth=new GoogleOAuth('invented-client',credentials,http);
 const provider:AgentProvider={id:'invented-scripted-agent',async next(task,tools){
  assert.ok(tools.some(t=>t.name==='mail.draft.publish'&&t.effect==='external_write'));assert.ok(tools.some(t=>t.name==='mail.send'));
  if(!task.observations.length)return {kind:'tool',name:'mail.draft.create',args:{content,provenanceIds:[]}};
  assert.equal((task.observations.at(-1)!.data as any).state,'local_draft');
  if(options.modelPublish)return {kind:'tool',name:'mail.draft.publish',args:{draft:(task.observations.at(-1)!.data as any).draft}};
  return {kind:'ready',result:'Review the exact retained draft'};
 }};
 const make=()=>new MailService({tasks,store,workspaceId:'workspace',processingPaused:options.paused,provider:()=>{models++;return options.agent?.(store)??provider;}},async(owner:string,session:string,connection:string)=>{
  if(owner!=='owner'||session!=='session'||connection!=='connection'||revoked)throw Error('Invented auth revoked');
  return {oauth,connectionId:'connection',connectionEpoch:JSON.parse(raw).connectionEpoch,googleAccountId:'selected@example.test',incarnation:JSON.parse(raw).connectionEpoch,async guardedHttp(input:RequestInfo|URL,init:RequestInit|undefined,guard:()=>void){if(revoked)throw Error('Invented revoked');guard();return http(input,init);},async assertCurrent(){if(revoked)throw Error('Invented revoked');}};
 });let service=make();
 const call=(path:string,data:Record<string,unknown>={})=>service.handle('owner','session','/mail/'+path,data) as Promise<any>;
 return {get tasks(){return tasks;},get store(){return store;},call,requests,models:()=>models,reauthorize(grants:string[]){raw=JSON.stringify({...JSON.parse(raw),connectionEpoch:'new-epoch',grants});},revoke(){revoked=true;},changeRemote(){remoteRaw=Buffer.from('Changed remote draft').toString('base64url');},wrong:(owner:string,session:string,path:string,data:any)=>service.handle(owner,session,'/mail/'+path,data),async create(){const r=await call('request',{connectionId:'connection',request:'Write invented email',requestId:'request',processingConsent:true});for(let i=0;i<100;i++){const s=await call('status',{taskId:r.taskId});if(s.execution!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture task did not drain');},async reopen(){await service.close();tasks.close();store.close();tasks=new AgentStore(join(dir,'tasks.sqlite'));store=new EvidenceStore(join(dir,'evidence'));service=make();},async close(){await service.close();tasks.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('registered local draft, owner edit, actual Gmail publish/readback and exact draft send use production OAuth/HTTP without model reruns',async()=>{
 const f=await fixture();try{
  const s=await f.create(),taskId=s.taskId;assert.equal(s.state,'ready');assert.equal(f.models(),1);assert.equal(f.requests.length,0);
  const first=s.drafts[0].draft;assert.equal(s.drafts[0].sender,'selected@example.test');
  await f.call('edit',{taskId,draft:first,content:{...content,text:'Edited invented body'},requestId:'edit'});
  const edited=(await f.call('status',{taskId})).drafts[0];assert.equal(edited.draft.revision,2);assert.notEqual(edited.draft.sha256,first.sha256);
  await assert.rejects(f.call('publish',{taskId,draft:first,requestId:'stale'}),/CURRENT/);
  await Promise.all([f.call('publish',{taskId,draft:edited.draft,requestId:'publish'}),f.call('publish',{taskId,draft:edited.draft,requestId:'publish'})]);
  const published=await f.call('status',{taskId});assert.equal(published.drafts[0].publish.state,'verified');assert.equal(f.requests.filter(r=>r.init?.method==='POST'&&r.url.endsWith('/drafts')).length,1);
  const post=f.requests.find(r=>r.url.endsWith('/drafts'))!;const mime=Buffer.from(JSON.parse(String(post.init?.body)).message.raw,'base64url');assert.match(mime.toString(),/^From: selected@example.test\r\n/);
  await f.call('send',{taskId,draft:edited.draft,requestId:'send'});await f.call('send',{taskId,draft:edited.draft,requestId:'send'});
  const sends=f.requests.filter(r=>r.url.endsWith('/drafts/send'));assert.equal(sends.length,1);const body=JSON.parse(String(sends[0].init?.body));assert.equal(body.id,'gmail-draft');assert.deepEqual(Buffer.from(body.message.raw,'base64url'),mime);
  assert.equal((await f.call('status',{taskId})).drafts[0].send.state,'sent');assert.equal(f.models(),1);
  await f.reopen();assert.equal((await f.call('status',{taskId})).drafts[0].send.messageId,'observed-message');assert.equal(f.models(),1);
 }finally{await f.close();}
});
test('lost publication ACK is held across restart and only read-only reconciliation can observe exact raw MIME',async()=>{
 const f=await fixture({lostPublish:true});try{const s=await f.create(),taskId=s.taskId,draft=s.drafts[0].draft;await f.call('publish',{taskId,draft,requestId:'publish'});await f.reopen();await f.call('publish',{taskId,draft,requestId:'publish'});await assert.rejects(f.call('publish',{taskId,draft,requestId:'new-publish'}),/RECONCILIATION/);assert.equal(f.requests.filter(r=>r.url.endsWith('/drafts')&&r.init?.method==='POST').length,1);const reconciled=await f.call('reconcile',{taskId,draft});assert.equal(reconciled.drafts[0].publish.state,'verified');}finally{await f.close();}
});
test('missing grants, wrong owner/session, stale review and remote edits deny before send dispatch',async()=>{
 const f=await fixture({grants:[scopes.mail]});try{const s=await f.create(),taskId=s.taskId,draft=s.drafts[0].draft;await assert.rejects(f.wrong('other','session','draft',{taskId,draft}),/NOT_FOUND/);await assert.rejects(f.wrong('owner','wrong','send',{taskId,draft,requestId:'bad-session'}));await f.call('publish',{taskId,draft,requestId:'no-grant'});await f.call('send',{taskId,draft,requestId:'no-send-grant'});assert.equal(f.requests.length,0);}finally{await f.close();}
 const g=await fixture();try{const s=await g.create(),taskId=s.taskId,draft=s.drafts[0].draft;await g.call('publish',{taskId,draft,requestId:'publish'});g.changeRemote();await g.call('send',{taskId,draft,requestId:'send'});assert.equal(g.requests.filter(r=>r.url.endsWith('/send')).length,0);}finally{await g.close();}
});
test('genuine grant expansion after local drafting allows the same reviewed revision, without old approval reactivation',async()=>{
 const f=await fixture({grants:[scopes.mail]});try{const s=await f.create(),taskId=s.taskId,draft=s.drafts[0].draft;
  await f.call('publish',{taskId,draft,requestId:'before-grant'});assert.equal(f.requests.length,0);
  f.reauthorize([scopes.mail,mailSendGrants.compose]);await f.call('publish',{taskId,draft,requestId:'after-grant'});assert.equal((await f.call('status',{taskId})).drafts[0].publish.state,'verified');
  await f.call('send',{taskId,draft,requestId:'compose-send'});assert.equal(f.requests.filter(r=>r.url.endsWith('/drafts/send')).length,1);assert.equal(f.models(),1);
 }finally{await f.close();}
});
test('model sees publish registry but cannot authorize Google effects; paused processing never calls provider',async()=>{
 const f=await fixture({modelPublish:true});try{const s=await f.create();assert.equal(s.state,'blocked');assert.equal(s.drafts.length,1);assert.equal(f.requests.length,0);}finally{await f.close();}
 const g=await fixture({paused:true});try{await assert.rejects(g.call('request',{connectionId:'connection',request:'Invented',requestId:'paused',processingConsent:true}),/PAUSED/);assert.equal(g.models(),0);await g.call('list');await g.call('config');assert.equal(g.models(),0);}finally{await g.close();}
});
test('lost send ACK survives restart; duplicate/new consent/reconnect cannot bypass the one-effect hold',async()=>{
 const f=await fixture({lostSend:true});try{const s=await f.create(),taskId=s.taskId,draft=s.drafts[0].draft;await f.call('send',{taskId,draft,requestId:'send'});await f.reopen();
  assert.equal((await f.call('status',{taskId})).drafts[0].send.state,'uncertain');await f.call('send',{taskId,draft,requestId:'send'});await assert.rejects(f.call('send',{taskId,draft,requestId:'fresh-consent'}),/RECONCILIATION/);
  const reconciled=await f.call('reconcile',{taskId,draft});assert.equal(reconciled.reconciliation[0].automaticRetryAllowed,false);assert.equal(reconciled.drafts[0].send.state,'uncertain');
  f.reauthorize([scopes.mail,mailSendGrants.send]);await assert.rejects(f.call('send',{taskId,draft,requestId:'reconnect-consent'}),/RECONCILIATION/);assert.equal(f.requests.filter(r=>r.url.endsWith('/messages/send')).length,1);
 }finally{await f.close();}
});
test('revocation during real OAuth refresh denies draft POST, cancellation preserves immutable artifacts',async()=>{
 const f=await fixture({revokeAtToken:true});try{const s=await f.create(),taskId=s.taskId,draft=s.drafts[0].draft;await f.call('publish',{taskId,draft,requestId:'publish'});assert.equal(f.requests.filter(r=>r.url.endsWith('/drafts')&&r.init?.method==='POST').length,0);await f.call('cancel',{taskId});assert.equal((await f.call('status',{taskId})).state,'cancelled');await assert.rejects(f.call('edit',{taskId,draft,content,requestId:'after-cancel'}));assert.equal(f.models(),1);}finally{await f.close();}
});
test('configured production agent adapter chooses registered draft/edit/read tools and consumes real results on later turns (injected provider HTTP)',async()=>{
 let turns=0;const budget=new CallBudget(1,8);
 const f=await fixture({agent:store=>new NebiusAgentProvider({model:{provider:'nebius',id:'invented-test-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.test/pricing'}},budget,credential:async()=>'INVENTED_MODEL_KEY',persist:new AgentSessionStore(store.db).persist,transport:async(url,init)=>{
  assert.equal(String(url),'https://api.tokenfactory.nebius.com/v1/chat/completions');const body=JSON.parse(String(init?.body)),payload=JSON.parse(body.messages[1].content),observed=payload.untrustedTask.observations;
  assert.ok(payload.registeredTools.some((t:any)=>t.name==='mail.draft.publish'));let next:unknown;
  if(turns===0)next={kind:'tool',name:'mail.draft.create',args:{content,provenanceIds:[]}};
  else if(turns===1){assert.equal(observed[0].data.state,'local_draft');next={kind:'tool',name:'mail.draft.edit',args:{draft:observed[0].data.draft,content:{...content,text:'Model-edited invented body'},provenanceIds:[]}};}
  else if(turns===2){assert.equal(observed[1].data.record.content.text,'Model-edited invented body');next={kind:'tool',name:'mail.draft.read',args:{draft:observed[1].data.draft}};}
  else {assert.deepEqual(observed[2].data.draft,observed[1].data.draft);next={kind:'ready',result:'Actual retained revision is ready for owner review'};}
  turns++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:next})}}],usage:{prompt_tokens:100,completion_tokens:30}});
 }})});
 try{const s=await f.create();assert.equal(s.state,'ready');assert.equal(turns,4);assert.equal(s.drafts[0].draft.revision,2);assert.equal(f.requests.length,0);assert.equal(budget.snapshot().calls,4);const sessions=new AgentSessionStore(f.store.db).list({workspaceId:'workspace',accountId:'owner'},s.taskId);assert.equal(sessions.length,4);assert.equal(sessions[3].response?.decision.kind,'ready');}finally{await f.close();}
});
test('exact request replay never reruns the model, and a request ID cannot bind new content',async()=>{
 const f=await fixture();try{const first=await f.create(),second=await f.create();assert.equal(first.taskId,second.taskId);assert.equal(f.models(),1);await assert.rejects(f.call('request',{connectionId:'connection',request:'Different invented request',requestId:'request',processingConsent:true}),/CONFLICT/);assert.equal(f.models(),1);}finally{await f.close();}
});
