import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../../core/storage/agent-store.js';
test('Google observer failure preserves task UI projections and transactional outbox ACK',()=>{
 const store=new AgentStore(':memory:');const ns={workspaceId:'w',accountId:'a'};
 try {
 const task=store.admit({...ns,messageId:'m',outcome:'invented request'},10,()=>{throw Error('telemetry');});
 assert.equal(store.taskView(ns,task.id)?.id,task.id);
 assert.deepEqual(store.taskSummaries(ns).map(t=>t.id),[task.id]);
 assert.equal(store.taskView({...ns,accountId:'other'},task.id),undefined);
 const notices=store.notifications(ns);assert.equal(notices.length,1);assert.equal(notices[0].taskId,task.id);
 assert.equal(store.acknowledge({...ns,accountId:'other'},notices[0].id),false);
 assert.equal(store.acknowledge(ns,notices[0].id),true);assert.deepEqual(store.notifications(ns),[]);
 store.admit({...ns,messageId:'m',outcome:'duplicate'},10,()=>{throw Error('telemetry');});
 assert.deepEqual(store.notifications(ns),[]);
 store.cancel(task.id);assert.equal(store.notifications(ns)[0].kind,'cancelled');
 }finally{store.close();}
});
