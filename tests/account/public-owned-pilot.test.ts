import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {paidTaskAdmission,type PaidTaskQuota,type PublicPaidAccess} from '../../core/account/paid-task-quota.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const policy={mode:'owned-pilot' as const,accountId:owner,scopeId:'invented-pilot-1'};
const denied=(e:any)=>e.status===429&&(e.code??e.message)==='PAID_TASK_QUOTA';
async function directory(){await mkdir('.local/owned-pilot-tests',{recursive:true});return mkdtemp(join(process.cwd(),'.local/owned-pilot-tests/run-'));}
function proxyTransport(listen:()=>string,origin:string):typeof fetch{return (input,init)=>{
 const u=new URL(String(input)),headers=new Headers(init?.headers);headers.set('Host',new URL(origin).host);headers.set('X-Spindle-Proxy-Token','a'.repeat(64));headers.set('X-Spindle-Client','b'.repeat(64));
 return new Promise<Response>((resolve,reject)=>{
  const req=httpRequest(listen()+u.pathname+u.search,{method:init?.method??'GET',headers:Object.fromEntries(headers)},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const h=new Headers();for(const [n,v]of Object.entries(res.headers))if(v!==undefined)h.set(n,Array.isArray(v)?v.join(','):v);resolve(new Response(new Uint8Array(Buffer.concat(chunks)),{status:res.statusCode,headers:h}));});});req.on('error',reject);req.end(init?.body);
 });
};}

test('pilot consumes one durable identity forever, concurrently, in addition to existing daily quota',async()=>{
 const dir=await directory(),key=randomBytes(32);let now=1000000,creates=0;
 type S={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
 const store=new EncryptedStore<S>(dir,key,()=>({accounts:[{id:owner},{id:other}]}));
 const admission=()=>paidTaskAdmission(store,()=>now,policy);
 try{
  const results=await Promise.allSettled(['one','two'].map(identity=>admission()(owner,identity,()=>{creates++;return {id:identity};})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(creates,1);
  const winner=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value.id;
  now+=2*86400000;
  await assert.rejects(admission()(owner,'new-day',()=>{creates++;return {id:'new-day'};}),denied);
  await assert.rejects(admission()(other,'foreign',()=>{creates++;return {id:'foreign'};}),denied);
  await assert.rejects(paidTaskAdmission(store,()=>now,{...policy,accountId:other})(other,'foreign',()=>{creates++;return {id:'foreign'};}),denied);
  await admission().reconcile(owner,winner,winner);
  await assert.rejects(admission().reconcile(owner,'unadmitted','old-task'),denied);
  await assert.rejects(admission().reconcile(owner,winner,'foreign-task'),denied);
  assert.equal(creates,1);
  await store.transaction(s=>{assert.equal(s.accounts[0].paidTasks!.admissions.length,1);},false);
 }finally{await store.settle();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

test('pilot scopes cannot reset N4 daily unknowns, rolling window or clock rollback',async()=>{
 const dir=await directory(),key=randomBytes(32);let now=1000000,creates=0;
 type S={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
 const store=new EncryptedStore<S>(dir,key,()=>({accounts:[{id:owner}]}));
 const scoped=(scopeId:string)=>paidTaskAdmission(store,()=>now,{...policy,scopeId});
 try{
  await assert.rejects(paidTaskAdmission(store,()=>now)(owner,'legacy-unknown',()=>{throw Error('invented legacy crash');}));
  await scoped('scope-1')(owner,'one',()=>{creates++;return {id:'one'};});
  await assert.rejects(scoped('scope-2')(owner,'two',()=>{creates++;return {id:'two'};}),denied);
  now+=86400001;
  await scoped('scope-2')(owner,'two',()=>{creates++;return {id:'two'};});
  now--;
  await assert.rejects(scoped('scope-3')(owner,'three',()=>{creates++;return {id:'three'};}),denied);
  await scoped('scope-2').reconcile(owner,'two','two');assert.equal(creates,2);
  await store.transaction(s=>{const q=s.accounts[0].paidTasks!;assert.equal(q.admissions.length,2);assert.ok(q.admissions.some(a=>a.identity==='legacy-unknown'&&!a.taskId));assert.equal(q.pilots!.length,2);},false);
 }finally{await store.settle();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

test('unknown pilot survives create/bind interruption and restart; no adoption by reconcile or scope-history reset',async()=>{
 const dir=await directory(),key=randomBytes(32);let now=1000000;
 type S={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
 const initial=():S=>({accounts:[{id:owner}]});let store=new EncryptedStore<S>(dir,key,initial);
 const admit=(scope=policy)=>paidTaskAdmission(store,()=>now,scope);
 try{
  await assert.rejects(admit()(owner,'one',()=>{throw Error('invented create crash');}));
  store=new EncryptedStore<S>(dir,key,initial);now+=2*86400000;
  await assert.rejects(admit()(owner,'two',()=>({id:'two'})),denied);
  await assert.rejects(admit().reconcile(owner,'one','unbound-old-task'),denied);
  const original=store.transaction.bind(store);let writes=0;
  store.transaction=((...args:Parameters<typeof store.transaction>)=>++writes===2?Promise.reject(Error('invented bind crash')):original(...args)) as typeof store.transaction;
  await assert.rejects(admit()(owner,'one',()=>({id:'task-one'})));
  store.transaction=original;await assert.rejects(admit().reconcile(owner,'one','task-one'),denied);
  assert.equal((await admit()(owner,'one',()=>({id:'task-one'}))).id,'task-one');
  await admit().reconcile(owner,'one','task-one');
  // A new trusted operator scope is additive, never an erasure of the former scope.
  await admit({...policy,scopeId:'invented-pilot-2'})(owner,'two',()=>({id:'task-two'}));
  await assert.rejects(admit()(owner,'three',()=>({id:'task-three'})),denied);
  await assert.rejects(admit().reconcile(owner,'two','task-two'),denied);
 }finally{await store.settle();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

// Actual loopback HTTP, canonical HTTPS Host/Origin, trusted proxy headers, real
// password-authenticated accounts and CSRF. All Google/provider responses invented.
test('public defaults closed; only trusted exact account can prepare, mail stays off, retained unadmitted effects denied',async()=>{
 const dir=await directory(),key=randomBytes(32),tasks=new AgentStore(join(dir,'tasks.sqlite')),evidence=new EvidenceStore(join(dir,'evidence'));
 const accountDir=join(dir,'account'),origin='https://pilot.example.test';let sourceCalls=0,providerFactories=0,providerCalls=0,tools=0;
 const google={clientId:'invented-client',clientSecret:'invented-secret',http:async(input:Parameters<typeof fetch>[0])=>{
  const u=new URL(String(input));sourceCalls++;
  if(u.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',version:'1',trashed:false});
  if(u.pathname==='/drive/v3/files')return Response.json({files:[]});
  throw Error('Unexpected invented Google path');
 }};
 const prep={tasks,store:evidence,workspaceId:'account-private',buildIdentity:'invented',provider:()=>{providerFactories++;return {id:'invented',async next(){providerCalls++;throw Error('invented provider held');}};},tools:()=>{tools++;return [];}};
 const start=(access?:PublicPaidAccess)=>startTrackingServer(accountDir,key,0,origin,google,prep,undefined,undefined,undefined,{token:'a'.repeat(64)},access);
 let server=await start();
 const transport=proxyTransport(()=>server.listenOrigin,origin);
 const a=new AccountClient(origin,transport),b=new AccountClient(origin,transport);
 const request={connectionId:'invented',rootId:'root',request:'Invented local preparation',requestId:'one',processingConsent:true,saveOutputs:false};
 const noWork=()=>{assert.equal(sourceCalls,0);assert.equal(providerFactories,0);assert.equal(providerCalls,0);assert.equal(tools,0);for(const c of [a,b])assert.equal(tasks.tasks({workspaceId:'account-private',accountId:c.account!.id}).length,0);assert.equal((evidence.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as {n:number}).n,0);};
 try{
  await a.signin('invented-pilot-owner','invented-password-123',true);await b.signin('invented-other-owner','invented-password-123',true);
  for(const c of [a,b]){
   const config=await c.request('/preparation/config',{}) as any;assert.equal(config.configured,false);assert.equal(config.access,'connection-only');
   await assert.rejects(c.request('/preparation/request',request),(e:any)=>e.status===503);
   await assert.rejects(c.request('/mail/request',request),(e:any)=>e.code==='MAIL_NOT_CONFIGURED');
   await c.request('/google/list',{});
  }
  noWork();
  // Connection-only keeps the actual OAuth callback and root-selection APIs.
  const flow=await a.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await transport(callback)).status,200);
  await a.request('/google/roots',{connectionId:flow.connectionId,roots:['root']});
  sourceCalls=0;
  const paidStore=new EncryptedStore<any>(accountDir,key,()=>{throw Error('existing only');});
  await paidStore.transaction(s=>{assert.ok(s.accounts.every((v:any)=>v.paidTasks===undefined));},false);
  await server.close();
  const trusted={mode:'owned-pilot' as const,accountId:a.account!.id,scopeId:'invented-http-pilot'};
  server=await start(trusted);trusted.accountId=b.account!.id; // caller mutation must not change the running boundary
  assert.equal((await a.request('/preparation/config',{}) as any).access,'owned-pilot');
  const config=await b.request('/preparation/config',{}) as any;assert.equal(config.configured,false);assert.ok(!JSON.stringify(config).includes(a.account!.id));
  await assert.rejects(b.request('/preparation/request',{...request,accountId:a.account!.id,pilot:policy}),(e:any)=>e.status===403);
  for(const path of ['/preparation/correct','/preparation/resume','/preparation/save','/preparation/source','/preparation/browser-approve','/preparation/browser-reconcile'])await assert.rejects(b.request(path,{taskId:'invented-foreign-task'}),(e:any)=>e.status===403&&e.code==='PREPARATION_PUBLIC_PAID_ACCESS_DENIED');
  noWork();
  await assert.rejects(a.request('/preparation/request',{...request,accountId:a.account!.id,scopeId:'forged'}),(e:any)=>e.status===400);noWork();
  await assert.rejects(a.request('/preparation/request',{...request,processingConsent:false}),(e:any)=>e.status===400);noWork();
  await assert.rejects(a.request('/preparation/request',request));assert.equal(providerFactories,0); // no owned Google binding
  const valid={...request,connectionId:flow.connectionId};
  const receipt=await a.request('/preparation/request',valid) as any;
  for(let n=0;n<100;n++){const status=await a.request('/preparation/status',{taskId:receipt.taskId}) as any;if(status.state==='blocked'&&status.execution.state==='idle')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(providerFactories,1);assert.equal(providerCalls,1);
  // Bound Task continuation remains available under the same N4 admission.
  await a.request('/preparation/source',{taskId:receipt.taskId,operation:'list'});
  assert.ok(sourceCalls>0);
  const before={sourceCalls,providerFactories,providerCalls,tools};
  assert.equal((await a.request('/preparation/request',valid) as any).taskId,receipt.taskId);
  await assert.rejects(a.request('/preparation/request',{...valid,requestId:'two',request:'Different invented intent',newIntent:true}),denied);
  await assert.rejects(a.request('/mail/request',request),(e:any)=>e.code==='MAIL_NOT_CONFIGURED');
  await paidStore.transaction(s=>{const p=s.accounts.find((v:any)=>v.id===a.account!.id).paidTasks;assert.equal(p.admissions.length,1);p.pilots=[];});
  for(const path of ['/preparation/source','/preparation/resume','/preparation/browser-approve','/preparation/browser-reconcile'])await assert.rejects(a.request(path,{taskId:receipt.taskId}),denied);
  assert.deepEqual({sourceCalls,providerFactories,providerCalls,tools},before);
  // Real service/SQLite create succeeded, but encrypted bind commit is lost.
  // Restart must not adopt that unbound Task or automatically retry the provider.
  await server.close();
  const crashPolicy={mode:'owned-pilot' as const,accountId:a.account!.id,scopeId:'invented-crash-pilot'};
  server=await start(crashPolicy);
  const original=EncryptedStore.prototype.transaction;
  EncryptedStore.prototype.transaction=function(this:EncryptedStore<any>,fn:any,write=true){
   if(this.directory!==accountDir)return original.call(this,fn,write);
   return original.call(this,(s:any)=>{
    const result=fn(s);
    if(write&&s.accounts.some((v:any)=>v.paidTasks?.pilots?.some((p:any)=>p.scopeId===crashPolicy.scopeId&&p.taskId)))throw Error('invented bind crash');
    return result;
   },write);
  } as typeof original;
  const crashRequest={...valid,request:'Invented interrupted second task',requestId:'crash-task',newIntent:true};
  try{await assert.rejects(a.request('/preparation/request',crashRequest));}finally{EncryptedStore.prototype.transaction=original;}
  const crashed=tasks.preparationForRequest({workspaceId:'account-private',accountId:a.account!.id},'crash-task')!;assert.ok(crashed);
  await server.close();server=await start(crashPolicy);
  const heldBefore={sourceCalls,providerFactories,providerCalls,tools};
  assert.equal((await a.request('/preparation/status',{taskId:crashed.id}) as any).taskId,crashed.id);
  await assert.rejects(a.request('/preparation/request',crashRequest),denied);
  for(const path of ['/preparation/source','/preparation/resume','/preparation/browser-approve','/preparation/browser-reconcile'])await assert.rejects(a.request(path,{taskId:crashed.id}),denied);
  await assert.rejects(a.request('/preparation/request',{...crashRequest,request:'Third invented intent',requestId:'not-a-refund'}),denied);
  assert.deepEqual({sourceCalls,providerFactories,providerCalls,tools},heldBefore);
  await paidStore.transaction(s=>{const p=s.accounts.find((v:any)=>v.id===a.account!.id).paidTasks;assert.equal(p.admissions.length,2);assert.equal(p.pilots.find((v:any)=>v.scopeId===crashPolicy.scopeId).taskId,undefined);},false);
 }finally{await server.close();evidence.close();tasks.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
