import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NebiusAgentProvider, type AgentEnvelope } from '../../core/models/agent-provider.js';
import { FileCallBudget } from '../../core/models/file-budget.js';
import { AgentSessionStore } from '../../core/models/agent-session-store.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import type { ModelDeclaration } from '../../core/models/provider.js';
const model: ModelDeclaration = { provider:'nebius', id:'explicit-test-model', text:true, jsonObject:true, inputContextTokens:65536, maxOutputTokens:1024, pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.test/pricing'} };
function setup() {
 const dir=mkdtempSync(join(tmpdir(),'agent-provider-')); const path=join(dir,'budget.json');
 writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const store=new AgentStore(':memory:'); const task=store.admit({accountId:'invented',messageId:'m',workspaceId:'w',outcome:'Read selected file'},20);
 return {dir,path,store,task,budget:new FileCallBudget(path),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const completion=(action: unknown)=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:action})}}],usage:{prompt_tokens:100,completion_tokens:20}});
for(const thinking of [false,undefined] as const)test(`agent wire preserves explicit nonthinking=${thinking===false} in the persisted request`,async()=>{
 const s=setup(),seen:AgentEnvelope[]=[];let calls=0;
 try{
  const p=new NebiusAgentProvider({model:{...model,...(thinking===false?{thinking}: {})},budget:s.budget,credential:async()=>'offline-only',persist:async e=>{seen.push(e);},transport:async(_url,init)=>{
   calls++;const request=JSON.parse(String(init?.body));
   if(thinking===false)assert.deepEqual(request.chat_template_kwargs,{enable_thinking:false});else assert.equal(Object.hasOwn(request,'chat_template_kwargs'),false);
   assert.equal(request.max_tokens,model.maxOutputTokens);assert.deepEqual(seen[0]!.request,request);
   return new Response(JSON.stringify(completion({kind:'ready',result:'Invented offline result'})));
  }});
  assert.deepEqual(await p.next(s.task,[]),{kind:'ready',result:'Invented offline result'});assert.equal(calls,1);
 }finally{s.close();}
});
test('OFFLINE sanitized actual response with empty native calls parses JSON and durably settles only the test journal',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../../tests/fixtures/nebius-empty-tool-calls.json',import.meta.url),'utf8'));
 const s=setup();const root=join(s.dir,'evidence');let evidence=new EvidenceStore(root);let dispatches=0;
 const ns={workspaceId:s.task.sourceEvent.workspaceId,accountId:s.task.sourceEvent.accountId};
 const decision={kind:'tool',name:'memory.learn',args:{key:'pref_community_grant_conciseness',kind:'preference',value:'Prefers concise plain-language answers for fictional community grant applications',quote:'For fictional community grant applications, I prefer concise plain-language answers.'}};
 const tools=[{name:'memory.learn',version:'1',effect:'write_local' as const,capabilities:[],inputSchema:{type:'object'},outputSchema:{type:'object'}}];
 try {
 const sessions=new AgentSessionStore(evidence.db);
 const p=new NebiusAgentProvider({model:{...model,id:fixture.response.model,inputContextTokens:16384,pricing:{...model.pricing,inputUsdPerMillion:0.06,outputUsdPerMillion:0.24}},budget:s.budget,credential:async()=> 'offline-fixture-only',persist:sessions.persist,transport:async(url,init)=>{
  dispatches++;assert.equal(String(url),'https://api.tokenfactory.nebius.com/v1/chat/completions');assert.equal(init?.method,'POST');
  const rows=sessions.list(ns,s.task.id);assert.equal(rows.length,1);assert.equal(rows[0].response,undefined);assert.deepEqual(rows[0].request,JSON.parse(String(init?.body)));
  return new Response(JSON.stringify(fixture.response),{status:200});
 }});
 assert.deepEqual(await p.next(s.task,tools),decision);assert.equal(dispatches,1);
 evidence.close();evidence=new EvidenceStore(root);
 const rows=new AgentSessionStore(evidence.db).list(ns,s.task.id);assert.equal(rows.length,1);assert.equal(rows[0].reservation,1);assert.equal(rows[0].model,fixture.response.model);assert.ok(rows[0].configDigest);
 assert.equal((rows[0].request as {model:string}).model,fixture.response.model);
 assert.deepEqual(rows[0].response,{decision,usage:{inputTokens:555,outputTokens:458}});
 const journal=JSON.parse(readFileSync(s.path,'utf8'));assert.equal(journal.reservedWorstCase,0);assert.equal(journal.observedSpend,0.000143220);assert.deepEqual(journal.requests,[{id:1,maximumUsd:0.002457600,actualUsd:0.000143220}]);
 assert.deepEqual(new FileCallBudget(s.path).snapshot(),{limitUsd:3,accountedUsd:0.000143220,calls:1,exhausted:false});
 }finally{evidence.close();s.close();}
});
test('actual Nemotron null native-call metadata parses validated JSON and settles only its existing journal',async()=>{
 const s=setup();const seen:AgentEnvelope[]=[];try{
  const action={kind:'tool' as const,name:'files.read',args:{}};
  const payload=completion(action);Object.assign(payload.choices[0].message,{tool_calls:null,function_call:null});
  const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=>'offline-only',persist:async e=>{seen.push(e);},transport:async()=>new Response(JSON.stringify(payload))});
  assert.deepEqual(await p.next(s.task,[fileTool]),action);assert.deepEqual(seen[1].response?.decision,action);
  const journal=JSON.parse(readFileSync(s.path,'utf8'));assert.equal(journal.reservedWorstCase,0);assert.ok(journal.requests[0].actualUsd>0);
 }finally{s.close();}
});
const nativeCall={id:'provider-call-1',type:'function',function:{name:'files.read',arguments:'{}'}};
const fileTool={name:'files.read',version:'1',effect:'read' as const,capabilities:[],inputSchema:{type:'object'},outputSchema:{type:'string'}};
for(const [name,metadata,code] of [

 ['object',{tool_calls:{}},'UNSUPPORTED_CAPABILITY'],
 ['string',{tool_calls:'[]'},'UNSUPPORTED_CAPABILITY'],
 ['false',{tool_calls:false},'UNSUPPORTED_CAPABILITY'],
 ['malformed nonempty calls',{tool_calls:[{}]},'MALFORMED_RESPONSE'],
 ['malformed native arguments',{tool_calls:[{...nativeCall,function:{...nativeCall.function,arguments:'not JSON'}}]},'MALFORMED_RESPONSE'],
 ['nonobject native arguments',{tool_calls:[{...nativeCall,function:{...nativeCall.function,arguments:'[]'}}]},'MALFORMED_RESPONSE'],
 ['overlong native ID',{tool_calls:[{...nativeCall,id:'x'.repeat(129)}]},'MALFORMED_RESPONSE'],
 ['oversized native batch',{tool_calls:Array.from({length:5},(_,i)=>({...nativeCall,id:`call-${i}`}))},'UNSUPPORTED_CAPABILITY'],
 ['legacy function call',{tool_calls:[],function_call:{name:'files.read',arguments:'{}'}},'UNSUPPORTED_CAPABILITY'],
] as const)test(`native metadata ${name} rejects despite valid JSON content`,async()=>{
 const s=setup();const seen:AgentEnvelope[]=[];try{
 const payload=completion({kind:'ready',result:'must not bypass native validation'});Object.assign(payload.choices[0].message,metadata);
 const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'offline-only',persist:async e=>{seen.push(e);},transport:async()=>new Response(JSON.stringify(payload))});
 await assert.rejects(p.next(s.task,[fileTool]),{code});assert.equal(seen.length,1);assert.equal(seen[0].response,undefined);
 const journal=JSON.parse(readFileSync(s.path,'utf8'));assert.equal(journal.requests.length,1);assert.equal(journal.requests[0].actualUsd,undefined);assert.equal(journal.observedSpend,0);assert.ok(journal.reservedWorstCase>0);
 }finally{s.close();}
});
for(const native of [null,[]])for(const [name,content,code] of [
 ['malformed','not JSON','MALFORMED_RESPONSE'],
 ['invalid args',JSON.stringify({next_action:{kind:'tool',name:'files.read',args:[]}}),'MALFORMED_RESPONSE'],
] as const)test(`${JSON.stringify(native)} native calls still reject ${name} JSON content`,async()=>{
 const s=setup();try{
 const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'offline-only',persist:async()=>{},transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:native,content}}]}))});
 await assert.rejects(p.next(s.task,[fileTool]),{code});
 }finally{s.close();}
});
test('valid native call takes priority over JSON content and preserves its ID',async()=>{
 const s=setup();const seen:AgentEnvelope[]=[];try{
 const payload=completion({kind:'ready',result:'native call must take priority'});Object.assign(payload.choices[0].message,{tool_calls:[nativeCall]});
 const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'offline-only',persist:async e=>{seen.push(e);},transport:async()=>new Response(JSON.stringify(payload))});
 const decision={kind:'batch',calls:[{callId:nativeCall.id,name:'files.read',args:{}}]};assert.deepEqual(await p.next(s.task,[fileTool]),decision);
 assert.deepEqual(seen[1].response,{decision,usage:{inputTokens:100,outputTokens:20},providerCallId:nativeCall.id});
 }finally{s.close();}
});
test('loopback HTTP mock selects real registered file read and observes durable result next turn',async()=>{
 const s=setup(); const seen: AgentEnvelope[]=[]; const input=join(s.dir,'selected.txt');writeFileSync(input,'Requirement: invented applicant');
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body); const state=JSON.parse(request.messages[1].content);
 assert.equal(state.registeredTools[0].inputSchema.type,'object');
 if(state.untrustedTask.observations.length){assert.equal(state.untrustedTask.observations[0].data,'Requirement: invented applicant');assert.ok(state.untrustedTask.observations[0].callId);res.end(JSON.stringify(completion({kind:'ready',result:'File observed'})));}
 else res.end(JSON.stringify(completion({kind:'tool',name:'files.read',args:{id:'selected'}})));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 try {
 const provider=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'mock-only',persist:async e=>{seen.push(e);writeFileSync(join(s.dir,`${e.reservation}.json`),JSON.stringify(e));},transport:(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const runtime=new AgentRuntime(s.store,[{name:'files.read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object',properties:{id:{const:'selected'}},required:['id'],additionalProperties:false},parse(v){assert.deepEqual(v,{id:'selected'});return v;}},outputSchema:{jsonSchema:{type:'string'},parse:v=>v},async invoke(_args,ctx){return {callId:ctx.callId,status:'ok',data:readFileSync(input,'utf8'),artifacts:[],evidence:[],observations:['Read actual selected bytes']};}}]);
 await runtime.run(s.task.id,provider,2);assert.equal(s.store.get(s.task.id).status,'ready');assert.equal(seen.length,4);assert.equal(new FileCallBudget(s.path).snapshot().calls,2);assert.ok(seen[3].response?.usage);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}
});
for(const [name,payload,code] of [
 ['malformed args',completion({kind:'tool',name:'files.read',args:'bad'}),'MALFORMED_RESPONSE'],
 ['extra action keys',completion({kind:'ready',result:'x',grant:'all'}),'MALFORMED_RESPONSE'],
 ['malformed calls',{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{},{}]}}]},'MALFORMED_RESPONSE'],
 ['invalid usage',{...completion({kind:'ready',result:'x'}),usage:{prompt_tokens:-1,completion_tokens:2}},'BUDGET_ACCOUNTING_ERROR'],
 ['oversized','x'.repeat(196_609),'RESPONSE_TOO_LARGE'],
] as const)test(name,async()=>{const s=setup();try{const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'mock',persist:async()=>{},transport:async()=>new Response(typeof payload==='string'?payload:JSON.stringify(payload))});await assert.rejects(p.next(s.task,[]),{code});assert.equal(s.budget.snapshot().calls,1);}finally{s.close();}});
test('missing credential, stale state and pre-aborted cancellation never dispatch',async()=>{for(const mode of ['credential','stale','cancel']){const s=setup();let calls=0;const controller=new AbortController();if(mode==='cancel')controller.abort();try{const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=>undefined,persist:async()=>{},signal:controller.signal,isCurrent:()=>mode!=='stale',transport:async()=>{calls++;return new Response('{}');}});await assert.rejects(p.next(s.task,[]),{code:mode==='credential'?'CREDENTIAL_UNAVAILABLE':mode==='stale'?'STALE_RESULT':'TIMEOUT_OR_CANCELLED'});assert.equal(calls,0);}finally{s.close();}}});

test('deadline bounds stalled credential lookup and exhausted durable budget blocks dispatch',async()=>{
 const s=setup();let calls=0;try{
 const p=new NebiusAgentProvider({model,budget:s.budget,timeoutMs:10,credential:()=>new Promise(()=>{}),persist:async()=>{},transport:async()=>{calls++;return new Response('{}');}});
 await assert.rejects(p.next(s.task,[]),{code:'AGENT_PROVIDER_TIMEOUT',message:'AGENT_PROVIDER_TIMEOUT:credential'});assert.equal(calls,0);
 s.budget.stop();await assert.rejects(p.next(s.task,[]),{code:'BUDGET_DENIED'});assert.equal(calls,0);
 }finally{s.close();}
});
test('non-success HTTP body is cancelled without reading error content',async()=>{
 const s=setup();let cancelled=false;try{
 const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
 const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'mock',persist:async()=>{},transport:async()=>new Response(body,{status:429})});
 await assert.rejects(p.next(s.task,[]),{code:'PROVIDER_UNAVAILABLE'});assert.equal(cancelled,true);
 }finally{s.close();}
});
test('runtime cancellation propagates during credential lookup without late dispatch or response persistence',async()=>{const s=setup();let release!:(value:string)=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let calls=0;const seen:AgentEnvelope[]=[];try{const p=new NebiusAgentProvider({model,budget:s.budget,credential:()=>{entered();return new Promise<string>(r=>{release=r;});},persist:async e=>{seen.push(e);},transport:async()=>{calls++;return new Response(JSON.stringify(completion({kind:'ready',result:'late'})));}});const runtime=new AgentRuntime(s.store,[]);const run=runtime.run(s.task.id,p,1);await started;runtime.cancel(s.task.id);await run;release('mock');await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);assert.equal(seen.length,1);assert.equal(seen[0].response,undefined);}finally{s.close();}});
for(const phase of ['transport_headers','response_body'] as const)test(`provider deadline records a distinguishable ${phase} failure without settling or retrying`,async()=>{
 const s=setup(),seen:AgentEnvelope[]=[];let posts=0,aborted=false,bodyCancelled=false;
 try{
  const p=new NebiusAgentProvider({model,budget:s.budget,timeoutMs:25,credential:async()=> 'offline-only',persist:async e=>{seen.push(e);},transport:async(_url,init)=>{
   posts++;init!.signal!.addEventListener('abort',()=>{aborted=true;},{once:true});
   if(phase==='transport_headers')return new Promise<Response>(()=>{});
   return new Response(new ReadableStream<Uint8Array>({cancel(){bodyCancelled=true;}}));
  }});
  await assert.rejects(p.next(s.task,[]),{code:'AGENT_PROVIDER_TIMEOUT',message:`AGENT_PROVIDER_TIMEOUT:${phase}`});
  assert.equal(posts,1);assert.equal(aborted,true);assert.equal(bodyCancelled,phase==='response_body');
  assert.equal(seen.length,1);assert.equal(seen[0].response,undefined);assert.equal(seen[0].attempt!.timeoutMs,25);assert.ok(Number.isFinite(Date.parse(seen[0].attempt!.startedAt)));
  const journal=JSON.parse(readFileSync(s.path,'utf8'));assert.equal(journal.requests.length,1);assert.equal(journal.requests[0].actualUsd,undefined);assert.equal(journal.observedSpend,0);
 }finally{s.close();}
});
test('trusted longer deadlines are bounded; generic default remains 10 seconds',async()=>{
 const s=setup();try{
  const seen:AgentEnvelope[]=[];
  for(const timeoutMs of [undefined,300000,3600000]){
   const p=new NebiusAgentProvider({model,budget:s.budget,timeoutMs,credential:async()=> 'offline-only',persist:async e=>{seen.push(e);},transport:async()=>Response.json(completion({kind:'ready',result:'invented'}))});
   await p.next(s.task,[]);assert.equal(seen.at(-1)!.attempt!.timeoutMs,timeoutMs??10000);
  }
  for(const timeoutMs of [0,1.5,3600001,NaN,Infinity])assert.throws(()=>new NebiusAgentProvider({model,budget:s.budget,timeoutMs,credential:async()=> 'offline-only',persist:async()=>{}}),{code:'REQUEST_BOUND'});
 }finally{s.close();}
});
test('runtime registered argument schema rejects structurally valid but invalid tool input',async()=>{
 const s=setup();let invoked=false;try{
 const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'mock',persist:async()=>{},transport:async()=>new Response(JSON.stringify(completion({kind:'tool',name:'files.read',args:{id:'outside-scope'}})))});
 const runtime=new AgentRuntime(s.store,[{name:'files.read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse(){throw new Error('Invalid selected source');}},outputSchema:{jsonSchema:{},parse:v=>v},async invoke(){invoked=true;throw new Error('must not run');}}]);
 await runtime.run(s.task.id,p,1);assert.equal(invoked,false);const t=s.store.get(s.task.id),o=t.observations.at(-1)!;
 assert.equal(t.status,'working','invalid arguments are correctable feedback, not a blocker');assert.equal(o.status,'failed');assert.equal(o.error?.code,'INVALID_TOOL_ARGUMENTS');assert.match(o.error!.message,/Invalid selected source/);
 }finally{s.close();}
});

// Unknown tool names and reused native call IDs are no longer provider failures: the provider returns the
// decision and the runtime answers it. Security intent: an unregistered tool is never executed.
test('provider passes unknown tools and duplicate native IDs to the runtime, which never executes unknown tools',async()=>{
 const s=setup();let invoked=0;const executed:string[]=[];try{
  const responses=[
   {choices:[{finish_reason:'tool_calls',message:{tool_calls:[{...nativeCall,function:{name:'shell',arguments:'{"command":"touch NEVER_EXECUTE"}'}}]}}],usage:{prompt_tokens:100,completion_tokens:20}},
   completion({kind:'tool',name:'bash',args:{command:'rm -rf /'}}),
   completion({kind:'batch',calls:[{callId:'a',name:'files.read',args:{}},{callId:'b',name:'shell',args:{}}]}),
   {choices:[{finish_reason:'tool_calls',message:{tool_calls:[nativeCall,nativeCall]}}],usage:{prompt_tokens:100,completion_tokens:20}},
   completion({kind:'ready',result:'done'})
  ];
  let n=0;const p=new NebiusAgentProvider({model,budget:s.budget,credential:async()=> 'offline-only',persist:async()=>{},transport:async()=>new Response(JSON.stringify(responses[n++]))});
  const runtime=new AgentRuntime(s.store,[{name:'files.read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:v=>v},outputSchema:{jsonSchema:{type:'string'},parse:v=>v},async invoke(_args,ctx){invoked++;executed.push(ctx.callId);return {callId:ctx.callId,status:'ok',data:'invented',artifacts:[],evidence:[],observations:[]};}}]);
  await runtime.run(s.task.id,p,10);
  const t=s.store.get(s.task.id),refused=t.observations.filter(o=>o.error?.code==='UNREGISTERED_TOOL');
  assert.equal(t.status,'ready');assert.equal(n,5);
  assert.equal(refused.length,3,'native unknown, JSON unknown and a batch naming an unknown tool are each refused');
  for(const o of refused){assert.equal(o.status,'failed');assert.match(o.observations[0]!,/Use only registered tools: files\.read/);}
  assert.equal(invoked,3,'unknown tools never ran; the valid call beside one in a batch ran (a877d28), and both duplicate-ID native calls ran');
  assert.deepEqual(executed,['a','provider-call-1-2','provider-call-1-3'],'IDs already used (including by the refused native call) are relabelled <id>-N');
 }finally{s.close();}
});
