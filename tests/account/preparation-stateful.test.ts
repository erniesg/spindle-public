import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountClient} from '../../core/account/client.js';
import {statefulFixture} from './stateful-fixture.js';
const fail=(code:string)=>(e:any)=>e.status===409&&e.code===code;

test('same owner/root/request repeated Run and double-tab RPCs retain one task; blocked replays never resume',async()=>{
 const f=await statefulFixture();try{
  const second=new AccountClient(f.server.origin);await second.signin('invented-owner','invented-password-123');
  const [a,b]=await Promise.all([f.client.prepareApplication(f.input('first-click')),second.prepareApplication(f.input('second-tab'))]);
  assert.equal(a.taskId,b.taskId);await f.wait(a.taskId);const before=f.tasks.get(a.taskId),calls=f.dispatches();
  assert.equal((await f.client.prepareApplication(f.input('later-click'))).taskId,a.taskId);assert.deepEqual(f.tasks.get(a.taskId),before);assert.equal(f.dispatches(),calls);
  assert.equal(f.tasks.tasks({workspaceId:'account-private',accountId:f.client.account!.id}).length,1);
  const duplicateConnection=await f.connect(),alias={...f.input('other-connection-click'),connectionId:duplicateConnection};assert.equal((await f.client.prepareApplication(alias)).taskId,a.taskId);assert.equal((await f.client.prepareApplication(alias)).taskId,a.taskId);assert.equal(f.tasks.get(a.taskId).preparation!.connectionId,before.preparation!.connectionId);assert.equal(f.dispatches(),calls);
  await assert.rejects(f.client.prepareApplication({...f.input('second-tab'),request:'Different intent'}),/REQUEST_ID_CONFLICT/);
 }finally{await f.close();}
});

test('working and queued Resume fail without generation/budget/envelope or queue growth',async()=>{
 const f=await statefulFixture('hold');try{
  const active=await f.client.prepareApplication(f.input()),queued=await f.client.prepareApplication(f.input('other-request','Different invented request'));
  for(let n=0;n<100&&f.dispatches()===0;n++)await new Promise(r=>setTimeout(r,5));
  for(const id of [active.taskId,queued.taskId]){
   const before=f.tasks.get(id);await assert.rejects(f.client.resumePreparation(id),fail('PREPARATION_ALREADY_WORKING'));assert.deepEqual(f.tasks.get(id),before);
  }
  const a=await f.client.preparationTask(active.taskId) as any,q=await f.client.preparationTask(queued.taskId) as any;
  assert.equal(a.execution.state,'running');assert.equal(q.execution.state,'queued');assert.equal(f.dispatches(),1);
 }finally{await f.close();}
});

test('concurrent blocked Resume has one CAS winner; start clears stale blocker and reports real phase',async()=>{
 const f=await statefulFixture();try{
  const r=await f.client.prepareApplication(f.input());await f.wait(r.taskId);const t=f.tasks.get(r.taskId);f.setMode('hold');
  const results=await Promise.allSettled([f.client.request('/preparation/resume',{taskId:r.taskId,expectedGeneration:t.generation,requestId:'resume-one'}),f.client.request('/preparation/resume',{taskId:r.taskId,expectedGeneration:t.generation,requestId:'resume-two'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.dispatches()<=2,true);
  const status=await f.client.preparationTask(r.taskId) as any;assert.equal(status.execution.state,'running');assert.equal(status.blocker,undefined);assert.notEqual(status.nextAction,t.nextAction);assert.ok(status.actions.length>=3);assert.ok(status.actions.every((a:any)=>a.observedAt&&a.actionId&&a.sessionCorrelation&&!JSON.stringify(a).includes('INVENTED_SECRET')));
 }finally{await f.close();}
});

test('shutdown preserves interrupted versus owner cancellation and never replays queued work on reopen',async()=>{
 const f=await statefulFixture('hold');try{
  const a=await f.client.prepareApplication(f.input()),q=await f.client.prepareApplication(f.input('queued','A separate request'));
  for(let n=0;n<100&&f.dispatches()===0;n++)await new Promise(r=>setTimeout(r,5));await f.reopen();
  assert.notEqual(f.tasks.get(a.taskId).status,'cancelled');assert.notEqual(f.tasks.get(q.taskId).status,'cancelled');
  const restored=new AccountClient(f.server.origin);await restored.signin('invented-owner','invented-password-123');
  for(const id of [a.taskId,q.taskId]){const s=await restored.preparationTask(id) as any;assert.equal(s.execution.state,'interrupted');assert.equal(s.execution.reason,'service_shutdown');assert.equal(s.canResume,false);}
  assert.equal(f.dispatches(),1);
 }finally{await f.close();}
});

test('explicit new intent is allowed without a generic one-task ban; unknown write holds are never cleared',async()=>{
 const f=await statefulFixture();try{
  const r=await f.client.prepareApplication(f.input());await f.wait(r.taskId);
  f.tasks.update(r.taskId,t=>{t.pending={callId:'invented-unknown',tool:'batch',effect:'write_local'};t.recovery='reconciliation_required';});
  const before=f.tasks.get(r.taskId),calls=f.dispatches();
  await assert.rejects(f.client.resumePreparation(r.taskId),fail('PREPARATION_RECONCILIATION_REQUIRED'));
  await assert.rejects(f.client.request('/preparation/source',{taskId:r.taskId,operation:'list'}),fail('PREPARATION_RECONCILIATION_REQUIRED'));
  assert.equal((await f.client.prepareApplication(f.input('same-intent'))).taskId,r.taskId);assert.deepEqual(f.tasks.get(r.taskId),before);assert.equal(f.dispatches(),calls);
  const next=await f.client.prepareApplication({...f.input('explicit-new'),newIntent:true});assert.notEqual(next.taskId,r.taskId);assert.deepEqual(f.tasks.get(r.taskId),before);
 }finally{await f.close();}
});

test('action provenance is bounded in the status view without erasing facts or attributing legacy actions',async()=>{
 const f=await statefulFixture();try{
  const r=await f.client.prepareApplication(f.input());await f.wait(r.taskId);const calls=f.dispatches();
  for(let n=0;n<70;n++)await f.client.prepareApplication(f.input('replay-'+n));
  const s=await f.client.preparationTask(r.taskId) as any;assert.equal(s.actions.length,64);assert.equal(s.actionHistory.retained,72);assert.equal(s.actionHistory.coverage,'since_instrumentation_only');assert.equal(f.dispatches(),calls);
  const starts=f.tasks.preparationActions({workspaceId:'account-private',accountId:f.client.account!.id},r.taskId);assert.equal(starts.length,64);
  const json=JSON.stringify(s.actions);for(const secret of ['invented-password-123','INVENTED_SECRET','INVENTED_REFRESH','INVENTED_ACCESS',f.input().request])assert.ok(!json.includes(secret));assert.ok(s.actions.every((a:any)=>/^[a-f0-9]{32}$/.test(a.sessionCorrelation)&&a.caller==='account_api'));
 }finally{await f.close();}
});

test('trusted paused startup serves retained state and manual/local actions but fails model routes closed; unpause never drains old work',async()=>{
 const f=await statefulFixture('hold');try{
  const a=await f.client.prepareApplication(f.input()),q=await f.client.prepareApplication(f.input('queued-pause','Separate invented queued request'));
  for(let n=0;n<100&&f.dispatches()===0;n++)await new Promise(r=>setTimeout(r,5));
  f.config.processingPaused=true;f.config.processingPauseReason='Operator reconciliation hold';await f.reopen();
  const c=new AccountClient(f.server.origin);await c.signin('invented-owner','invented-password-123');const before=f.tasks.get(a.taskId),dispatches=f.dispatches();
  const configuration=await c.preparationConfiguration();assert.equal(configuration.processingPaused,true);assert.equal(configuration.processingPauseReason,'Operator reconciliation hold');
  const status=await c.preparationTask(a.taskId);assert.equal(status.processingPaused,true);assert.equal(status.canResume,false);assert.equal(status.execution?.state,'interrupted');
  for(const [path,data]of [['/preparation/request',f.input('paused-new','A new request while paused')],['/preparation/resume',{taskId:a.taskId,expectedGeneration:before.generation,requestId:'paused-resume'}],['/preparation/correct',{taskId:a.taskId,fieldId:'reference',expectedRevision:1,value:'invented'}]] as const)await assert.rejects(c.request(path,data),(e:any)=>e.status===423&&e.code==='PREPARATION_PROCESSING_PAUSED'||e.status===409&&e.code==='PREPARATION_ALREADY_WORKING');
  const probe=await c.preparationSource(a.taskId,'list');assert.equal(probe.origin,'manual_probe');assert.equal(probe.result.status,'ok');
  const saved=await c.savePreparation({taskId:a.taskId,expectedRevision:1,kind:'session',requestId:'paused-local-save',saveOutputs:false});assert.equal(saved.state,'local_saved');
  await assert.rejects(c.savePreparation({taskId:a.taskId,expectedRevision:1,kind:'session',requestId:'paused-no-upload',saveOutputs:true}),(e:any)=>e.status===423&&e.code==='PREPARATION_PROCESSING_PAUSED');
  assert.equal(f.dispatches(),dispatches);assert.equal(f.tasks.get(a.taskId).generation,before.generation);assert.deepEqual(f.tasks.get(a.taskId).budget,before.budget);
  f.config.processingPaused=false;await c.preparationTask(q.taskId);await c.preparationList();assert.equal(f.dispatches(),dispatches);assert.equal(f.tasks.get(q.taskId).run.attempt,0);
 }finally{await f.close();}
});

test('task-bound source diagnostic uses registered factory without Run/Resume/model; phases derive actual result',async()=>{
 const f=await statefulFixture();try{
  const r=await f.client.prepareApplication(f.input());await f.wait(r.taskId);const before=f.tasks.get(r.taskId),calls=f.dispatches();
  const result=await f.client.request('/preparation/source',{taskId:r.taskId,operation:'list'}) as any;assert.equal(result.origin,'manual_probe');assert.equal(result.result.status,'ok');assert.equal(f.dispatches(),calls);
  const after=f.tasks.get(r.taskId);assert.equal(after.generation,before.generation);assert.deepEqual(after.budget,before.budget);assert.equal(after.status,before.status);
  const s=await f.client.preparationTask(r.taskId) as any;assert.equal(s.steps.discovery.status,'ok');assert.equal(s.steps.discovery.origin,'manual_probe');
  await assert.rejects(f.client.request('/preparation/source',{taskId:r.taskId,operation:'list',rootId:'other-root'}));
  const other=new AccountClient(f.server.origin);await other.signin('invented-other','invented-password-123',true);const sourceCalls=[...f.googleCalls];await assert.rejects(other.request('/preparation/source',{taskId:r.taskId,operation:'list'}));assert.deepEqual(f.googleCalls,sourceCalls);
 }finally{await f.close();}
});
