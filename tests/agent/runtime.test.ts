import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';

test('durable dedup, real registered read observation, revisions and cumulative budget', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'spindle-agent-'));
 try {
 const path = join(dir, 'state.sqlite'); const input = join(dir, 'invented.txt'); writeFileSync(input, 'invented requirement');
 let store = new AgentStore(path);
 const task = store.admit({ accountId: 'demo', messageId: 'm1', workspaceId: 'w', outcome: 'inspect requirements' }, 8);
 const runtime = new AgentRuntime(store, [{name:'inspect', version:'1', effect:'read', capabilities:[], inputSchema:{jsonSchema:{type:"object"},parse(v){ assert.deepEqual(v, {}); return v; }}, outputSchema:{jsonSchema:{type:"object"},parse(v){ assert.equal(typeof v, 'string'); return v; }}, async invoke(_args,ctx){ return {callId:ctx.callId,status:'ok',data:readFileSync(input, 'utf8'),artifacts:[],evidence:[{id:'e',sourceId:'s',sourceVersion:'1',artifactId:'a'}],observations:['Read invented file']}; }}]);
 let turns = 0;
 await runtime.run(task.id, {id:'test-script-not-live-model', async next(state){
 turns++;
 if (!state.observations.length) return {kind:'tool', name:'inspect', args:{}};
 assert.equal(state.observations[0].data, 'invented requirement');
 assert.equal(state.observations[0].evidence[0].id,'e');
 assert.deepEqual(state.observations[0].observations,['Read invented file']);
 return {kind:'checklist', reason:'observed actual requirement', items:[{id:'review', title:'Review observed requirement', state:'pending', dependsOn:[]}]};
 }}, 2);
 assert.equal(turns, 2); assert.equal(store.get(task.id).checklist.revision, 1);
 const used = store.get(task.id).budget.used; store.close(); store = new AgentStore(path);
 assert.equal(store.admit(task.sourceEvent, 999).id, task.id); assert.equal(store.get(task.id).budget.used, used);
 // Each checklist decision is acknowledged with an ok runtime observation; the tool observation is still the only tool result.
 assert.deepEqual(store.get(task.id).observations.map(o=>[o.callId.startsWith('checklist-')?'checklist':'tool',o.status]), [['tool','ok'],['checklist','ok']]); store.close();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('cancellation fences a delayed tool and external writes are denied', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m',workspaceId:'w',outcome:'test'}, 10);
 let finish!: (v: import('../../core/agent/contracts.js').ToolResult)=>void;
 const runtime = new AgentRuntime(store,[{name:'slow',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:"object"},parse:v=>v},outputSchema:{jsonSchema:{type:"object"},parse:v=>v},invoke:()=>new Promise(resolve=>{finish=resolve;})}]);
 const running = runtime.run(task.id,{id:'script',async next(){return {kind:'tool',name:'slow',args:{}};}},1);
 while (!finish) await new Promise(resolve=>setImmediate(resolve));
 runtime.cancel(task.id); await running;
 assert.equal(store.get(task.id).observations.length,0); assert.equal(store.get(task.id).status,'cancelled'); store.close();
});

 test('old caller abort cannot cancel a replacement run', async () => {
 const store = new AgentStore(':memory:');
 const task = store.admit({accountId:'a',messageId:'race',workspaceId:'w',outcome:'test'},10);
 const runtime = new AgentRuntime(store,[]); const signal = new AbortController();
 const first = runtime.run(task.id,{id:'old',next:()=>new Promise(()=>{})},1,{signal:signal.signal});
 let finish!: (v: {kind:'ready',result:string})=>void;
 const second = runtime.run(task.id,{id:'new',next:()=>new Promise(resolve=>{finish=resolve;})},1);
 signal.abort(); finish({kind:'ready',result:'replacement survived'});
 await Promise.all([first,second]);
 assert.equal(store.get(task.id).status,'ready'); store.close();
 });

 test('synchronous cancellation still consumes provider rejection', async () => {
 const store = new AgentStore(':memory:');
 const task = store.admit({accountId:'a',messageId:'reject',workspaceId:'w',outcome:'test'},10);
 const runtime = new AgentRuntime(store,[]);
 await runtime.run(task.id,{id:'cancel-reject',next(){runtime.cancel(task.id);return Promise.reject(new Error('late rejection'));}},1);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(store.get(task.id).status,'cancelled'); store.close();
 });

test('checklist items without dependsOn (actual Nemotron output) default to no dependencies instead of blocking', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-deps',workspaceId:'w',outcome:'test'}, 10);
 const runtime = new AgentRuntime(store, []);
 await runtime.run(task.id,{id:'script',async next(){return {kind:'checklist',reason:'plan',items:[{id:'1',title:'List files',state:'completed'},{id:'2',title:'Read form',state:'in-progress',dependsOn:['1']}]} as unknown as import('../../core/agent/contracts.js').Decision;}},1);
 const t = store.get(task.id); assert.notEqual(t.status,'blocked'); assert.equal(t.checklist.revision,1);
 assert.deepEqual(t.checklist.items.map(i=>i.dependsOn),[[],['1']]);assert.deepEqual(t.checklist.items.map(i=>i.state),['done','in_progress']); store.close();
});

test('invalid tool arguments become a correctable no-effect observation instead of blocking the task', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-args',workspaceId:'w',outcome:'test'}, 10);
 let invoked=0;
 const tool={name:'resize',version:'1',effect:'write_local' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse(v:unknown){if((v as {maxBytes:number}).maxBytes>8)throw new Error('Invalid parameter maxBytes: expected integer in [1,8]');return v;}},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>{invoked++;return {callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]};}};
 const runtime = new AgentRuntime(store,[tool]);let turn=0;
 await runtime.run(task.id,{id:'script',async next(state){
  turn++;
  if(turn===1)return {kind:'tool',name:'resize',args:{maxBytes:20}};
  if(turn===2){assert.equal(state.observations.at(-1)!.error!.code,'INVALID_TOOL_ARGUMENTS');assert.match(state.observations.at(-1)!.error!.message,/maxBytes/);return {kind:'batch',calls:[{callId:'ok',name:'resize',args:{maxBytes:1}},{callId:'bad',name:'resize',args:{maxBytes:99}}]};}
  // a877d28: in a batch the valid call still runs and only the invalid one is refused (no effect).
  if(turn===3){assert.deepEqual(state.observations.slice(-2).map(o=>[o.callId,o.status,o.error?.code]),[['invalid-args-1','failed','INVALID_TOOL_ARGUMENTS'],['ok','ok',undefined]]);return {kind:'tool',name:'resize',args:{maxBytes:4}};}
  return {kind:'ready',result:'corrected'};
 }},6);
 const t=store.get(task.id);assert.equal(t.status,'ready',t.blocker);assert.equal(invoked,2,'only valid arguments were ever invoked');assert.equal(t.recovery,'clean');store.close();
});

test('a refused ready is guidance once; a repeated refused ready blocks with the requirement', async () => {
 for(const fixes of [true,false]){
  const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:`m-ready-${fixes}`,workspaceId:'w',outcome:'test'}, 10);
  let exported=false;const tool={name:'session.export',version:'1',effect:'write_local' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>{exported=true;return {callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]};}};
  const runtime = new AgentRuntime(store,[tool]);let turn=0;
  await runtime.run(task.id,{id:'script',async next(state){turn++;if(turn===2&&fixes){assert.equal(state.observations.at(-1)!.error!.code,'READY_REJECTED');assert.match(state.observations.at(-1)!.error!.message,/CURRENT_SESSION_EXPORT_REQUIRED/);return {kind:'tool',name:'session.export',args:{}};}return {kind:'ready',result:'done'};}},6,{assertReady:()=>{if(!exported)throw new Error('CURRENT_SESSION_EXPORT_REQUIRED: call session.export');}});
  const t=store.get(task.id);
  if(fixes){assert.equal(t.status,'ready',t.blocker);}else{assert.equal(t.status,'blocked');assert.match(t.blocker!,/Repeated READY_REJECTED/);assert.equal(turn,3,'two refusals are guidance; the third identical refusal stops');assert.ok(t.observations.every(o=>o.error?.code==='READY_REJECTED'&&/CURRENT_SESSION_EXPORT_REQUIRED/.test(o.error.message)));}
  store.close();
 }
});

test('a call ID reused from an earlier batch is made unique instead of blocking the task', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-ids',workspaceId:'w',outcome:'test'}, 10);
 const tool={name:'look',version:'1',effect:'read' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>({callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]})};
 const runtime=new AgentRuntime(store,[tool]);let turn=0;
 await runtime.run(task.id,{id:'script',async next(){turn++;return turn<3?{kind:'batch',calls:[{callId:'same',name:'look',args:{}}]}:{kind:'ready',result:'ok'};}},4);
 const t=store.get(task.id);assert.equal(t.status,'ready',t.blocker);assert.deepEqual(t.observations.map(o=>o.callId),['same','same-2']);store.close();
});

test('repetition guard refuses re-running an identical failed call and tells the model to change approach', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-rep',workspaceId:'w',outcome:'test'}, 10);
 let runs=0;
 const tool={name:'ocr',version:'1',effect:'read' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(a:unknown,ctx:{callId:string})=>{runs++;const ok=(a as {input:string}).input==='right';return ok?{callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]}:{effect:'none' as const,callId:ctx.callId,status:'failed' as const,data:null,artifacts:[],evidence:[],observations:[],error:{code:'X',message:'wrong image',producer:'ocr'}};}};
 const runtime=new AgentRuntime(store,[tool]);let turn=0;
 await runtime.run(task.id,{id:'script',async next(state){turn++;
  if(turn<=2)return {kind:'tool',name:'ocr',args:{input:'wrong'}};
  if(turn===3){assert.equal(state.observations.at(-1)!.error!.code,'REPEATED_CALL');assert.match(state.observations.at(-1)!.error!.message,/already failed \(wrong image\)/);return {kind:'tool',name:'ocr',args:{input:'right'}};}
  return {kind:'ready',result:'ok'};}},6);
 const t=store.get(task.id);assert.equal(t.status,'ready',t.blocker);assert.equal(runs,2,'the repeated failing call was not re-run');store.close();
});

test('a model that keeps re-sending a refused call is stopped instead of burning the decision budget', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-stuck',workspaceId:'w',outcome:'test'}, 20);
 let runs=0,turns=0;
 const tool={name:'fill',version:'1',effect:'read' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>{runs++;return {effect:'none' as const,callId:ctx.callId,status:'failed' as const,data:null,artifacts:[],evidence:[],observations:[],error:{code:'X',message:'not grounded',producer:'fill'}};}};
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){turns++;return {kind:'tool',name:'fill',args:{v:1}};}},20);
 const t=store.get(task.id);assert.equal(t.status,'blocked');assert.match(t.blocker??'',/re-sent unchanged/);assert.equal(runs,1);assert.ok(turns<=5,`stopped after ${turns} turns`);store.close();
});

test('a failure that explicitly asks to be retried does not trip the repetition guard', async () => {
 const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-transient',workspaceId:'w',outcome:'test'}, 10);
 let runs=0;
 const tool={name:'layout',version:'1',effect:'read' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>{runs++;return runs===1?{effect:'none' as const,callId:ctx.callId,status:'failed' as const,data:null,artifacts:[],evidence:[],observations:[],error:{code:'TOOL_FAILED',message:'Connection changed: retry connection',producer:'layout'}}:{callId:ctx.callId,status:'ok' as const,data:{},artifacts:[],evidence:[],observations:[]};}};
 let turn=0;
 await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){turn++;return turn<=2?{kind:'tool',name:'layout',args:{page:0}}:{kind:'ready',result:'ok'};}},6);
 const t=store.get(task.id);assert.equal(t.status,'ready',t.blocker);assert.equal(runs,2,'the transient failure was retried');store.close();
});

test('only a lost credential compare-and-set gets one free identical retry; other "retry" messages still trip the guard', async () => {
 for(const [message,expectRuns] of [['Connection changed: retry connection',2],['PDF renderer is unavailable; retry when it is installed',1]] as const){
  const store = new AgentStore(':memory:'); const task = store.admit({accountId:'a',messageId:'m-'+expectRuns,workspaceId:'w',outcome:'test'}, 20);
  let runs=0;
  const tool={name:'doc',version:'1',effect:'read' as const,capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},outputSchema:{jsonSchema:{type:'object'},parse:(v:unknown)=>v},invoke:async(_a:unknown,ctx:{callId:string})=>{runs++;return {effect:'none' as const,callId:ctx.callId,status:'failed' as const,data:null,artifacts:[],evidence:[],observations:[],error:{code:'TOOL_FAILED',message,producer:'doc'}};}};
  await new AgentRuntime(store,[tool]).run(task.id,{id:'script',async next(){return {kind:'tool',name:'doc',args:{p:0}};}},20);
  const t=store.get(task.id);assert.equal(t.status,'blocked');assert.match(t.blocker??'',/re-sent unchanged/);assert.equal(runs,expectRuns,message);store.close();
 }
});
