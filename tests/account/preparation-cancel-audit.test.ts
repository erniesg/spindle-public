import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {AccountClient} from '../../core/account/client.js';
import {statefulFixture} from './stateful-fixture.js';

// Isolated real HTTP/stores; invented Google and abort-aware scripted provider.
async function started(f:Awaited<ReturnType<typeof statefulFixture>>){
 for(let i=0;i<200&&f.dispatches()===0;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.dispatches(),1);
}
function denyAudit(f:Awaited<ReturnType<typeof statefulFixture>>,taskId:string,fault:'full'|'insertion'){
 const db=(f.tasks as unknown as {db:DatabaseSync}).db;
 if(fault==='insertion')db.exec("CREATE TRIGGER refuse_cancel_audit BEFORE INSERT ON preparation_actions BEGIN SELECT RAISE(ABORT,'INVENTED_AUDIT_FAILURE'); END");
 else{
  const count=(db.prepare('SELECT count(*) AS n FROM preparation_actions').get() as {n:number}).n;
  const body=JSON.stringify({action:'source',actionId:'invented-history',taskId,runId:'invented',generation:0,observedAt:'2026-10-28T00:00:00Z',caller:'account_api',disposition:'fixture'});
  db.prepare('WITH RECURSIVE remaining(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM remaining WHERE n<?) INSERT INTO preparation_actions(workspace_id,account_id,task_id,body) SELECT ?,?,?,? FROM remaining').run(4096-count,'account-private',f.client.account!.id,taskId,body);
 }
 return ()=>Number((db.prepare('SELECT count(*) AS n FROM preparation_actions').get() as {n:number}).n);
}
for(const fault of ['full','insertion'] as const)test(`owner cancels active processing despite ${fault} audit refusal, retaining budgets and unknowns`,async()=>{
 const f=await statefulFixture('hold');let aborted=false;const factory=f.config.provider;
 f.config.provider=c=>{const p=factory(c);return {...p,next:(...args)=>{args[2]?.signal.addEventListener('abort',()=>{aborted=true;},{once:true});return p.next(...args);}};};
 try{
  const initial=await f.client.prepareApplication(f.input());await started(f);
  // Synthetic prior reservations/uncertain effect, NOT real paid spend or a POST.
  f.tasks.update(initial.taskId,t=>{t.budget.used=11;t.preparation!.modelBudget.decisionCalls=6;t.preparation!.modelBudget.reservedUsd=0.05;t.pending={callId:'invented-unknown',tool:'drive.create_artifact',effect:'external_write'};t.recovery='reconciliation_required';});
  const count=denyAudit(f,initial.taskId,fault),rows=count(),before=f.tasks.get(initial.taskId),calls=[...f.googleCalls];
  assert.equal((await f.client.cancelPreparation(initial.taskId)).state,'cancelled');
  assert.equal(aborted,true,'stop must abort the active provider, not just change a label');
  await new Promise(r=>setTimeout(r,20));
  const after=f.tasks.get(initial.taskId);
  assert.equal(after.status,'cancelled');assert.equal(after.preparation!.processingConsent,false);
  assert.deepEqual(after.budget,before.budget);assert.deepEqual(after.preparation!.modelBudget,before.preparation!.modelBudget);
  assert.deepEqual(after.pending,before.pending);assert.equal(after.recovery,before.recovery);
  assert.match(after.nextAction,/audit unavailable/i);assert.equal(count(),rows,'no phantom audit row');
  assert.equal(f.dispatches(),1);assert.deepEqual(f.googleCalls,calls,'stop must not probe Google');
 }finally{await f.close();}
});

test('audit-full owner stop removes queued work before the active predecessor drains',async()=>{
 const f=await statefulFixture('hold');try{
  const first=await f.client.prepareApplication(f.input());await started(f);
  const queued=await f.client.prepareApplication(f.input('queued-intent','Another invented request'));
  assert.equal((await f.client.preparationTask(queued.taskId) as any).execution.state,'queued');
  denyAudit(f,queued.taskId,'full');
  assert.equal((await f.client.cancelPreparation(queued.taskId)).state,'cancelled');
  assert.equal((await f.client.cancelPreparation(first.taskId)).state,'cancelled');
  await new Promise(r=>setTimeout(r,20));assert.equal(f.dispatches(),1);
  assert.equal(f.tasks.get(queued.taskId).preparation!.processingConsent,false);
 }finally{await f.close();}
});

test('stop still requires the owning account and records the ordinary available audit',async()=>{
 const f=await statefulFixture('hold');try{
  const initial=await f.client.prepareApplication(f.input());await started(f);
  const other=new AccountClient(f.server.origin);await other.signin('invented-other-owner','invented-password-123',true);
  await assert.rejects(other.cancelPreparation(initial.taskId),/PREPARATION_NOT_FOUND/);
  assert.equal(f.tasks.get(initial.taskId).status,'working');
  assert.equal((await f.client.cancelPreparation(initial.taskId)).state,'cancelled');
  const actions=f.tasks.preparationActions({workspaceId:'account-private',accountId:f.client.account!.id},initial.taskId);
  assert.equal(actions.filter(a=>a.action==='cancel').length,1);
 }finally{await f.close();}
});
