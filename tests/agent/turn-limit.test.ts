import {test} from 'node:test';import assert from 'node:assert/strict';
import {AgentStore} from '../../core/storage/agent-store.js';import {AgentRuntime} from '../../core/agent/runtime.js';
import type {ToolDefinition} from '../../core/agent/contracts.js';
const read:ToolDefinition={name:'read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{},parse:x=>x},outputSchema:{jsonSchema:{},parse:x=>x},async invoke(_args,c){return {callId:c.callId,status:'ok',data:{observed:true},artifacts:[],evidence:[],observations:[]};}};
for(const blockOnTurnLimit of [false,true])test(`explicit turn exhaustion block policy=${blockOnTurnLimit} preserves observations and recovery facts`,async()=>{
 const store=new AgentStore(':memory:');const t=store.admit({accountId:'a',workspaceId:'w',messageId:'m',outcome:'Observe once'},10);
 store.update(t.id,t=>{t.browser={writes:{},recovery:'reconciliation_required'};t.externalAction={id:'existing-intent',authorizationId:'existing-review',state:'uncertain'};});
 try{
  await new AgentRuntime(store,[read]).run(t.id,{id:'offline',async next(){return {kind:'tool',name:'read',args:{}};}},1,{blockOnTurnLimit});
  const result=store.get(t.id);assert.equal(result.status,blockOnTurnLimit?'blocked':'working');assert.equal(result.observations.length,1);assert.equal(result.budget.used,2);
  assert.equal(result.browser!.recovery,'reconciliation_required');assert.equal(result.externalAction!.state,'uncertain');assert.equal(result.pending,undefined);
  if(blockOnTurnLimit)assert.match(result.blocker!,/turn bound/);
 }finally{store.close();}
});
for(const cancel of [false,true])test(`turn limit never overwrites terminal ready/cancelled, cancel=${cancel}`,async()=>{
 const store=new AgentStore(':memory:');const task=store.admit({accountId:'a',workspaceId:'w',messageId:'m',outcome:'Observe'},10),runtime=new AgentRuntime(store,[]);
 try{
  await runtime.run(task.id,{id:'offline',async next(){if(cancel)runtime.cancel(task.id);return {kind:'ready',result:'Observed completion'};}},1,{blockOnTurnLimit:true});
  assert.equal(store.get(task.id).status,cancel?'cancelled':'ready');assert.equal(store.get(task.id).blocker,undefined);
 }finally{store.close();}
});
