import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startAgentApplication, type AgentApplicationConfig} from '../../core/agent/startup.js';
import {contextTools} from '../../core/memory/tools.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {randomBytes} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
const ns={workspaceId:'test',accountId:'test@example.test'};
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'startup-'));
 const budgetPath=join(directory,'budget.json');writeFileSync(budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 writeFileSync(join(directory,'statement.txt'),'Account 0012345');
 let calls=0;
 const http:typeof fetch=async input=>{const url=String(input);if(url.includes('/token'))return Response.json({access_token:'invented',expires_in:3600});if(url.endsWith('/profile'))return Response.json({emailAddress:ns.accountId,historyId:'10'});if(url.includes('/messages?'))return Response.json({messages:[{id:'one'}]});if(url.includes('/history?'))return Response.json({historyId:'10',history:[]});return Response.json({id:'one',internalDate:'1000'});};
 const config:AgentApplicationConfig={google:{clientId:'invented',connectionId:'connection',dataDirectory:directory,mode:'local',bootstrapSince:500,intervalMs:60000,route:{route:'route',account:ns.accountId,workspace:ns.workspaceId,epoch:'epoch',audience:'https://receiver.example.test',subscription:'projects/test/subscriptions/test',serviceAccountEmail:'push@test.example'},relevant:async()=> 'prepare'},namespace:ns,budgetPath,model:{provider:'nebius',id:'invented-model',inputContextTokens:32768,maxOutputTokens:512,text:true,jsonObject:true,pricing:{inputUsdPerMillion:0.1,outputUsdPerMillion:0.1,source:'https://example.test/pricing',verifiedAt:'2026-10-25T00:00:00Z'}},credential:async()=> 'invented',tools:evidence=>contextTools(evidence,{selected:directory},{statement:{rootId:'selected',path:'statement.txt',mimeType:'text/plain'}}),scope:{sources:[],destinations:[],grants:['files.read','files.root:selected','files.write']},maxTurns:3,pollMs:10,timeoutMs:2000,review:true,
 modelTransport:async(_input,init)=>{calls++;const request=JSON.parse(String(init!.body));const context=JSON.parse(request.messages[1].content).untrustedTask;const observed=context.observations[0]?.data.text;return Response.json({choices:[{message:{content:JSON.stringify({next_action:calls===1?{kind:'tool',name:'files.read',args:{selectionId:'statement'}}:calls===2?{kind:'tool',name:'files.write',args:{text:observed,mimeType:'text/plain',derivedFrom:[]}}:{kind:'ready',result:'Review '+observed}})},finish_reason:'stop'}]});},
 googleDependencies:{http,credentials:{get:async()=>JSON.stringify({refreshToken:'invented',accountId:ns.accountId,connectionEpoch:'epoch',grants:[scopes.mail]}),set:async()=>{},delete:async()=>{},compareAndSet:async()=>true}}};
 return {directory,budgetPath,config,calls:()=>calls,clean:()=>rmSync(directory,{recursive:true,force:true})};
}
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check());}
test('synthetic Google admission reaches real provider parser/file snapshot and preparation readback; restart retains budget and dedup',async()=>{
 const f=fixture();let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{app=await startAgentApplication(f.config);await until(()=>app!.tasks.tasks(ns)[0]?.status==='ready');const task=app.tasks.tasks(ns)[0];assert.equal(task.observations[0].status,'ok');assert.match(JSON.stringify(task.observations),/0012345/);const artifact=task.observations[0].artifacts[0];assert.equal(app.evidence.read(ns,artifact.id).toString(),'Account 0012345');assert.equal(app.tasks.taskView(ns,task.id)?.status,'ready');assert.equal(app.evidence.read(ns,task.observations[1].artifacts[0].id).toString(),'Account 0012345');assert.equal(readFileSync(join(f.directory,'statement.txt'),'utf8'),'Account 0012345');const view=await fetch(app.review!.origin+'/api/tasks/'+task.id,{headers:{Authorization:'Bearer '+app.review!.token}});assert.equal((await view.json() as {status:string}).status,'ready');if(process.env.SPINDLE_STARTUP_EVIDENCE){const path=process.env.SPINDLE_STARTUP_EVIDENCE;writeFileSync(path+'.source.txt',app.evidence.read(ns,artifact.id));writeFileSync(path+'.output.txt',app.evidence.read(ns,task.observations[1].artifacts[0].id));writeFileSync(path,JSON.stringify({label:'Synthetic adapter machinery, not live acceptance; fixture databases removed after byte-preserving sample export',snapshotCopies:{source:path+'.source.txt',output:path+'.output.txt'},task,envelopes:app.sessions.list(ns,task.id),budget:app.budget.snapshot()},null,2));}const before=readFileSync(f.budgetPath,'utf8');await app.stop();app=await startAgentApplication(f.config);await new Promise(r=>setTimeout(r,60));assert.equal(app.tasks.tasks(ns).length,1);assert.equal(readFileSync(f.budgetPath,'utf8'),before);assert.equal(f.calls(),3);}finally{await app?.stop();f.clean();}
});
test('startup review corrections share durable memory with runtime tools and survive restart',async()=>{
 const f=fixture();f.config.google.relevant=async()=>undefined;
 f.config.scope.grants.push('memory.read');
 f.config.modelTransport=async()=>Response.json({choices:[{message:{content:JSON.stringify({next_action:{kind:'tool',name:'memory.read',args:{key:'goal'}}})},finish_reason:'stop'}]});
 f.config.maxTurns=1;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{
  app=await startAgentApplication(f.config);
  const headers={Authorization:'Bearer '+app.review!.token,Origin:app.review!.origin,'Content-Type':'application/json'};
  const correction=await fetch(app.review!.origin+'/api/memory',{method:'POST',headers,body:JSON.stringify({key:'goal',kind:'goal',value:'Prepare invented workshop application'})});
  assert.equal(correction.status,200);assert.equal((await correction.json() as {userCorrected:boolean}).userCorrected,true);
  const task=app.tasks.admit({...ns,messageId:'memory',outcome:'Read corrected goal'},20);
  await until(()=>app!.tasks.get(task.id).status==='blocked');
  const data=app.tasks.get(task.id).observations[0].data as {value:string;userCorrected:boolean};
  assert.equal(data.value,'Prepare invented workshop application');assert.equal(data.userCorrected,true);
  await app.stop();app=await startAgentApplication(f.config);
  const response=await fetch(app.review!.origin+'/api/memory',{headers:{Authorization:'Bearer '+app.review!.token}});
  assert.equal(response.status,200);assert.match(JSON.stringify(await response.json()),/Prepare invented workshop application/);
  assert.equal(app.tasks.get(task.id).run.attempt,1);
 }finally{await app?.stop();f.clean();}
});
test('restart holds attempted/uncertain work, never executes cancelled tasks or foreign namespace',async()=>{
 const f=fixture();let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 const store=new AgentStore(join(f.directory,'tasks.sqlite'));
 for(const [messageId,accountId] of [['uncertain',ns.accountId],['cancelled',ns.accountId],['foreign','other@example.test']]){const t=store.admit({workspaceId:ns.workspaceId,accountId,messageId,outcome:'prepare'},20);if(messageId==='uncertain')store.update(t.id,t=>{t.run.attempt=1;t.pending={callId:'unknown',tool:'files.write',effect:'write_local'};});if(messageId==='cancelled')store.cancel(t.id);}
 store.close();f.config.google.relevant=async()=>undefined;
 try{app=await startAgentApplication(f.config);await until(()=>app!.tasks.tasks(ns).some(t=>t.status==='blocked'));assert.equal(f.calls(),0);assert.equal(app.tasks.tasks(ns).find(t=>t.sourceEvent.messageId==='uncertain')?.recovery,'reconciliation_required');assert.equal(app.tasks.tasks(ns).find(t=>t.sourceEvent.messageId==='cancelled')?.status,'cancelled');}finally{await app?.stop();f.clean();}
});
test('turn exhaustion blocks instead of automatic spending/replay',async()=>{
 const f=fixture();f.config.maxTurns=1;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{app=await startAgentApplication(f.config);await until(()=>app!.tasks.tasks(ns)[0]?.status==='blocked');assert.equal(f.calls(),1);await new Promise(r=>setTimeout(r,50));assert.equal(f.calls(),1);assert.match(app.tasks.tasks(ns)[0].blocker!,/turn bound/);}finally{await app?.stop();f.clean();}
});
test('stop drains actual local-write invocation before closing evidence and releasing ownership',async()=>{
 const f=fixture();let entered=false,settled=false;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 f.config.tools=evidence=>contextTools(evidence,{selected:f.directory},{statement:{rootId:'selected',path:'statement.txt',mimeType:'text/plain'}}).map(tool=>tool.name==='files.write'?{...tool,async invoke(args,context){entered=true;await new Promise(r=>setTimeout(r,80));assert.equal(context.isCurrent(),false);assert.equal(context.signal.aborted,true);settled=true;throw Error('Cancelled before local commit');}}:tool);
 try{app=await startAgentApplication(f.config);await until(()=>entered);const stopping=app.stop();await assert.rejects(startAgentApplication(f.config));await stopping;assert.equal(settled,true);const store=new AgentStore(join(f.directory,'tasks.sqlite'));const task=store.tasks(ns)[0];assert.equal(task.status,'cancelled');assert.equal(task.pending?.effect,'write_local');store.close();}finally{await app?.stop();f.clean();}
});
for(const cancellation of ['timeout','explicit'] as const)test(`${cancellation} fences the next queued task until a noncooperative write actually settles`,async()=>{
 const f=fixture();let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 let entered=false,settled=false,secondStarted=false,stale=false;
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.config.timeoutMs=cancellation==='timeout'?150:2000;
 f.config.google.relevant=async()=>undefined;
 const store=new AgentStore(join(f.directory,'tasks.sqlite'));
 const first=store.admit({workspaceId:ns.workspaceId,accountId:ns.accountId,messageId:'first',outcome:'prepare'},20);
 const second=store.admit({workspaceId:ns.workspaceId,accountId:ns.accountId,messageId:'second',outcome:'prepare'},20);store.close();
 f.config.modelTransport=async(_input,init)=>{
  const task=JSON.parse(JSON.parse(String(init!.body)).messages[1].content).untrustedTask;
  if(task.sourceEvent.messageId==='second'){secondStarted=true;assert.equal(settled,true);return Response.json({choices:[{message:{content:JSON.stringify({next_action:{kind:'ready',result:'Second prepared'}})},finish_reason:'stop'}]});}
  return Response.json({choices:[{message:{content:JSON.stringify({next_action:{kind:'tool',name:'files.write',args:{text:'late',mimeType:'text/plain',derivedFrom:[]}}})},finish_reason:'stop'}]});
 };
 f.config.tools=evidence=>contextTools(evidence,{selected:f.directory},{}).map(tool=>tool.name==='files.write'?{...tool,async invoke(args,context){
  entered=true;await gate;stale=!context.isCurrent()&&context.signal.aborted;
  // Deliberately ignore cancellation: a real late local side effect is not a settled runtime wait.
  writeFileSync(join(f.directory,'late.txt'),'late');settled=true;
  return {callId:context.callId,status:'ok' as const,data:null,artifacts:[],evidence:[],observations:['late result']};
 }}:tool);
 try{
  app=await startAgentApplication(f.config);await until(()=>entered);
  if(cancellation==='explicit')app.cancelTask(first.id);
  await until(()=>app!.tasks.get(first.id).status==='cancelled');
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(secondStarted,false);
  assert.equal(app.tasks.get(second.id).run.attempt,0);assert.equal(settled,false);
  release();await until(()=>app!.tasks.get(second.id).status==='ready');
  assert.equal(stale,true);assert.equal(readFileSync(join(f.directory,'late.txt'),'utf8'),'late');
  const retained=app.tasks.get(first.id);assert.equal(retained.status,'cancelled');assert.equal(retained.observations.length,0);assert.equal(retained.pending?.effect,'write_local');
  await app.stop();app=await startAgentApplication(f.config);await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(app.tasks.get(first.id).observations.length,0);assert.equal(app.tasks.get(second.id).run.attempt,1);
 }finally{release();await app?.stop();f.clean();}
});
test('unconfigured startup preserves manual task memory and has no shared-memory endpoint',async()=>{
 const f=fixture();f.config.google.relevant=async()=>undefined;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{app=await startAgentApplication(f.config);const response=await fetch(app.review!.origin+'/api/user-memory',{headers:{Authorization:'Bearer '+app.review!.token}});assert.equal(response.status,404);assert.equal(f.calls(),0);assert.equal(app.evidence.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'user_memory_%'").all().length,0);}finally{await app?.stop();f.clean();}
});
const serverModule=process.env.SPINDLE_MEMORY_SERVER_MODULE;
async function memoryAction(app:Awaited<ReturnType<typeof startAgentApplication>>,input?:Record<string,unknown>,signal?:AbortSignal){
 const response=await fetch(app.review!.origin+'/api/user-memory',{signal,method:input?'POST':'GET',headers:{Authorization:'Bearer '+app.review!.token,Origin:app.review!.origin,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 assert.equal(response.status,200);return await response.json() as {authenticated:boolean;account?:{id:string};choices?:Record<string,boolean>;entries?:Array<{key:string;value:string;revision:number;pending:boolean}>;turns?:Array<{id:string;state:string}>};
}
async function localMemoryServer(directory:string){
 assert.ok(serverModule&&isAbsolute(serverModule));const module=await import(pathToFileURL(serverModule).href) as {startTrackingServer:(directory:string,key:Buffer)=>Promise<{origin:string;close:()=>Promise<void>}>};return module.startTrackingServer(directory,randomBytes(32));
}
test('configured combined startup uses real authenticated shared memory, existing provider/journal/root and separate task identity across reopen',{skip:!serverModule},async()=>{
 const a=fixture(),b=fixture(),server=await localMemoryServer(join(a.directory,'server'));let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined,peer:Awaited<ReturnType<typeof startAgentApplication>>|undefined;let calls=0;
 for(const f of [a,b]){Object.assign(f.config,{userMemory:{accountOrigin:server.origin}});f.config.google.relevant=async()=>undefined;f.config.modelTransport=async(_input,init)=>{
  calls++;const request=JSON.parse(String(init!.body)),task=JSON.parse(request.messages[1].content).untrustedTask;
  return Response.json({choices:[{message:{content:JSON.stringify({next_action:task.observations.length?{kind:'ready',result:'Learned invented preference'}:{kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}}})},finish_reason:'stop'}]});
 };}
 try{
  app=await startAgentApplication(a.config);peer=await startAgentApplication(b.config);
  assert.equal((await memoryAction(app)).authenticated,false);assert.equal(calls,0);
  const signed=await memoryAction(app,{action:'signin',name:'startup-sample',password:'Invented-only-password-98!',register:true});
  assert.notEqual(signed.account!.id,ns.accountId);assert.deepEqual(signed.choices,{conversation:false,activity:false,processing:false,sync:false});assert.equal(calls,0);
  await memoryAction(peer,{action:'signin',name:'startup-sample',password:'Invented-only-password-98!'});
  await memoryAction(app,{action:'configure',conversation:true,activity:false,processing:true,sync:true});
  await memoryAction(app,{action:'conversation',text:'I prefer tea'});
  let learned=await memoryAction(app,{action:'sync'});for(let i=0;i<4&&!learned.entries?.length;i++)learned=await memoryAction(app,{action:'sync'});
  assert.equal(learned.entries![0].value,'I prefer tea.');assert.equal(learned.entries![0].pending,false);assert.equal(calls,2);
  await memoryAction(peer,{action:'configure',conversation:false,activity:false,processing:false,sync:true});const shared=await memoryAction(peer,{action:'sync'});assert.equal(shared.entries![0].value,'I prefer tea.');assert.equal(shared.account!.id,signed.account!.id);
  const memoryNs={workspaceId:ns.workspaceId,accountId:signed.account!.id},job=new UserMemoryStore(app.evidence.db).jobs(memoryNs)[0];
  assert.equal(app.evidence.read(memoryNs,job.artifactId).toString(),'I prefer tea');assert.equal(app.sessions.list(memoryNs,job.taskId!).length,2);assert.equal(app.sessions.list(ns,job.taskId!).length,0);assert.equal(app.budget.snapshot().calls,2);
  // Existing PR87 manual context continues using the task/Google namespace in the same connection.
  const response=await fetch(app.review!.origin+'/api/memory',{headers:{Authorization:'Bearer '+app.review!.token}});assert.equal(response.status,200);assert.doesNotMatch(JSON.stringify(await response.json()),/Prefers tea|I prefer tea/);
  await app.stop();app=await startAgentApplication(a.config);assert.equal((await memoryAction(app)).authenticated,false);
  await memoryAction(app,{action:'signin',name:'startup-sample',password:'Invented-only-password-98!'});assert.equal((await memoryAction(app)).entries![0].value,'I prefer tea.');assert.equal(calls,2);
  await memoryAction(app,{action:'forgetConversation',id:job.id});await memoryAction(app,{action:'sync'});assert.throws(()=>app!.evidence.read(memoryNs,job.artifactId));assert.equal(app.sessions.list(memoryNs,job.taskId!).length,0);
  assert.equal((await memoryAction(peer,{action:'sync'})).entries!.filter(e=>e.value==='I prefer tea.').length,0);
 }finally{await app?.stop();await peer?.stop();await server.close();a.clean();b.clean();}
});
for(const disconnect of [false,true])test(`shutdown drains actual in-flight memory signin before store closure, client disconnected=${disconnect}`,{skip:!serverModule},async()=>{
 const f=fixture(),backend=await localMemoryServer(join(f.directory,'server'));let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const proxy=createServer((req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  if(req.url==='/session'){entered=true;await gate;}
  const response=await fetch(backend.origin+req.url,{method:req.method,headers:{Origin:backend.origin,...(req.headers.cookie?{Cookie:req.headers.cookie}:{}),...(req.headers['x-csrf-token']?{'X-CSRF-Token':String(req.headers['x-csrf-token'])}:{}),'Content-Type':'application/json'},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
  res.writeHead(response.status,{'Content-Type':'application/json',...(response.headers.get('set-cookie')?{'Set-Cookie':response.headers.get('set-cookie')!}:{})});res.end(await response.text());
 })().catch(()=>{res.writeHead(500);res.end('{}');});});
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));Object.assign(f.config,{userMemory:{accountOrigin:`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`}});f.config.google.relevant=async()=>undefined;let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined,signin:ReturnType<typeof memoryAction>|undefined;
 try{
  const controller=new AbortController();app=await startAgentApplication(f.config);signin=memoryAction(app,{action:'signin',name:'startup-drain',password:'Invented-only-password-98!',register:true},controller.signal);void signin.catch(()=>{});await until(()=>entered);
  if(disconnect){controller.abort();await assert.rejects(signin);}
  let closed=false;const stopping=app.stop().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,40));assert.equal(closed,false);assert.equal(app.evidence.db.prepare('SELECT 1 AS open').get()!.open,1);await assert.rejects(startAgentApplication(f.config));
  release();if(!disconnect)assert.equal((await signin).authenticated,true);await stopping;assert.equal(closed,true);
  const evidence=new EvidenceStore(join(f.directory,'evidence'));try{assert.equal(evidence.db.prepare("SELECT count(*) AS n FROM user_memory_state WHERE key='bound'").get()!.n,1);}finally{evidence.close();}
  app=await startAgentApplication(f.config);assert.equal((await memoryAction(app)).authenticated,false);
 }finally{release();await signin?.catch(()=>{});await app?.stop();await new Promise<void>((resolve,reject)=>{proxy.close(error=>error?reject(error):resolve());proxy.closeIdleConnections();});await backend.close();f.clean();}
});
test('memory shutdown cancels late model responses, retains uncertain dispatch and releases stores even when ingress close reports failure',{skip:!serverModule},async()=>{
 const f=fixture(),server=await localMemoryServer(join(f.directory,'server'));Object.assign(f.config,{userMemory:{accountOrigin:server.origin}});f.config.google.relevant=async()=>undefined;
 let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 f.config.modelTransport=async()=>{entered=true;await gate;return Response.json({choices:[{message:{content:JSON.stringify({next_action:{kind:'ready',result:'Late response must not persist'}})},finish_reason:'stop'}]});};
 try{
  app=await startAgentApplication(f.config);const signed=await memoryAction(app,{action:'signin',name:'startup-late',password:'Invented-only-password-98!',register:true});
  await memoryAction(app,{action:'configure',conversation:true,activity:false,processing:true,sync:false});await memoryAction(app,{action:'conversation',text:'I prefer invented tea'});await until(()=>entered);
  const memoryNs={workspaceId:ns.workspaceId,accountId:signed.account!.id},job=new UserMemoryStore(app.evidence.db).jobs(memoryNs)[0];assert.equal(app.sessions.list(memoryNs,job.taskId!).length,1);
  // Report errors AFTER real ingress cleanup, so this tests cleanup propagation rather than leaking a server.
  const close=app.review!.close;app.review!.close=async()=>{await close();throw Error('Invented ingress close error');};
  await assert.rejects(app.stop(),/resource shutdown failed/);const stopped=app;app=undefined;
  const evidence=new EvidenceStore(join(f.directory,'evidence'));try{assert.equal(new UserMemoryStore(evidence.db).jobs(memoryNs)[0].state,'uncertain');}finally{evidence.close();}
  app=await startAgentApplication(f.config);assert.equal((await memoryAction(app)).authenticated,false);release();await new Promise(resolve=>setTimeout(resolve,50));
  await memoryAction(app,{action:'signin',name:'startup-late',password:'Invented-only-password-98!'});await memoryAction(app,{action:'sync'});
  assert.equal(new UserMemoryStore(app.evidence.db).jobs(memoryNs)[0].state,'uncertain');assert.equal(app.sessions.list(memoryNs,job.taskId!).length,1);assert.equal(app.budget.snapshot().calls,1);assert.equal((await memoryAction(app)).entries!.length,0);await assert.rejects(stopped.stop(),/resource shutdown failed/);
 }finally{release();await app?.stop();await server.close();f.clean();}
});
test('trusted memory origin fails validation before acquiring startup ownership',async()=>{
 const f=fixture();Object.assign(f.config,{userMemory:{accountOrigin:'http://not-loopback.example.test'}});
 try{await assert.rejects(startAgentApplication(f.config),/TLS_REQUIRED/);const {existsSync}=await import('node:fs');assert.equal(existsSync(join(f.directory,'agent-startup.lock')),false);}finally{f.clean();}
});
test('configured startup failure releases its memory lifecycle, databases and exclusive lock',async()=>{
 const f=fixture();Object.assign(f.config,{userMemory:{accountOrigin:'http://127.0.0.1:1'}});const tools=f.config.tools;f.config.tools=()=>{throw Error('Invented startup failure');};let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{await assert.rejects(startAgentApplication(f.config),/Invented startup failure/);const evidence=new EvidenceStore(join(f.directory,'evidence'));evidence.close();f.config.tools=tools;f.config.google.relevant=async()=>undefined;app=await startAgentApplication(f.config);assert.equal((await memoryAction(app)).authenticated,false);}finally{await app?.stop();f.clean();}
});
test('exclusive startup, stop cancels active credentials and drains without late dispatch',async()=>{
 const f=fixture();let entered=false;f.config.credential=async()=>{entered=true;return new Promise(resolve=>setTimeout(()=>resolve('invented'),50));};let app:Awaited<ReturnType<typeof startAgentApplication>>|undefined;
 try{app=await startAgentApplication(f.config);await assert.rejects(startAgentApplication(f.config));await until(()=>entered);assert.throws(()=>app!.cancelTask('foreign-or-unknown'));app.cancelTask(app.tasks.tasks(ns)[0].id);await app.stop();assert.throws(()=>app!.cancelTask('closed'));assert.equal(f.calls(),0);const store=new AgentStore(join(f.directory,'tasks.sqlite'));assert.equal(store.tasks(ns)[0].status,'cancelled');store.close();}finally{await app?.stop();f.clean();}
});
