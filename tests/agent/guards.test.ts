import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../../core/storage/agent-store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import type {ToolDefinition, Decision} from '../../core/agent/contracts.js';
const event={accountId:'demo',messageId:'m',workspaceId:'w',outcome:'Prepare'};
const schema={jsonSchema:{type:"object"},parse:(v:unknown)=>v};

test('revision changed during provider await fences every decision before dispatch',async()=>{
 for(const kind of ['tool','ready','checklist'] as const){
 const store=new AgentStore(':memory:');const task=store.admit(event,10);let calls=0;
 const tool:ToolDefinition={name:'writer',version:'1',capabilities:[],effect:'write_local',inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){calls++;return {callId:ctx.callId,status:'ok',data:'written',artifacts:[],evidence:[],observations:[]};}};
 let release!:(decision:Decision)=>void;
 const pending=new AgentRuntime(store,[tool]).run(task.id,{id:'delayed',next(){return new Promise<Decision>(resolve=>{release=resolve;});}},1);
 store.update(task.id,t=>{t.applicationRevision={applicationId:'app',revision:2,contentHash:'new'};});
 release(kind==='tool'?{kind,name:'writer',args:{}}:kind==='ready'?{kind,result:'stale'}:{kind,reason:'stale',items:[]});
 await pending;
 const saved=store.get(task.id);assert.equal(calls,0);assert.equal(saved.decisions.length,0);assert.equal(saved.pending,undefined);assert.equal(saved.status,'working');assert.equal(saved.checklist.revision,0);assert.equal(saved.budget.used,1);store.close();
 }
});
test('recovery preserves cancellation and uncertain local-write reconciliation',()=>{
 const store=new AgentStore(':memory:');const task=store.admit(event,10);
 store.update(task.id,t=>{t.pending={callId:'uncertain',tool:'writer',effect:'write_local'};});
 store.cancel(task.id);const recovered=store.recover(task.id);
 assert.equal(recovered.status,'cancelled');assert.equal(recovered.recovery,'reconciliation_required');assert.equal(recovered.pending?.callId,'uncertain');assert.equal(recovered.nextAction,'Cancelled by user');store.close();
});

test('external effects denied before dispatch; invalid schemas never commit observations',async()=>{
 for(const effect of ['external_write','read'] as const){
 const store=new AgentStore(':memory:');const task=store.admit(event,10);let calls=0;
 const tool:ToolDefinition={name:'guarded',version:'1',capabilities:[],effect,inputSchema:schema,outputSchema:{jsonSchema:{},parse(){throw new Error('Invalid output');}},async invoke(_args,ctx){calls++;return {callId:ctx.callId,status:'ok',data:'bad',artifacts:[],evidence:[],observations:[]};}};
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){return {kind:'tool',name:tool.name,args:{}};}},1);
 assert.equal(calls,effect==='external_write'?0:1);assert.equal(store.get(task.id).status,'blocked');assert.equal(store.get(task.id).observations.length,0);store.close();
 }
});
test('budget reservations survive recovery and interrupted local writes cannot replay',async()=>{
 const store=new AgentStore(':memory:');const task=store.admit(event,1);
 const runtime=new AgentRuntime(store,[]);
 await runtime.run(task.id,{id:'script',async next(){return {kind:'checklist',reason:'inspection',items:[]};}},2);
 assert.equal(store.get(task.id).budget.used,1);assert.equal(store.get(task.id).status,'blocked');
 store.update(task.id,t=>{t.pending={callId:'uncertain',tool:'writer',effect:'write_local'};});
 store.recover(task.id);assert.equal(store.get(task.id).recovery,'reconciliation_required');assert.equal(store.get(task.id).budget.used,1);store.close();
});
test('independent authorised checklist work continues beside a blocked item',async()=>{
 const store=new AgentStore(':memory:');const task=store.admit(event,10);let calls=0;let turn=0;
 const tool:ToolDefinition={name:'inspect',version:'1',capabilities:[],effect:'read',inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){calls++;return {callId:ctx.callId,status:'ok',data:'observed',artifacts:[],evidence:[],observations:[]};}};
 const decisions:Decision[]=[{kind:'checklist',reason:'missing one source; inspect another',items:[{id:'missing',title:'Missing bank input',state:'blocked',dependsOn:[]},{id:'independent',title:'Read requirements',state:'pending',dependsOn:[]}]},{kind:'tool',name:'inspect',args:{},itemId:'independent'}];
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){return decisions[turn++];}},2);
 assert.equal(calls,1);assert.equal(store.get(task.id).checklist.items[0].state,'blocked');assert.deepEqual(store.get(task.id).observations.map(o=>[o.callId.startsWith('checklist-')?'checklist-ack':'tool',o.status]),[['checklist-ack','ok'],['tool','ok']]);store.close();
});

 test('invalid envelopes are rejected and schema metadata reaches provider',async()=>{
 for(const invalid of [{status:'invented'},{callId:'wrong'},{evidence:[{}]},{status:'failed'}]){
 const store=new AgentStore(':memory:');const task=store.admit(event,10);
 const tool:ToolDefinition={name:'inspect',version:'1',capabilities:[],effect:'read',inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){assert.deepEqual(ctx.scope.grants,[]);assert.equal(ctx.budget.used,2);return {...{callId:ctx.callId,status:'ok' as const,data:'x',artifacts:[],evidence:[],observations:[]},...invalid} as import('../../core/agent/contracts.js').ToolResult;}};
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(_task,tools){assert.deepEqual(tools[0].inputSchema,{type:'object'});assert.equal('parse' in tools[0].inputSchema,false);return {kind:'tool',name:'inspect',args:{}};}},1);
 assert.equal(store.get(task.id).observations.length,0);assert.equal(store.get(task.id).status,'blocked');store.close();
 }
 });
 test('deadline aborts active tool without waiting for uncooperative promise',async()=>{
 const store=new AgentStore(':memory:');const task=store.admit(event,10);let signal:AbortSignal|undefined;
 const tool:ToolDefinition={name:'hang',version:'1',capabilities:[],effect:'read',inputSchema:schema,outputSchema:schema,invoke(_args,ctx){signal=ctx.signal;return new Promise(()=>{});}};
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){return {kind:'tool',name:'hang',args:{}};}},1,{timeoutMs:10});
 assert.equal(signal?.aborted,true);assert.equal(store.get(task.id).status,'cancelled');assert.equal(store.get(task.id).observations.length,0);store.close();
 });
