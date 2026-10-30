import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import type {ToolDefinition} from '../../core/agent/contracts.js';
const schema={jsonSchema:{type:'object'},parse:(v:unknown)=>v};
const event={workspaceId:'w',accountId:'owner',messageId:'request',outcome:'Invented preparation'};
test('external approval is opt-in, exact tool/args/revision-bound; uncertain writes persist external pending',async()=>{
 const store=new AgentStore(':memory:');try{
  const task=store.admit(event,20);store.update(task.id,t=>{t.applicationRevision={applicationId:t.id,revision:1,contentHash:'one'};});let writes=0;
  const tool:ToolDefinition={name:'drive.create_artifact',version:'1',effect:'external_write',capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){writes++;assert.equal(store.get(task.id).pending!.effect,'external_write');throw Error('Lost acknowledgement');}};
  await new AgentRuntime(store,[tool]).run(task.id,{id:'offline',async next(){return {kind:'tool',name:tool.name,args:{artifactId:'generated',name:'new.pdf'}};}},1,{approveExternalWrite:(t,tool,args)=>t.applicationRevision?.revision===1&&tool.name==='drive.create_artifact'&&(args as any).artifactId==='generated'});
  assert.equal(writes,1);assert.equal(store.get(task.id).recovery,'reconciliation_required');assert.equal(store.get(task.id).pending!.effect,'external_write');
  store.recover(task.id);assert.equal(store.get(task.id).status,'blocked');assert.equal(store.get(task.id).pending!.effect,'external_write');
 }finally{store.close();}
});
test('F2: write batch failures require explicit validated no-effect proof, not an empty artifacts array',async()=>{
 for(const noEffect of [false,true]){const store=new AgentStore(':memory:');try{const task=store.admit(event,20);const tool:ToolDefinition={name:'write',version:'1',effect:'write_local',capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){return {callId:ctx.callId,status:'failed',...(noEffect?{effect:'none' as const}:{}),data:{},artifacts:[],evidence:[],observations:[],error:{code:'REFUSED',message:'Invented failure',producer:'write'}};}};await new AgentRuntime(store,[tool]).run(task.id,{id:'fixture',async next(){return {kind:'batch',calls:[{callId:'write',name:'write',args:{}}]};}},1);assert.equal(store.get(task.id).recovery,noEffect?'clean':'reconciliation_required');assert.equal(store.get(task.id).pending?.tool,noEffect?undefined:'batch');}finally{store.close();}}
});
test('dynamic source scope is host-admitted between tools; model args do not mint SourceRefs',async()=>{
 const store=new AgentStore(':memory:');try{
  const task=store.admit(event,20);let granted=false,turn=0;
  const tool:ToolDefinition={name:'read',version:'1',effect:'read',capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(_args,ctx){assert.equal(ctx.scope.grants.includes('trusted'),granted);granted=true;return {callId:ctx.callId,status:'ok',data:{observed:true},artifacts:[],evidence:[],observations:[]};}};
  await new AgentRuntime(store,[tool]).run(task.id,{id:'offline',async next(){turn++;return {kind:'tool',name:'read',args:{sources:['model-forgery']}};}},2,{getScope:()=>({sources:[],destinations:[],grants:granted?['trusted']:[]})});assert.equal(turn,2);assert.equal(store.get(task.id).observations.length,2);
 }finally{store.close();}
});
test('external batch has durable external fence and serializes mixed calls',async()=>{
 const store=new AgentStore(':memory:');try{
  const task=store.admit(event,20),order:string[]=[];
  const tools=['first','second'].map(name=>({name,version:'1',effect:'external_write' as const,capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(_args:unknown,ctx:any){assert.equal(store.get(task.id).pending!.effect,'external_write');order.push(name+' start');await Promise.resolve();order.push(name+' end');return {callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]};}}));
  await new AgentRuntime(store,tools).run(task.id,{id:'offline',async next(){return {kind:'batch',calls:[{callId:'a',name:'first',args:{}},{callId:'b',name:'second',args:{}}]};}},1,{approveExternalWrite:()=>true});assert.deepEqual(order,['first start','first end','second start','second end']);
 }finally{store.close();}
});
