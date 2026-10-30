import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDemoEmailIngress,demoEmail,demoEmailNamespace} from '../../tools/demo-email-ingress.js';

const scratch=()=>{mkdirSync(join(process.cwd(),'.local'),{recursive:true});return mkdtempSync(join(process.cwd(),'.local/email-test-'));};

test('loopback Gmail MIME reaches real admission and source tools; duplicate and full restart retain one task',async()=>{
 const directory=scratch(),namespace=demoEmailNamespace;
 const messages=[demoEmail({id:'request-01',subject:'Could you help?',text:'Please prepare my application at https://portal.example.test/apply. Reference 0012345.'}),demoEmail({id:'newsletter',subject:'News',text:'Garden club newsletter. No action requested.'})];
 // Deterministic admission policy is a seam test, NOT actual model classification.
 const relevant=async(message:unknown)=>{
  const mail=message as typeof messages[number];
  return Buffer.from(mail.payload.body.data,'base64url').toString().includes('Please prepare')?'Inspect and prepare the requested application':undefined;
 };
 let tasks:AgentStore|undefined,evidence:EvidenceStore|undefined,ingress:Awaited<ReturnType<typeof createDemoEmailIngress>>|undefined;
 let runtime:Awaited<ReturnType<NonNullable<typeof ingress>['start']>>|undefined;
 try{
  tasks=new AgentStore(join(directory,'tasks.sqlite'));evidence=new EvidenceStore(join(directory,'evidence'));
  ingress=await createDemoEmailIngress({dataDirectory:directory,messages,relevant});
  runtime=await ingress.start(tasks);await ingress.synchronized(runtime);
  assert.equal(tasks.tasks(namespace).length,1,'unrelated email rejected by injected callback');
  const task=tasks.tasks(namespace)[0];assert.equal(task.sourceEvent.messageId,'request-01');assert.equal(task.run.attempt,0);
  assert.equal(runtime.status().lastAdmission?.disposition,'inserted');assert.equal(runtime.status().watching,false);
  assert.equal(runtime.status().schedulerRunning,false,'ingress-only helper does not pretend to dispatch a model');
  const tools=await ingress.sourceTools(task,evidence),read=tools.find(tool=>tool.name==='mail.read')!;
  const context={callId:'read-mail',taskId:task.id,runId:task.run.id,...namespace,budget:task.budget,scope:{sources:[],destinations:[],grants:[]},signal:AbortSignal.timeout(2000),isCurrent:()=>true};
  const result=await read.invoke(read.inputSchema.parse({messageId:task.sourceEvent.messageId}),context);
  assert.equal(result.status,'ok');read.outputSchema.parse(result.data);
  const data=result.data as {message:{text:string;subject:string};source:{provider:string;providerVersion:string;sha256:string}};
  assert.equal(data.message.subject,'Could you help?');assert.match(data.message.text,/0012345/);assert.equal(data.source.provider,'gmail');assert.equal(data.source.providerVersion,'10');
  assert.deepEqual(JSON.parse(evidence.read(namespace,result.artifacts[0].id).toString()),messages[0],'original provider bytes persisted');
  const denied=await read.invoke({messageId:'newsletter'},context);assert.equal(denied.status,'failed');
  assert.ok(ingress.requests().some(request=>request.path.includes('messages/request-01?format=full')),'actual HTTP Gmail full-message route');
  await runtime.stop();await ingress.stop();tasks.close();evidence.close();tasks=undefined;evidence=undefined;
  // Reopen BOTH connector state and task database, then replay the same Gmail history.
  tasks=new AgentStore(join(directory,'tasks.sqlite'));ingress=await createDemoEmailIngress({dataDirectory:directory,messages,relevant});runtime=await ingress.start(tasks);await ingress.synchronized(runtime);
  assert.equal(tasks.tasks(namespace).length,1);assert.equal(tasks.tasks(namespace)[0].id,task.id);assert.equal(tasks.tasks(namespace)[0].run.id,task.run.id);
  assert.equal(runtime.status().lastAdmission?.disposition,'existing');assert.equal(tasks.tasks(namespace)[0].budget.used,0);
  assert.ok(ingress.requests().some(request=>request.path.includes('/history?')),'restart exercised incremental history rather than recreating a task');
 }finally{await runtime?.stop();await ingress?.stop();evidence?.close();tasks?.close();rmSync(directory,{recursive:true,force:true});}
});

test('default admits generic inspection, not fixed-subject application eligibility; no live endpoints or send/watch',async()=>{
 const directory=scratch(),tasks=new AgentStore(join(directory,'tasks.sqlite'));
 const messages=[demoEmail({id:'ordinary',subject:'Lunch?',text:'Meet for lunch tomorrow?'}),demoEmail({id:'different',subject:'Re: documents',text:'Use the existing files to prepare a form.'})];
 const ingress=await createDemoEmailIngress({dataDirectory:directory,messages});let runtime:Awaited<ReturnType<typeof ingress.start>>|undefined;
 try{
  runtime=await ingress.start(tasks);await ingress.synchronized(runtime);
  assert.equal(tasks.tasks(demoEmailNamespace).length,2);
  for(const task of tasks.tasks(demoEmailNamespace)){assert.match(task.requestedOutcome,/mail.read/);assert.match(task.requestedOutcome,/unrelated/i);assert.equal(task.applicationRevision,undefined);assert.equal(task.decisions.length,0);}
  assert.ok(ingress.requests().some(request=>request.method==='POST'),'invented OAuth refresh actually reached loopback');
  assert.ok(ingress.requests().filter(request=>request.method==='POST').every(request=>request.path==='/token'),'no write/watch/send endpoints');
  const before=ingress.requests().length;
  await assert.rejects(ingress.http('https://gmail.googleapis.com/gmail/v1/users/me/watch',{method:'POST'}),/fixture endpoint denied/);
  await assert.rejects(ingress.http('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST'}),/fixture endpoint denied/);
  await assert.rejects(ingress.http('https://example.com/'),/fixture endpoint denied/);
  assert.equal(ingress.requests().length,before,'denied destinations never reach HTTP');
  await runtime.stop();await ingress.stop();await assert.rejects(ingress.http('https://gmail.googleapis.com/gmail/v1/users/me/profile'),/stopped/);
 }finally{await runtime?.stop();await ingress.stop();tasks.close();rmSync(directory,{recursive:true,force:true});}
});

test('callback failure leaves no task and a truthful blocked trigger, not fixture success',async()=>{
 const directory=scratch(),tasks=new AgentStore(join(directory,'tasks.sqlite'));
 const ingress=await createDemoEmailIngress({dataDirectory:directory,messages:[demoEmail({id:'needs-classification',subject:'Request',text:'Please inspect this.'})],relevant:async()=>{throw Error('classifier unavailable');}});
 let runtime:Awaited<ReturnType<typeof ingress.start>>|undefined;
 try{
  runtime=await ingress.start(tasks);await assert.rejects(ingress.synchronized(runtime),/classifier unavailable/);
  assert.equal(tasks.tasks(demoEmailNamespace).length,0);assert.equal(runtime.status().state,'blocked');assert.equal(runtime.status().running,false);
 }finally{await runtime?.stop();await ingress.stop();tasks.close();rmSync(directory,{recursive:true,force:true});}
});
