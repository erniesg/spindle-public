import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {startAgentApplication,type AgentApplicationConfig} from '../../core/agent/startup.js';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {contextTools} from '../../core/memory/tools.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import type {ToolDefinition} from '../../core/agent/contracts.js';

const ns={workspaceId:'owner-workspace',accountId:'invented@example.test'};
const route={route:'mail',workspace:ns.workspaceId,account:ns.accountId,epoch:'epoch',subscription:'projects/demo/subscriptions/mail',audience:'https://receiver.example.test/google/push/mail',serviceAccountEmail:'push@demo.iam.gserviceaccount.com'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const wait=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'fixture outcome must not wait for the 60-second poll');};
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'startup-trigger-')),budgetPath=join(directory,'budget.json');
 writeFileSync(budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));writeFileSync(join(directory,'statement.txt'),'Invented account 0012345');
 let messages:string[]=['bootstrap'],modelCalls=0,refreshes=0,watches=0,attached=false,receiverStopFailure=false,ownerCurrent=true;
 let raw=JSON.stringify({refreshToken:'invented-refresh',accountId:ns.accountId,connectionEpoch:route.epoch,grants:[scopes.mail]});
 let handle:((request:Request,receiptAt?:number)=>Promise<Response>)|undefined;
 const credentials={get:async()=>raw,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(raw!==expected)return false;raw=value;return true;}};
 const http:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/certs'))return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256'}]});
  if(url.endsWith('/token')){const body=new URLSearchParams(String(init?.body));assert.equal(body.get('client_id'),'shared-web');assert.equal(body.get('client_secret'),'invented-secret');refreshes++;return Response.json({access_token:'invented-access'});}
  if(url.endsWith('/watch')){watches++;assert.equal(attached,true);return Response.json({historyId:'999',expiration:String(Date.now()+7*86400000)});}
  if(url.endsWith('/profile'))return Response.json({emailAddress:ns.accountId,historyId:messages.length?'11':'10'});
  if(url.includes('/messages?'))return Response.json({messages:messages.map(id=>({id}))});
  if(url.includes('/history?'))return Response.json({historyId:'11',history:messages.map(id=>({id:'11',messagesAdded:[{message:{id}}]}))});
  return Response.json({id:new URL(url).pathname.split('/').at(-1),internalDate:'1000',labelIds:[]});
 };
 const oauth=new GoogleOAuth('shared-web',credentials,http,{clientSecret:'invented-secret'});
 const google={connectionId:'connection',dataDirectory:directory,mode:'local' as const,bootstrapSince:500,intervalMs:60000,route,relevant:async()=> 'prepare invented statement'};
 const config:AgentApplicationConfig={google,namespace:ns,budgetPath,model:{provider:'nebius',id:'invented-model',inputContextTokens:32768,maxOutputTokens:512,text:true,jsonObject:true,pricing:{inputUsdPerMillion:0.1,outputUsdPerMillion:0.1,source:'https://example.test/pricing',verifiedAt:'2026-10-25T00:00:00Z'}},credential:async()=> 'invented',
  tools:evidence=>contextTools(evidence,{selected:directory},{statement:{rootId:'selected',path:'statement.txt',mimeType:'text/plain'}}),scope:{sources:[],destinations:[],grants:['files.read','files.root:selected']},maxTurns:3,timeoutMs:2000,pollMs:60000,googleDependencies:{oauth,http},
  modelTransport:async(_input,init)=>{modelCalls++;const envelope=JSON.parse(String(init!.body)),{untrustedTask:task,registeredTools}=JSON.parse(envelope.messages[1].content);assert.ok(registeredTools.some((t:{name:string})=>t.name==='files.read'));return Response.json({choices:[{message:{content:JSON.stringify({next_action:task.observations.length?{kind:'ready',result:'Prepared '+task.observations[0].data.text}:{kind:'tool',name:'files.read',args:{selectionId:'statement'}}})},finish_reason:'stop'}]});}};
 return {directory,config,google,http,oauth,counts:()=>({modelCalls,refreshes,watches}),messages:(ids:string[])=>{messages=ids;},
  triggerConfig:()=>{
   const {google:legacy,...common}=config;
   return {...common,trigger:{config:{...legacy,mode:'push' as const,topicName:'projects/demo-project/topics/mail'},authority:{ownerId:'spindle-owner',connectionId:'connection',workspaceId:ns.workspaceId,accountId:ns.accountId,connectionEpoch:route.epoch,oauth,assertCurrent:async(signal:AbortSignal)=>{signal.throwIfAborted();if(!ownerCurrent)throw Error('Standing owner authority revoked');}},receiver:{attach:async(callback:NonNullable<typeof handle>)=>{handle=callback;attached=true;return {isRunning:()=>attached,stop:async()=>{attached=false;if(receiverStopFailure)throw Error('fixture receiver close failure');}};}}}};
  },
  send:async(id='notification',receiptAt=Date.now())=>{
   const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:route.audience,email:route.serviceAccountEmail,email_verified:true,iat:now,exp:now+300})).toString('base64url');
   return handle!(new Request(route.audience,{method:'POST',headers:{authorization:`Bearer ${h}.${p}.${sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url')}`},body:JSON.stringify({subscription:route.subscription,message:{messageId:id,data:Buffer.from(JSON.stringify({emailAddress:ns.accountId,historyId:'999999'})).toString('base64')}})}),receiptAt);
  },receiverStopFailure:(fail:boolean)=>{receiverStopFailure=fail;},
  owner:(current:boolean)=>{ownerCurrent=current;},
  credential:(change:Record<string,unknown>|undefined)=>{raw=change===undefined?'':JSON.stringify({...JSON.parse(raw),...change});},
  clean:()=>rmSync(directory,{recursive:true,force:true})};
}

test('normal startup uses actual push bridge/Web OAuth/same store/registry, immediate model turn observes file result; reopen dedup',async()=>{
 const f=fixture();f.messages([]);let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{
  const config=f.triggerConfig();config.trigger.config.relevant=async(message:unknown)=>(message as {id:string}).id==='unrelated'?undefined:'prepare';
  app=await startAgentApplication(config);assert.equal(app.google,undefined);assert.ok(app.trigger);await wait(()=>!!app!.trigger!.status().service.lastSync);assert.equal(f.counts().watches,1);
  f.messages(['self-addressed-read','unrelated']);const receipt=Date.now();assert.deepEqual((await Promise.all([f.send('newer',receipt),f.send('older',receipt-100),f.send('newer',receipt)])).map(r=>r.status),[204,204,204]);
  await wait(()=>app!.tasks.tasks(ns)[0]?.status==='ready');const task=app.tasks.tasks(ns)[0];assert.equal(app.tasks.tasks(ns).length,1);assert.equal(task.sourceEvent.messageId,'self-addressed-read');assert.match(task.currentResult!,/0012345/);assert.equal(f.counts().modelCalls,2);assert.ok(f.counts().refreshes>=2);
  assert.equal(app.evidence.read(ns,task.observations[0].artifacts[0].id).toString(),'Invented account 0012345');assert.equal(app.sessions.list(ns,task.id).length,2);
  const status=app.trigger.status();assert.equal(status.lastDispatch?.taskId,task.id);assert.ok(status.lastDispatch!.observedAt>=receipt);assert.equal(status.service.latency.admissions.items[0].taskId,task.id);assert.equal(app.budget.snapshot().calls,2);
  await wait(()=>(app!.trigger!.status().service.journal as {backlog:number}).backlog===0);
  await app.stop();const calls=f.counts().modelCalls;app=await startAgentApplication(config);await new Promise(r=>setTimeout(r,30));assert.equal(app.trigger!.status().service.failure,undefined);assert.equal(f.counts().modelCalls,calls);assert.equal(app.tasks.tasks(ns)[0].id,task.id);assert.equal(app.trigger!.status().lastDispatch,undefined);
 }finally{await app?.stop();f.clean();}
});

for(const change of ['owner','epoch','account','grant','revoke','unchanged'] as const)test(`queued trigger task rechecks ${change} authority after asynchronous task binding before any model dispatch`,async()=>{
 const f=fixture();f.messages([]);let entered=false,closed=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 const config=f.triggerConfig();config.taskTools=async()=>{entered=true;await gate;return {tools:[],close:async()=>{closed++;}};};
 try{
  app=await startAgentApplication(config);await wait(()=>!!app!.trigger!.status().service.lastSync);f.messages(['queued']);await f.send('queued');await wait(()=>entered);
  const task=app.tasks.tasks(ns)[0];assert.equal(task.run.attempt,0);assert.equal(f.counts().modelCalls,0);
  if(change==='owner')f.owner(false);else if(change==='revoke')f.credential(undefined);else if(change!=='unchanged')f.credential(change==='epoch'?{connectionEpoch:'new-epoch'}:change==='account'?{accountId:'other@example.test'}:{grants:[]});
  release();await wait(()=>app!.tasks.get(task.id).status!=='working');const result=app.tasks.get(task.id);
  assert.equal(result.status,change==='unchanged'?'ready':'blocked');assert.equal(closed,1);
  if(change!=='unchanged'){
   assert.equal(result.run.attempt,0);assert.equal(result.recovery,'clean');assert.match(result.blocker!,/trigger authorization/i);assert.equal(f.counts().modelCalls,0);assert.equal(app.sessions.list(ns,task.id).length,0);assert.equal(app.budget.snapshot().calls,0);assert.equal(app.trigger!.status().lastDispatch,undefined);assert.equal(app.status().stopped,false);
   f.owner(true);for(let i=0;i<3;i++)app.wake();await new Promise(r=>setTimeout(r,20));assert.equal(app.tasks.get(task.id).status,'blocked','wake is not owner continuation');
  }else{assert.equal(f.counts().modelCalls,2);assert.equal(app.trigger!.status().lastDispatch?.taskId,task.id);}
 }finally{release();await app?.stop();f.clean();}
});

for(const cancellation of ['explicit','timeout'] as const)test(`pending bridge wake survives ${cancellation} and actual noncooperative tool drain without concurrent task dispatch`,async()=>{
 const f=fixture();f.messages([]);let entered=false,release!:()=>void,settled=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 const tools=f.config.tools;f.config.timeoutMs=cancellation==='timeout'?150:2000;
 f.config.tools=async(evidence,host)=>(await tools(evidence,host)).map(tool=>tool.name==='files.read'?{...tool,invoke:async(args,context)=>{
  if(!entered){entered=true;await gate;assert.equal(context.signal.aborted,true);assert.equal(evidence.db.prepare('SELECT 1 AS open').get()!.open,1);settled=true;}
  return tool.invoke(args,context);
 }}:tool);
 try{
  app=await startAgentApplication(f.triggerConfig());await wait(()=>!!app!.trigger!.status().service.lastSync);f.messages(['first']);await f.send('first');await wait(()=>entered);const first=app.tasks.tasks(ns)[0];
  if(cancellation==='explicit')app.cancelTask(first.id);await wait(()=>app!.tasks.get(first.id).status==='cancelled');
  f.messages(['second']);await f.send('second');await wait(()=>app!.tasks.tasks(ns).length===2);for(let i=0;i<5;i++)app.wake();await new Promise(r=>setTimeout(r,30));
  const second=app.tasks.tasks(ns).find(t=>t.sourceEvent.messageId==='second')!;assert.equal(second.run.attempt,0);assert.equal(f.counts().modelCalls,1);assert.equal(settled,false);assert.equal(app.trigger!.status().lastDispatch!.taskId,first.id);
  release();await wait(()=>app!.tasks.get(second.id).status==='ready');assert.equal(settled,true);assert.equal(app.tasks.get(first.id).observations.length,0);assert.equal(app.trigger!.status().lastDispatch!.taskId,second.id);assert.equal(f.counts().modelCalls,3);
 }finally{release();await app?.stop();f.clean();}
});

test('startup wake selects only unattempted owned work and fences uncertain/cancelled/foreign tasks and exclusive ownership',async()=>{
 const f=fixture();f.messages([]);const store=new AgentStore(join(f.directory,'tasks.sqlite'));
 const fresh=store.admit({...ns,messageId:'fresh',outcome:'prepare'},20),attempted=store.admit({...ns,messageId:'attempted',outcome:'prepare'},20),cancelled=store.admit({...ns,messageId:'cancelled',outcome:'prepare'},20),foreign=store.admit({...ns,workspaceId:'other-workspace',messageId:'foreign',outcome:'prepare'},20);
 store.update(attempted.id,t=>{t.run.attempt=1;});store.cancel(cancelled.id);store.close();let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{
  app=await startAgentApplication(f.triggerConfig());await assert.rejects(startAgentApplication(f.triggerConfig()),/EEXIST/);await wait(()=>app!.tasks.get(fresh.id).status==='ready');await wait(()=>app!.tasks.get(attempted.id).status==='blocked');assert.equal(app.tasks.get(attempted.id).recovery,'reconciliation_required');assert.equal(app.tasks.get(attempted.id).run.attempt,1);assert.equal(app.tasks.get(cancelled.id).status,'cancelled');assert.equal(app.tasks.get(foreign.id).run.attempt,0);assert.equal(f.counts().modelCalls,2);assert.throws(()=>app!.cancelTask(foreign.id),/unavailable/);assert.equal(app.trigger!.status().lastDispatch!.taskId,fresh.id);
 }finally{await app?.stop();f.clean();}
});

test('receiver stop failure still drains tool, preserves cancelled work, releases lock and refuses late wakes',async()=>{
 const f=fixture();f.messages([]);let entered=false,release!:()=>void,settled=false;const gate=new Promise<void>(resolve=>{release=resolve;});let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 const tools=f.config.tools;f.config.tools=async(evidence,host)=>(await tools(evidence,host)).map(tool=>tool.name==='files.read'?{...tool,invoke:async(args,context)=>{entered=true;await gate;assert.equal(evidence.db.prepare('SELECT 1 AS open').get()!.open,1);settled=true;return tool.invoke(args,context);}}:tool);
 try{
  app=await startAgentApplication(f.triggerConfig());await wait(()=>!!app!.trigger!.status().service.lastSync);f.messages(['stopping']);await f.send();await wait(()=>entered);f.receiverStopFailure(true);
  let closed=false;const stopping=app.stop().finally(()=>{closed=true;});void stopping.catch(()=>{});app.wake();await new Promise(r=>setTimeout(r,30));assert.equal(closed,false);assert.equal(existsSync(join(f.directory,'agent-startup.lock')),true);await assert.rejects(startAgentApplication(f.triggerConfig()),/EEXIST/);
  release();await assert.rejects(stopping,/resource shutdown failed/);assert.equal(settled,true);assert.equal(existsSync(join(f.directory,'agent-startup.lock')),false);assert.equal((await f.send('after-stop')).status,503);
  const stopped=app;app=undefined;stopped.wake();f.receiverStopFailure(false);app=await startAgentApplication(f.triggerConfig());await new Promise(r=>setTimeout(r,30));assert.equal(f.counts().modelCalls,1);assert.equal(app.tasks.tasks(ns)[0].status,'cancelled');
 }finally{release();await app?.stop().catch(()=>{});f.clean();}
});

test('trigger namespace and mutually exclusive configuration fail before acquiring ownership',async()=>{
 const f=fixture();try{
  await assert.rejects(startAgentApplication({...f.triggerConfig(),namespace:{...ns,workspaceId:'wrong'}}),/namespace must match/);assert.equal(existsSync(join(f.directory,'agent-startup.lock')),false);
  await assert.rejects(startAgentApplication({...f.config,...f.triggerConfig()} as unknown as AgentApplicationConfig),/exactly one/);assert.equal(existsSync(join(f.directory,'agent-startup.lock')),false);
 }finally{f.clean();}
});

for(const policy of ['absent','deny','bound','not-ready'] as const)test(`execution policy ${policy}: fixed runtime options retain external denial unless exact trusted policy permits`,async()=>{
 const f=fixture();f.messages([]);let invoked=0,readyChecks=0,approvalChecks=0;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 const store=new AgentStore(join(f.directory,'tasks.sqlite')),task=store.admit({...ns,messageId:'policy',outcome:'fixture external authority'},20);store.update(task.id,t=>{t.applicationRevision={applicationId:'invented-application',revision:1,contentHash:'a'.repeat(64)};});store.close();
 const schema={jsonSchema:{type:'object'},parse:(value:unknown)=>value};
 const external:ToolDefinition={name:'fixture.publish',version:'1',capabilities:['publish'],effect:'external_write',inputSchema:schema,outputSchema:schema,invoke:async(args,context)=>{invoked++;assert.equal(context.scope.grants.includes('bound-revision:1'),true);return {callId:context.callId,status:'ok',data:{result:'real fixture invocation'},artifacts:[],evidence:[],observations:['fixture only, no provider write']};}};
 f.config.tools=()=>[external];f.config.modelTransport=async(_input,init)=>{const {untrustedTask,registeredTools}=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);assert.equal(registeredTools[0].effect,'external_write');if(untrustedTask.observations.length)assert.equal(untrustedTask.observations[0].data.result,'real fixture invocation');return Response.json({choices:[{message:{content:JSON.stringify({next_action:untrustedTask.observations.length?{kind:'ready',result:'Observed fixture result'}:{kind:'tool',name:'fixture.publish',args:{revisionRef:'revision-one'}}})},finish_reason:'stop'}]});};
 if(policy!=='absent')f.config.execution={getScope:()=>({...f.config.scope,grants:['bound-revision:1']}),approveExternalWrite:(current,tool,args)=>{approvalChecks++;return policy!=='deny'&&current.id===task.id&&current.applicationRevision?.revision===1&&tool.name==='fixture.publish'&&(args as {revisionRef?:string}).revisionRef==='revision-one';},assertReady:()=>{readyChecks++;if(policy==='not-ready')throw Error('Trusted readiness not met');}};
 try{app=await startAgentApplication(f.config);await wait(()=>app!.tasks.get(task.id).status!=='working');const result=app.tasks.get(task.id);assert.equal(result.status,policy==='bound'?'ready':'blocked');assert.equal(invoked,policy==='bound'||policy==='not-ready'?1:0);if(policy==='not-ready'){assert.ok(readyChecks>=1);assert.equal(invoked,1,'the external write ran exactly once despite repeated Ready attempts');assert.ok(result.observations.some(o=>o.error?.code==='READY_REJECTED'&&/readiness not met/.test(o.error.message)));assert.ok(!result.currentResult,'a refused Ready never records a result');}else assert.equal(readyChecks,invoked);assert.equal(approvalChecks>0,policy!=='absent');if(policy==='absent'||policy==='deny')assert.match(result.blocker!,/not authorised/);if(policy==='not-ready')assert.equal(result.blocker,'Preparation turn bound reached');}finally{await app?.stop();f.clean();}
});

test('normal startup admission wakes its existing queue without waiting for long standalone poll',async()=>{
 const f=fixture();let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{app=await startAgentApplication(f.config);await wait(()=>app!.tasks.tasks(ns).length===1);await wait(()=>app!.tasks.tasks(ns)[0].status==='ready');assert.equal(f.counts().modelCalls,2);assert.match(app.tasks.tasks(ns)[0].currentResult!,/0012345/);}finally{await app?.stop();f.clean();}
});
