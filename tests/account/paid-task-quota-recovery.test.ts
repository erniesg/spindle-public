import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quotaServices} from './paid-task-quota-services.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {EncryptedStore} from '../../core/tracking/store.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import {EmailDrafts} from '../../core/connectors/google/outgoing.js';
import type {PaidTaskQuota} from '../../core/account/paid-task-quota.js';

type Kind='preparation'|'mail';
type State={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
async function fixture(kind:Kind){
 const directory=await mkdtemp(join(tmpdir(),'quota-recovery-invented-')),key=randomBytes(32),accountPath=join(directory,'account');
 let tasks=new AgentStore(join(directory,'tasks.sqlite')),evidence=new EvidenceStore(join(directory,'evidence'));
 let providerCalls=0,sourceCalls=0,failAttach=true,bindAttempts=0;
 const original=EncryptedStore.prototype.transaction;
 // Inject at the actual account-store commit boundary, after the service has
 // initialized SQLite, before the matching Task-id attachment becomes durable.
 EncryptedStore.prototype.transaction=function(this:EncryptedStore<any>,fn:any,write=true){
  if(this.directory!==accountPath)return original.call(this,fn,write);
  return original.call(this,(state:State)=>{
   const before=JSON.stringify(state.accounts.map(a=>a.paidTasks?.admissions));
   const result=fn(state);
   const after=state.accounts.flatMap(a=>a.paidTasks?.admissions??[]);
   if(write&&before!==JSON.stringify(state.accounts.map(a=>a.paidTasks?.admissions))&&after.some(a=>a.taskId)){
    bindAttempts++;if(failAttach)throw Error('invented Task-id attach failure');
   }
   return result;
  },write);
 } as typeof original;
 const quotaStore=()=>new EncryptedStore<State>(accountPath,key,()=>({accounts:[]}));
 const google={clientId:'invented-client',clientSecret:'invented-secret',http:async(input:Parameters<typeof fetch>[0])=>{
  const u=new URL(String(input));
  if(u.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'sender@example.test'});
  if(u.pathname==='/drive/v3/files'){sourceCalls++;return Response.json({files:[]});}
  if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',parents:[],version:'1',trashed:false});
  throw Error('Unexpected invented Google path');
 }};
 const start=()=>quotaServices(accountPath,key,google,{tasks,store:evidence,workspaceId:'account-private',buildIdentity:'invented-recovery',provider:()=>({id:'invented',async next(){providerCalls++;throw Error('fixture provider must not auto-restart');}}),tools:()=>[]},{tasks,store:evidence,workspaceId:'account-private',provider:()=>({id:'invented-mail',async next(){providerCalls++;throw Error('fixture provider must not auto-restart');}})});
 let server=await start();
 const client=server.client,transport=server.transport;
 const serviceRequest=(path:string,data:Record<string,unknown>)=>server.request(path,data);
 await client.signin('invented-recovery-owner','invented-password-123',true);
 const flow=await client.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await transport(callback)).status,200);
 await client.request('/google/roots',{connectionId:flow.connectionId,roots:['root']});
 const request={connectionId:flow.connectionId,request:'Invented interrupted '+kind,requestId:'original-request',processingConsent:true,...(kind==='preparation'?{rootId:'root',saveOutputs:false}:{})};
 const ns={workspaceId:'account-private',accountId:client.account!.id},identity=JSON.stringify([ns.workspaceId,ns.accountId,kind+':original-request']);
 const current=()=>tasks.tasks(ns)[0];
 const entries=()=>quotaStore().transaction(s=>structuredClone(s.accounts.find(a=>a.id===ns.accountId)?.paidTasks?.admissions??[]),false);
 let draft:ReturnType<EmailDrafts['create']>['draft']|undefined;
 return {client,request,identity,current,entries,counts:()=>({providerCalls,sourceCalls,bindAttempts,taskCount:tasks.tasks(ns).length}),allowBind:()=>{failAttach=false;},
  replay:(alias=false)=>serviceRequest('/'+kind+'/request',{...request,...(alias?{requestId:'alias-request'}:{})}),
  seedDraft:()=>{const snapshot=new EmailDrafts(evidence,ns,'sender@example.test').create({to:[{address:'recipient@example.test'}],subject:'Invented',text:'Invented'},[],()=>false);draft=snapshot.draft;tasks.update(current().id,t=>{t.mail!.drafts[draft!.draftId]=draft!;});},
  continuation:()=>kind==='preparation'?serviceRequest('/preparation/source',{taskId:current().id,operation:'list'}):serviceRequest('/mail/edit',{taskId:current().id,draft,requestId:'explicit-edit',content:{to:[{address:'recipient@example.test'}],subject:'Edited invented',text:'Edited invented'}}),
  mutateQuota:async(action:(q:PaidTaskQuota|undefined)=>PaidTaskQuota|undefined)=>{const prior=failAttach;failAttach=false;try{await quotaStore().transaction(s=>{const a=s.accounts.find(a=>a.id===ns.accountId)!;a.paidTasks=action(a.paidTasks);});}finally{failAttach=prior;}},
  reopen:async()=>{await server.close();tasks.close();evidence.close();tasks=new AgentStore(join(directory,'tasks.sqlite'));evidence=new EvidenceStore(join(directory,'evidence'));server=await start();await server.client.signin('invented-recovery-owner','invented-password-123');},
  close:async()=>{EncryptedStore.prototype.transaction=original;await server.close();tasks.close();evidence.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
 };
}
for(const mode of ['preparation-exact','preparation-alias','mail-exact'] as const)test('generic N4 real service '+mode+' binds interrupted admission on retained replay after restart',async()=>{
 const kind=mode.startsWith('preparation')?'preparation':'mail',f=await fixture(kind);
 try{
  await assert.rejects(f.replay());const id=f.current().id;assert.equal((await f.entries())[0].taskId,undefined);assert.equal(f.counts().providerCalls,0);assert.equal(f.current().sourceEvent.messageId,kind+':original-request');
  await f.reopen();
  const before=f.counts().bindAttempts;
  await assert.rejects(f.replay(mode==='preparation-alias'));assert.ok(f.counts().bindAttempts>before);
  assert.equal((await f.entries())[0].taskId,undefined);assert.equal(f.current().id,id);assert.equal(f.counts().providerCalls,0);
  f.allowBind();const result=await f.replay(mode==='preparation-alias') as any;
  assert.equal(result.taskId,id);assert.deepEqual((await f.entries()).map(a=>({identity:a.identity,taskId:a.taskId})),[{identity:f.identity,taskId:id}]);assert.equal(f.counts().providerCalls,0);
  assert.equal((await f.replay() as any).taskId,id);assert.equal((await f.entries()).length,1);assert.equal(f.counts().taskCount,1);assert.equal(f.current().sourceEvent.messageId,kind+':original-request');
 }finally{await f.close();}
});
for(const kind of ['preparation','mail'] as const)test('real '+kind+' continuation cannot dispatch before causal binding; explicit continuation works after binding',async()=>{
 const f=await fixture(kind);try{
  await assert.rejects(f.replay());if(kind==='mail')f.seedDraft();const id=f.current().id;await f.reopen();
  await assert.rejects(f.continuation());assert.equal((await f.entries())[0].taskId,undefined);assert.equal(f.counts().sourceCalls,0);assert.equal(f.counts().providerCalls,0);
  if(kind==='mail')assert.equal(Object.values(f.current().mail!.drafts)[0].revision,1);
  f.allowBind();await f.continuation();assert.equal((await f.entries())[0].taskId,id);assert.equal(f.counts().providerCalls,0);
  if(kind==='preparation')assert.equal(f.counts().sourceCalls,1);else assert.equal(Object.values(f.current().mail!.drafts)[0].revision,2);
 }finally{await f.close();}
});
for(const kind of ['preparation','mail'] as const)test('retained '+kind+' reconciles no missing/expired/pre-feature reservation and rejects conflicting Task binding',async()=>{
 const f=await fixture(kind);try{
  await assert.rejects(f.replay());const id=f.current().id;
  await f.mutateQuota(q=>({...q!,admissions:q!.admissions.map(a=>({...a,taskId:'conflicting-task'}))}));
  await assert.rejects(f.replay(),(e:any)=>e.status===429&&e.message==='PAID_TASK_QUOTA');assert.equal(f.current().id,id);assert.equal(f.counts().providerCalls,0);
  for(const mode of ['expired','pre-feature']){
   await f.mutateQuota(q=>mode==='expired'?{...q!,admissions:[]}:undefined);
   const result=await f.replay(kind==='preparation') as any;assert.equal(result.taskId,id);assert.deepEqual(await f.entries(),[]);assert.equal(f.counts().providerCalls,0);
  }
 }finally{await f.close();}
});
