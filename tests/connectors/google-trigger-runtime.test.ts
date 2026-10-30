import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startGoogleApplication} from '../../core/connectors/google/main.js';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign} from 'node:crypto';
import {startGoogleTriggerRuntime,type GoogleTriggerConfig,type GoogleTriggerAuthority} from '../../core/connectors/google/trigger-runtime.js';
import {AgentRuntime} from '../../core/agent/runtime.js';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const route={route:'mail',workspace:'owner-workspace',account:'invented@example.test',epoch:'epoch',subscription:'projects/demo/subscriptions/mail',audience:'https://receiver.example.test/google/push/mail',serviceAccountEmail:'push@demo.iam.gserviceaccount.com'};
const wait=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('finite fixture latch expired');};
function notification(id='delivery',claims:Record<string,unknown>={},account=route.account,receipt=Date.now()){
 const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:route.audience,email:route.serviceAccountEmail,email_verified:true,iat:now,exp:now+300,...claims})).toString('base64url');
 return new Request(route.audience,{method:'POST',headers:{authorization:`Bearer ${h}.${p}.${sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url')}`},body:JSON.stringify({subscription:route.subscription,message:{messageId:id,publishTime:new Date(receipt-10).toISOString(),data:Buffer.from(JSON.stringify({emailAddress:account,historyId:'999999'})).toString('base64')}})});
}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'google-trigger-')),tasks=new AgentStore(join(dir,'host-tasks'));
 const namespace={workspaceId:route.workspace,accountId:route.account};
 let credential:string|undefined=JSON.stringify({refreshToken:'invented-refresh',accountId:route.account,connectionEpoch:route.epoch,grants:[scopes.mail]});
 let ownerCurrent=true,schedulerRunning=true,receiverRunning=false,attached=0,watches=0,historyCalls=0,wakes=0,providerCalls=0;
 let available:string[]=[],bootstrap:string[]=[];
 let handle:((request:Request,receiptAt?:number)=>Promise<Response>)|undefined;
 let beforeRelevant:(message:any)=>Promise<void>=async()=>{};
 let schedulerHook:()=>void=()=>{};
 const credentials={get:async()=>credential,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(credential!==expected)return false;credential=value;return true;}};
 const http:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/certs'))return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256'}]});
  if(url.endsWith('/token')){const body=new URLSearchParams(String(init?.body));assert.equal(body.get('client_id'),'shared-web');assert.equal(body.get('client_secret'),'invented-web-secret');return Response.json({access_token:'invented-access'});}
  if(url.endsWith('/watch')){watches++;return Response.json({historyId:'999',expiration:String(Date.now()+7*86400000)});}
  if(url.endsWith('/profile'))return Response.json({emailAddress:route.account,historyId:available.length?'11':'10'});
  if(url.includes('/history?')){historyCalls++;return Response.json({historyId:'11',history:available.map(id=>({id:'11',messagesAdded:[{message:{id}}]}))});}
  if(url.includes('/messages?'))return Response.json({messages:bootstrap.map(id=>({id}))});
  const id=new URL(url).pathname.split('/').at(-1);return Response.json({id,internalDate:id==='old'?'1':'1000',labelIds:[],payload:{headers:[{name:'From',value:route.account},{name:'To',value:route.account}]}});
 };
 const oauth=new GoogleOAuth('shared-web',credentials,http,{clientSecret:'invented-web-secret'});
 const authority:GoogleTriggerAuthority={ownerId:'spindle-owner',connectionId:'shared-connection',workspaceId:route.workspace,accountId:route.account,connectionEpoch:route.epoch,oauth,assertCurrent:async signal=>{signal.throwIfAborted();if(!ownerCurrent)throw Error('owner authority changed');}};
 const config:GoogleTriggerConfig={dataDirectory:dir,route,mode:'push',topicName:'projects/demo-project/topics/mail',bootstrapSince:500,intervalMs:60000,relevant:async(message:any)=>{await beforeRelevant(message);return message.id==='unrelated'?undefined:'prepare';}};
 const receiver={attach:async(callback:NonNullable<typeof handle>)=>{attached++;handle=callback;receiverRunning=true;return {isRunning:()=>receiverRunning,stop:async()=>{receiverRunning=false;}};}};
 const scheduler={isRunning:()=>schedulerRunning,wake:()=>{wakes++;schedulerHook();}};
 let app:Awaited<ReturnType<typeof startGoogleTriggerRuntime>>|undefined;
 return {dir,tasks,namespace,authority,config,receiver,scheduler,http,
  start:async()=>app=await startGoogleTriggerRuntime(config,{authority,tasks,scheduler,receiver,http}),
  app:()=>app!,send:(id?:string,claims?:Record<string,unknown>,account?:string,at?:number)=>handle!(notification(id,claims,account,at),at),
  counts:()=>({attached,watches,historyCalls,wakes,providerCalls}),
  messages:(ids:string[])=>{available=ids;},bootstrap:(ids:string[])=>{bootstrap=ids;},
  relevant:(callback:typeof beforeRelevant)=>{beforeRelevant=callback;},schedulerHook:(callback:()=>void)=>{schedulerHook=callback;},
  owner:(current:boolean)=>{ownerCurrent=current;},schedulerRunning:(running:boolean)=>{schedulerRunning=running;},receiverRunning:(running:boolean)=>{receiverRunning=running;},
  credential:(change:Record<string,unknown>|undefined)=>{credential=change===undefined?undefined:JSON.stringify({...JSON.parse(credential!),...change});},
  dispatch:async()=>{for(const task of tasks.working(namespace,20))if(task.run.attempt===0)await new AgentRuntime(tasks,[]).run(task.id,{id:'finite-scripted-provider',next:async()=>{providerCalls++;return {kind:'ready',result:'invented prepared result'};}},1);},
  clean:async()=>{await app?.stop();tasks.close();rmSync(dir,{recursive:true,force:true});}
 };
}
function query(path:string,sql:string){const db=new DatabaseSync(path);try{return db.prepare(sql).get();}finally{db.close();}}

test('push immediately signals the existing scheduler after durable admission; bootstrap and ordinary durable task execution',async()=>{
 const f=fixture();let dispatch:Promise<void>|undefined,commitSeen=false;
 try {
  f.bootstrap(['old','unrelated']);await f.start();await wait(()=>!!f.app().status().service.lastSync);
  assert.equal(f.tasks.tasks(f.namespace).length,0);assert.equal(f.app().status().state,'running');
  f.schedulerHook(()=>{const task=f.tasks.working(f.namespace,10)[0];if(task){assert.equal(query(join(f.dir,'host-tasks'),'SELECT count(*) AS n FROM agent_tasks')!.n,1);commitSeen=true;f.app().observeDispatch(task.id);dispatch=f.dispatch();}});
  f.messages(['read-self-message','unrelated']);const before=performance.now(),receipt=Date.now();assert.equal((await f.send('push-1',{},undefined,receipt)).status,204);
  assert.equal(query(join(f.dir,'wakes.sqlite'),"SELECT count(*) AS n FROM google_delivery WHERE message='push-1'")!.n,1,'ACK follows durable delivery insertion');
  await wait(()=>f.tasks.tasks(f.namespace)[0]?.status==='ready');await dispatch;
  assert.ok(commitSeen);assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().historyCalls,1);assert.ok(performance.now()-before<60000,'must not wait for recovery interval');
  const status=f.app().status();assert.equal(status.lastAdmission?.disposition,'inserted');assert.equal(status.schedulerFailure,undefined);assert.ok(status.lastDispatch!.observedAt>=status.lastAdmission!.observedAt);assert.ok(status.service.lastIntake!.durableObservedAt>=receipt);assert.ok(status.service.latency.admissions.items[0].admittedAt>=receipt);assert.match(status.timingLabel,/Not model dispatch/);
  assert.equal(f.tasks.tasks(f.namespace)[0].sourceEvent.messageId,'read-self-message');
  await f.app().stop();assert.equal(f.app().status().state,'stopped');assert.equal(f.tasks.tasks(f.namespace).length,1,'bridge must not close host-owned tasks');
 }finally{await f.clean();}
});

test('duplicate/concurrent/out-of-order hints coalesce; reopen recovery retains cursor/task identity and wakes durable work',async()=>{
 const f=fixture();try{
  await f.start();await wait(()=>!!f.app().status().service.lastSync);f.messages(['one']);const now=Date.now();
  const responses=await Promise.all([f.send('newer',{},undefined,now),f.send('newer',{},undefined,now),f.send('older',{},undefined,now-100)]);assert.deepEqual(responses.map(r=>r.status),[204,204,204]);
  await wait(()=>f.tasks.tasks(f.namespace).length===1&&f.app().status().service.journal!==undefined&&(f.app().status().service.journal as {backlog:number}).backlog===0);
  const task=f.tasks.tasks(f.namespace)[0];assert.equal(f.counts().historyCalls,1);assert.equal((f.app().status().service.latency.receipt as {delivery:string}).delivery,'newer');
  await f.app().stop();assert.equal((await f.send()).status,503);
  const db=new DatabaseSync(join(f.dir,'wakes.sqlite'));db.prepare("UPDATE google_wake SET pending=pending+1").run();db.close();
  await f.start();await wait(()=>!!f.app().status().service.lastSync);assert.equal(f.tasks.tasks(f.namespace).length,1);assert.equal(f.tasks.tasks(f.namespace)[0].id,task.id);
  assert.equal(query(join(f.dir,'gmail.sqlite'),'SELECT cursor FROM google_cursor')!.cursor,'11','notification historyId must never become cursor');
  assert.ok(f.counts().wakes>=4,'startup and recovery notify host about retained work');
 }finally{await f.clean();}
});

test('durable intake fault is not ACKed; redelivery works and stopped scheduler retains admitted work',async()=>{
 const f=fixture();try{
  await f.start();await wait(()=>!!f.app().status().service.lastSync);f.schedulerRunning(false);f.messages(['queued']);const wakes=f.counts().wakes;
  const db=new DatabaseSync(join(f.dir,'wakes.sqlite'));db.exec("CREATE TRIGGER fail_intake BEFORE UPDATE ON google_wake BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
  assert.equal((await f.send('retry-me')).status,503);assert.equal(query(join(f.dir,'wakes.sqlite'),"SELECT count(*) AS n FROM google_delivery WHERE message='retry-me'")!.n,0);db.exec('DROP TRIGGER fail_intake');db.close();
  assert.equal((await f.send('retry-me')).status,204);await wait(()=>f.tasks.tasks(f.namespace).length===1);assert.equal(f.counts().wakes,wakes);assert.equal(f.app().status().state,'blocked');assert.equal(f.counts().providerCalls,0);
  await f.app().stop();f.schedulerRunning(true);f.schedulerHook(()=>{void f.dispatch();});await f.start();await wait(()=>f.tasks.tasks(f.namespace)[0]?.status==='ready');assert.equal(f.counts().providerCalls,1);
 }finally{await f.clean();}
});

test('wrong account/expired notification and wrong epoch/grant/revoke/owner cannot intake or admit late work',async()=>{
 for(const change of ['owner','epoch','account','grant','revoke'] as const){
  const f=fixture();let release!:()=>void,entered=false;
  try{
   await f.start();await wait(()=>!!f.app().status().service.lastSync);
   assert.equal((await f.send('expired',{exp:1})).status,400);assert.equal((await f.send('wrong',{},'wrong@example.test')).status,400);
   f.relevant(async()=>{entered=true;await new Promise<void>(r=>{release=r;});});f.messages(['late']);assert.equal((await f.send('before-change')).status,204);await wait(()=>entered);
   if(change==='owner')f.owner(false);else if(change==='revoke')f.credential(undefined);else f.credential(change==='epoch'?{connectionEpoch:'reconnected'}:change==='account'?{accountId:'wrong@example.test'}:{grants:[]});
   release();await wait(()=>!!f.app().status().service.failure);assert.equal(f.tasks.tasks(f.namespace).length,0,change);assert.equal((await f.send('after-change')).status,503);assert.equal(query(join(f.dir,'gmail.sqlite'),'SELECT cursor FROM google_cursor')!.cursor,'10');assert.ok((f.app().status().service.journal as {backlog:number}).backlog>0);
  }finally{release?.();await f.clean();}
 }
});

test('requires current owner/provider/receiver capability before watch; receiver loss and scheduler failure are not running',async()=>{
 const f=fixture();try{
  await assert.rejects(startGoogleTriggerRuntime(f.config,{authority:f.authority,tasks:f.tasks,scheduler:f.scheduler,http:f.http}),/receiver configuration required/);assert.equal(f.counts().watches,0);
  f.owner(false);await assert.rejects(f.start(),/owner authority changed/);assert.equal(f.counts().attached,0);f.owner(true);
  const invalid={...f.config,topicName:undefined};await assert.rejects(startGoogleTriggerRuntime(invalid,{authority:f.authority,tasks:f.tasks,scheduler:f.scheduler,receiver:f.receiver,http:f.http}),/Push requires topic/);assert.equal(f.counts().attached,0);
  await f.start();await wait(()=>!!f.app().status().service.lastSync);f.receiverRunning(false);assert.equal(f.app().status().state,'needs_configuration');assert.equal(f.app().status().running,false);f.receiverRunning(true);
  f.schedulerHook(()=>{throw Error('fixture scheduler failure');});f.messages(['pending']);await f.send('scheduler-fault');await wait(()=>f.tasks.tasks(f.namespace).length===1);assert.equal(f.app().status().state,'blocked');assert.match(f.app().status().schedulerFailure!,/durable tasks retained/);
 }finally{await f.clean();}
});

test('admission telemetry failure cannot swallow scheduler notification; stopping cancels late relevance',async()=>{
 const f=fixture();let entered=false,release!:()=>void;
 try{
  await f.start();await wait(()=>!!f.app().status().service.lastSync);
  const db=new DatabaseSync(join(f.dir,'wakes.sqlite'));db.exec("CREATE TRIGGER fail_metric BEFORE INSERT ON google_admission BEGIN SELECT RAISE(ABORT,'fixture metric failure'); END");db.close();
  f.messages(['committed']);await f.send('metric-fault');await wait(()=>!!f.app().status().lastAdmission);assert.ok(f.app().status().lastSchedulerNotification);assert.equal(f.app().status().service.latency.admissions.total,0);assert.equal(f.tasks.tasks(f.namespace).length,1);
  f.relevant(async()=>{entered=true;await new Promise<void>(r=>{release=r;});});f.messages(['late-stop']);await f.send('stop-during-relevance');await wait(()=>entered);await f.app().stop();release();await new Promise(r=>setImmediate(r));assert.equal(f.tasks.tasks(f.namespace).length,1);assert.throws(()=>f.app().observeDispatch(f.tasks.tasks(f.namespace)[0].id),/stopped/);
 }finally{release?.();await f.clean();}
});

test('receiver mounts before watching; failed watch registration never reports running',async()=>{
 const f=fixture();let app:Awaited<ReturnType<typeof startGoogleTriggerRuntime>>|undefined,mounted=false;
 try{
  app=await startGoogleTriggerRuntime(f.config,{authority:f.authority,tasks:f.tasks,scheduler:f.scheduler,http:async(input,init)=>String(input).endsWith('/watch')?new Response(null,{status:403}):f.http(input,init),receiver:{attach:async handle=>{assert.equal(f.counts().watches,0);assert.equal((await handle(notification())).status,503);mounted=true;return {isRunning:()=>mounted,stop:async()=>{mounted=false;}};}}});
  assert.equal(app.status().state,'configured');assert.equal(app.status().running,false);await wait(()=>!!app!.status().service.lastSync);assert.equal(app.status().watching,false);assert.equal(app.status().state,'blocked');assert.match(app.status().service.watchFailure!,/403/);
 }finally{await app?.stop();await f.clean();}
});

test('explicit local mode requires no receiver and initial stale epoch/grant is denied before mounting',async()=>{
 const f=fixture();try{
  f.credential({connectionEpoch:'wrong'});await assert.rejects(f.start(),/connection changed/);assert.equal(f.counts().attached,0);f.credential({connectionEpoch:route.epoch,grants:[]});await assert.rejects(f.start(),/connection changed/);assert.equal(f.counts().watches,0);
  f.credential({grants:[scopes.mail]});const app=await startGoogleTriggerRuntime({...f.config,mode:'local'},{authority:f.authority,tasks:f.tasks,scheduler:f.scheduler,http:f.http});
  try{await wait(()=>!!app.status().service.lastSync);assert.equal(app.status().state,'running');assert.equal(app.status().watching,false);assert.equal(f.counts().watches,0);assert.throws(()=>app.observeDispatch('foreign-task'),/unavailable/);}finally{await app.stop();}
 }finally{await f.clean();}
});

for(const cancellation of ['caller','stop'] as const)test(`dispatch currentness check bounds noncooperative authority on ${cancellation} and rejects foreign tasks before authority reads`,async()=>{
 const f=fixture();let hold=false,entered=false,checks=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.authority.assertCurrent=async signal=>{checks++;signal.throwIfAborted();if(hold){entered=true;await gate;}};
 try{
  await f.start();await wait(()=>!!f.app().status().service.lastSync);
  const task=f.tasks.admit({...f.namespace,messageId:'dispatch-check',outcome:'prepare'},20),controller=new AbortController();
  const before=checks;await assert.rejects(f.app().assertDispatchCurrent('foreign-task',controller.signal),/unavailable/);assert.equal(checks,before);
  hold=true;const pending=f.app().assertDispatchCurrent(task.id,controller.signal);const rejected=assert.rejects(pending,/abort/i);await wait(()=>entered);
  if(cancellation==='caller')controller.abort();else await f.app().stop();
  await rejected;release();await new Promise(r=>setImmediate(r));assert.equal(f.tasks.get(task.id).run.attempt,0);assert.equal(f.counts().providerCalls,0);assert.equal(f.app().status().lastDispatch,undefined);
 }finally{release();await f.clean();}
});

test('launcher uses injected backend Web OAuth and the host task store, not a second local OAuth client',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-trigger-web-')),tasks=new AgentStore(join(dir,'host-tasks'));let app:Awaited<ReturnType<typeof startGoogleApplication>>|undefined,refreshes=0;
 let raw=JSON.stringify({refreshToken:'invented-refresh',accountId:route.account,connectionEpoch:route.epoch,grants:[scopes.mail]});
 const credentials={get:async()=>raw,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(raw!==expected)return false;raw=value;return true;}};
 const http:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/token')){const body=new URLSearchParams(String(init?.body));assert.equal(body.get('client_id'),'shared-web');assert.equal(body.get('client_secret'),'invented-web-secret');refreshes++;return Response.json({access_token:'invented-access'});}if(url.endsWith('/profile'))return Response.json({emailAddress:route.account,historyId:'10'});if(url.includes('/messages?'))return Response.json({messages:[{id:'self-addressed-read'}]});return Response.json({id:'self-addressed-read',internalDate:'1000',labelIds:[],payload:{headers:[{name:'From',value:route.account},{name:'To',value:route.account}]}});};
 const oauth=new GoogleOAuth('shared-web',credentials,http,{clientSecret:'invented-web-secret'});
 try {
  app=await startGoogleApplication({clientId:'wrong-local-client',dataDirectory:dir,connectionId:'connection',route,mode:'local',bootstrapSince:500,intervalMs:60000,relevant:async()=> 'prepare'}, {oauth,http,tasks});
  await wait(()=>!!app!.status().lastSync||!!app!.status().failure);
  assert.equal(app.status().failure,undefined,'shared Web refresh must be used');assert.equal(refreshes,1);assert.equal(tasks.working({workspaceId:route.workspace,accountId:route.account},10).length,1);
 }finally{await app?.stop();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
