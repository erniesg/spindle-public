import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startPreparationAccount,type PreparationAccountConfig} from '../../core/preparation/startup.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import {MailService} from '../../core/mail/service.js';

// Real encrypted account + SQLite + startup/provider/runtime/draft tools over
// loopback HTTP with canonical HTTPS Host/Origin and trusted proxy admission.
// External Google/model transports are scripted and forbid every mailbox write.
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'owned-mail-')),key=randomBytes(32),accountDir=join(dir,'account'),budgetPath=join(dir,'invented-budget.json'),origin='https://pilot.example.test';
 let googleCalls=0,modelCalls=0,credentials=0;
 const model={provider:'nebius' as const,id:'invented',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:.06,outputUsdPerMillion:.24,verifiedAt:'2026-10-26',source:'https://example.test/invented-pricing'}};
 const config:PreparationAccountConfig={directory:accountDir,key,publicOrigin:origin,publicProxy:{token:'a'.repeat(64)},budgetPath,sourceIdentity:{revision:'a'.repeat(40)},buildIdentity:'invented-owned-mail',decisionModel:model,visionModel:{...model,images:{inputTokensUpperBound:16000,accounting:'input-tokens'}},credential:async()=>{credentials++;return 'invented-model-key';},google:{clientId:'invented-client',clientSecret:'invented-secret',http:async input=>{
  googleCalls++;const u=new URL(String(input));
  if(u.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  throw Error('No external Google source/write/Send authorized in this test');
 }},modelTransport:async(_input,init)=>{
  modelCalls++;const state=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  // No provider transport (and thus no scripted budget settlement) before the
  // SAME encrypted admission has a durably bound Task for this exact event.
  await store.transaction(s=>{const q=s.accounts.find((a:any)=>a.id===state.untrustedTask.sourceEvent.accountId).paidTasks;assert.equal(q.pilots.length,1);assert.ok(q.pilots[0].taskId);assert.equal(q.pilots[0].taskId,q.admissions[0].taskId);assert.equal(q.pilots[0].identity,q.admissions[0].identity);},false);
  const next_action=state.untrustedTask.observations.some((o:any)=>o.data?.state==='local_draft')?{kind:'ready',result:'Draft retained for review'}:{kind:'tool',name:'mail.draft.create',args:{content:{to:[{address:'recipient@example.test'}],subject:'Invented owned draft',text:'Invented application for owner review.'},provenanceIds:[]}};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action})}}],usage:{prompt_tokens:100,completion_tokens:50}});
 }};
 let server=await startPreparationAccount(config);
 const transport:typeof fetch=(input,init)=>new Promise((resolve,reject)=>{
  const u=new URL(String(input)),headers=new Headers(init?.headers);headers.set('Host',new URL(origin).host);headers.set('X-Spindle-Proxy-Token','a'.repeat(64));headers.set('X-Spindle-Client','b'.repeat(64));
  const req=httpRequest(server.listenOrigin+u.pathname+u.search,{method:init?.method??'GET',headers:Object.fromEntries(headers)},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const h=new Headers();for(const [n,v]of Object.entries(res.headers))if(v!==undefined)h.set(n,Array.isArray(v)?v.join(','):v);resolve(new Response(new Uint8Array(Buffer.concat(chunks)),{status:res.statusCode,headers:h}));});});req.on('error',reject);req.end(init?.body);
 });
 const a=new AccountClient(origin,transport),b=new AccountClient(origin,transport);
 const store=new EncryptedStore<any>(accountDir,key,()=>{throw Error('Existing invented accounts only');});
 try{
  await a.signin('invented-mail-owner','invented-password-123',true);await b.signin('invented-mail-other','invented-password-123',true);
  const policy={mode:'owned-pilot' as const,accountId:a.account!.id,scopeId:'invented-one-task'};
  const flow=await a.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await transport(callback)).status,200);
  await a.request('/google/roots',{connectionId:flow.connectionId,roots:['invented-root']});
  await writeFile(budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:.25,reservedWorstCase:0,observedSpend:0,requests:[]}));
  const counts=()=>({googleCalls,modelCalls,credentials});
  const request={connectionId:flow.connectionId,requestId:'owned-one',request:'Prepare an invented email for review',processingConsent:true};
  return {a,b,config,policy,request,store,accountDir,counts,budget:()=>readFile(budgetPath,'utf8'),tasks:()=>new AgentStore(join(accountDir,'preparation','tasks.sqlite')),
   async start(mailEnabled?:boolean){await server.close();server=await startPreparationAccount({...config,publicPaidAccess:policy,mailEnabled});},
   async close(){await server.close();await store.settle();key.fill(0);await rm(dir,{recursive:true,force:true});}};
 }catch(e){await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});throw e;}
}
const quota=(e:any)=>e.status===429&&e.code==='PAID_TASK_QUOTA';

test('trusted public owned-pilot needs explicit mailtrue; one actual local draft, replay/restart and cross-kind permanent scope',async()=>{
 const f=await fixture();try{
  const before=f.counts(),budget=await f.budget();
  await assert.rejects(f.a.mailAction('request',f.request),(e:any)=>e.code==='MAIL_NOT_CONFIGURED');
  for(const mailEnabled of [undefined,false]){await f.start(mailEnabled);await assert.rejects(f.a.mailAction('request',f.request),(e:any)=>e.code==='MAIL_NOT_CONFIGURED');}
  assert.deepEqual(f.counts(),before);assert.equal(await f.budget(),budget);
  await f.store.transaction(s=>assert.ok(s.accounts.every((a:any)=>!a.paidTasks)),false);
  await f.start(true);
  const config=await f.a.mailAction('config') as any;assert.equal(config.configured,true);assert.ok(!JSON.stringify(config).includes(f.policy.accountId));assert.ok(!JSON.stringify(config).includes(f.policy.scopeId));
  const receipt=await f.a.mailAction('request',f.request) as any;let status:any;
  for(let i=0;i<200;i++){status=await f.a.mailAction('status',{taskId:receipt.taskId});if(status.execution==='idle')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(status.state,'ready');assert.equal(status.drafts.length,1);
  const view=await f.a.mailAction('draft',{taskId:receipt.taskId,draft:status.drafts[0].draft}) as any;assert.equal(view.sender,'invented@example.test');assert.equal(view.content.subject,'Invented owned draft');assert.deepEqual(view.content.to,[{address:'recipient@example.test'}]);assert.equal(view.publish,null);assert.equal(view.send,null);assert.equal(f.counts().modelCalls,2);
  const tasks=f.tasks();try{assert.equal(tasks.tasks({workspaceId:'account-private',accountId:f.a.account!.id}).length,1);}finally{tasks.close();}
  const after=f.counts(),afterBudget=await f.budget();
  assert.equal((await f.a.mailAction('request',f.request) as any).taskId,receipt.taskId);
  // Expire daily timestamps (>24h) without changing the permanent scope/history.
  await f.store.transaction(s=>{const q=s.accounts.find((a:any)=>a.id===f.policy.accountId).paidTasks;for(const a of q.admissions)a.at-=2*86400000;});
  await f.start(true);
  assert.equal((await f.a.mailAction('request',f.request) as any).taskId,receipt.taskId);
  await assert.rejects(f.a.mailAction('request',{...f.request,requestId:'second'}),quota);
  await assert.rejects(f.a.request('/preparation/request',{...f.request,requestId:'prep-second',rootId:'invented-root',saveOutputs:false}),quota);
  assert.deepEqual(f.counts(),after);assert.equal(await f.budget(),afterBudget);
 }finally{await f.close();}
});

test('other public account mail new/continuations/config deny before any effects and preserve browser auth',async()=>{
 const f=await fixture();try{
  await f.start(true);const before=f.counts(),budget=await f.budget();
  for(const path of ['config','request','list','sources','status','draft','edit','publish','send','reconcile','cancel'] as const){
   await assert.rejects(f.b.mailAction(path,{...f.request,taskId:'not-owned',accountId:f.policy.accountId,publicPaidAccess:f.policy}),(e:any)=>{assert.equal(e.status,403);assert.equal(e.code,'MAIL_PUBLIC_PAID_ACCESS_DENIED');assert.ok(!e.message.includes(f.policy.accountId));assert.ok(!e.message.includes(f.policy.scopeId));return true;});
   assert.ok(f.b.account);assert.equal((await f.b.request('/session') as any).account.id,f.b.account!.id);
  }
  // Also exercise the actual server-constructed service directly: its binding
  // must reject a foreign owner before even resolving a Google session/grant.
  const handle=MailService.prototype.handle;let service:MailService|undefined;
  MailService.prototype.handle=function(...args){service=this;return handle.apply(this,args);};
  try{await f.a.mailAction('config');}finally{MailService.prototype.handle=handle;}
  assert.ok(service);
  await assert.rejects(service.handle(f.b.account!.id,'not-a-google-session','/mail/request',f.request),(e:any)=>e.status===403&&e.message==='MAIL_PUBLIC_PAID_ACCESS_DENIED');
  // Browser-body policy cannot select or broaden the owner boundary either.
  await assert.rejects(f.a.mailAction('request',{...f.request,publicPaidAccess:f.policy}),(e:any)=>e.status===400);
  assert.deepEqual(f.counts(),before);assert.equal(await f.budget(),budget);
  await f.store.transaction(s=>assert.ok(s.accounts.every((a:any)=>!a.paidTasks)),false);
  const tasks=f.tasks();try{assert.equal(tasks.tasks({workspaceId:'account-private',accountId:f.a.account!.id}).length,0);assert.equal(tasks.tasks({workspaceId:'account-private',accountId:f.b.account!.id}).length,0);}finally{tasks.close();}
 }finally{await f.close();}
});

test('public mail failed durable binding holds UNKNOWN across restart; no unadmitted Task adoption or cross-kind refund',async()=>{
 const f=await fixture();const original=EncryptedStore.prototype.transaction;
 try{
  await f.start(true);const before=f.counts(),budget=await f.budget();
  EncryptedStore.prototype.transaction=function(this:EncryptedStore<any>,fn:any,write=true){
   if(this.directory!==f.accountDir)return original.call(this,fn,write);
   return original.call(this,(s:any)=>{const result=fn(s);if(write&&s.accounts.some((a:any)=>a.paidTasks?.pilots?.some((p:any)=>p.taskId)))throw Error('Invented post-create bind failure');return result;},write);
  } as typeof original;
  try{await assert.rejects(f.a.mailAction('request',f.request),(e:any)=>e.status===503);}finally{EncryptedStore.prototype.transaction=original;}
  const tasks=f.tasks();let taskId:string;try{const saved=tasks.tasks({workspaceId:'account-private',accountId:f.a.account!.id});assert.equal(saved.length,1);taskId=saved[0].id;}finally{tasks.close();}
  await f.store.transaction(s=>{const q=s.accounts.find((a:any)=>a.id===f.policy.accountId).paidTasks;assert.equal(q.pilots[0].taskId,undefined);assert.equal(q.admissions[0].taskId,undefined);q.admissions[0].at-=2*86400000;});
  await f.start(true);assert.equal((await f.a.mailAction('status',{taskId}) as any).taskId,taskId);
  await assert.rejects(f.a.mailAction('request',f.request),quota);
  for(const action of ['edit','publish','send','reconcile'] as const)await assert.rejects(f.a.mailAction(action,{taskId}),quota);
  await assert.rejects(f.a.mailAction('request',{...f.request,requestId:'no-refund'}),quota);
  await assert.rejects(f.a.request('/preparation/request',{...f.request,requestId:'no-prep-refund',rootId:'invented-root',saveOutputs:false}),quota);
  assert.deepEqual(f.counts(),before);assert.equal(await f.budget(),budget);
 }finally{EncryptedStore.prototype.transaction=original;await f.close();}
});

test('one public scope consumed by preparation cannot admit mail after restart or 24h',async()=>{
 const f=await fixture();try{
  await f.start(true);
  const prep=await f.a.request('/preparation/request',{...f.request,requestId:'prep-first',rootId:'invented-root',saveOutputs:false}) as any;
  for(let i=0;i<200;i++){const status=await f.a.request('/preparation/status',{taskId:prep.taskId}) as any;if(status.execution.state==='idle')break;await new Promise(r=>setTimeout(r,5));}
  await f.store.transaction(s=>{const q=s.accounts.find((a:any)=>a.id===f.policy.accountId).paidTasks;assert.equal(q.pilots[0].taskId,prep.taskId);assert.ok(q.pilots[0].identity.includes('preparation:prep-first'));q.admissions[0].at-=2*86400000;});
  await f.start(true);const before=f.counts(),budget=await f.budget();
  await assert.rejects(f.a.mailAction('request',f.request),quota);
  assert.deepEqual(f.counts(),before);assert.equal(await f.budget(),budget);
  const tasks=f.tasks();try{assert.deepEqual(tasks.tasks({workspaceId:'account-private',accountId:f.a.account!.id}).map(t=>t.id),[prep.taskId]);}finally{tasks.close();}
 }finally{await f.close();}
});

test('direct public server defaults/connection-only reject mail configuration before account store creation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'closed-mail-')),key=randomBytes(32);try{
  for(const policy of [undefined,{mode:'connection-only'} as const])await assert.rejects(startTrackingServer(join(dir,'account'),key,0,'https://pilot.example.test',undefined,undefined,{} as any,undefined,undefined,undefined,policy),/PUBLIC_PILOT_MAIL_DISABLED/);
  // No service constructor, provider or quota can be reached by either path.
  const {lstat}=await import('node:fs/promises');await assert.rejects(lstat(join(dir,'account')),(e:any)=>e.code==='ENOENT');
 }finally{key.fill(0);await rm(dir,{recursive:true,force:true});}
});
