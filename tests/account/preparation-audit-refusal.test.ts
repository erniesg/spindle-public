import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {statefulFixture} from './stateful-fixture.js';

// Actual isolated fixture stores/RPCs, never the owner's account or audit history.
for(const fault of ['full','insertion']as const)for(const operation of ['request','correct','resume']as const){
 test(`audit ${fault} refusal leaves ${operation} task, artifacts, notices and dispatch unchanged`,async()=>{
  const f=await statefulFixture();try{
   const initial=await f.client.prepareApplication(f.input());await f.wait(initial.taskId);
   f.tasks.update(initial.taskId,t=>{t.preparation!.fields=[{id:'reference',label:'Reference',value:'retained',unresolved:false,citations:[]}];});
   const ns={workspaceId:'account-private',accountId:f.client.account!.id},db=(f.tasks as unknown as {db:DatabaseSync}).db;
   if(fault==='full'){
    const count=(db.prepare('SELECT count(*) AS n FROM preparation_actions').get()as {n:number}).n;
    const body=JSON.stringify({action:'source',actionId:'invented-history',taskId:initial.taskId,runId:'invented',generation:0,observedAt:'2026-10-28T00:00:00Z',caller:'account_api',disposition:'fixture'});
    db.prepare('WITH RECURSIVE remaining(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM remaining WHERE n<?) INSERT INTO preparation_actions(workspace_id,account_id,task_id,body) SELECT ?,?,?,? FROM remaining').run(4096-count,ns.workspaceId,ns.accountId,initial.taskId,body);
   }else db.exec("CREATE TRIGGER reject_fixture_audit BEFORE INSERT ON preparation_actions BEGIN SELECT RAISE(ABORT,'INVENTED_AUDIT_FAILURE'); END");
   const state=()=>({tasks:f.tasks.tasks(ns),actions:(db.prepare('SELECT count(*) AS n FROM preparation_actions').get()as {n:number}).n,artifacts:(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()as {n:number}).n,notices:f.tasks.notifications(ns),dispatches:f.dispatches()});
   const before=state(),current=f.tasks.get(initial.taskId);
   if(operation==='request')await assert.rejects(f.client.prepareApplication(f.input('another-request','Another invented request')));
   if(operation==='correct')await assert.rejects(f.client.correctPreparation({taskId:initial.taskId,expectedRevision:1,fieldId:'reference',value:'must not persist'}));
   if(operation==='resume')await assert.rejects(f.client.resumePreparation(initial.taskId,current.generation,randomUUID()));
   assert.deepEqual(state(),before,'a rejected audit must not commit a transition, artifact, notice or model dispatch');
  }finally{await f.close();}
 });
}

test('transition storage failure rolls back its audit acceptance with the task mutation',async()=>{
 const f=await statefulFixture();try{
  const initial=await f.client.prepareApplication(f.input());await f.wait(initial.taskId);
  const task=f.tasks.get(initial.taskId),db=(f.tasks as unknown as {db:DatabaseSync}).db,ns={workspaceId:'account-private',accountId:f.client.account!.id};
  db.exec(`CREATE TRIGGER reject_fixture_transition BEFORE UPDATE ON agent_tasks WHEN NEW.id='${initial.taskId}' BEGIN SELECT RAISE(ABORT,'INVENTED_TRANSITION_FAILURE'); END`);
  const actionId=randomUUID();await assert.rejects(f.client.resumePreparation(task.id,task.generation,actionId));
  assert.deepEqual(f.tasks.get(task.id),task);assert.equal(f.tasks.preparationActions(ns,task.id).filter(a=>a.actionId===actionId).length,0);
 }finally{await f.close();}
});
