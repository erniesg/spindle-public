import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentProvider,Task} from '../../core/agent/contracts.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {CallBudget} from '../../core/models/provider.js';
import {runBrowserLoop,type BrowserLoopInput} from '../../tools/demo-browser-loop.js';

const scratch=process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch/spindle-demo-loops';
const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
interface View {snapshotRef:string;fields:{ref:string;name:string;type:string}[];actions:{ref:string}[]}
/** Scripted machinery check only. Real mode has no scripted planner. */
function scripted(observed:{verified:boolean}):AgentProvider{return {id:'scripted-test-NOT-model',async next(t:Readonly<Task>){
 const input=JSON.parse(t.requestedOutcome) as BrowserLoopInput;
 const view=t.observations.map(o=>o.data as View).find(v=>v?.snapshotRef&&v.fields);
 if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
 const field=view.fields.find(f=>!t.decisions.some(d=>d.kind==='tool'&&['browser.fill','browser.upload'].includes(d.name)&&(d.args as {fieldRef?:string}).fieldRef===f.ref));
 if(field){const args={snapshotRef:view.snapshotRef,fieldRef:field.ref};
  if(field.type==='file')return {kind:'tool',name:'browser.upload',args:{...args,artifactId:input.attachments.find(a=>a.field===field.name)!.artifactId}};
  return {kind:'tool',name:'browser.fill',args:{...args,value:input.fields.find(v=>v.name===field.name)!.value}};
 }
 if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};
 if((t.observations.at(-1)?.data as {state?:string})?.state!=='verified')return {kind:'tool',name:'browser.verify_submission',args:{}};
 observed.verified=true;return {kind:'ready',result:'Observed the actual verified receipt after revisit.'};
}};}

test('explicit fictional approval required before resources or provider work',async()=>{
 let called=false;
 await assert.rejects(runBrowserLoop({outputDir:'/unused',executablePath,approveFictionalSubmit:false,provider:{kind:'scripted-test',provider:{id:'not-called',async next(){called=true;return {kind:'ready',result:'bad'};}}}}),/FICTIONAL_SUBMIT_APPROVAL_REQUIRED/);
 assert.equal(called,false);
});

test('production runtime fills changed observed forms, uploads exact bytes, verifies/revisits once, and persists session',async()=>{
 mkdirSync(scratch,{recursive:true});
 for(const variant of [0,1] as const){const root=mkdtempSync(join(scratch,'browser-test-'));const observed={verified:false};
  try{const result=await runBrowserLoop({outputDir:join(root,'run'),executablePath,variant,approveFictionalSubmit:true,recordVideo:variant===0,provider:{kind:'scripted-test',provider:scripted(observed)}});
   assert.equal(result.accepted,true,JSON.stringify(result));assert.equal(observed.verified,true);assert.equal(result.recordCount,1);assert.equal(result.fileBytesVerified,true);assert.equal(result.mode,'scripted-test');
   assert.ok(result.screenshots.length>=4);if(variant===0)assert.ok(result.videos.length>0);
   const session=JSON.parse(readFileSync(join(root,'run','visible-session.json'),'utf8'));
   assert.equal(session.mode,'scripted-test');assert.equal(session.status,'ready');assert.equal(session.modelCalls.length,0);assert.ok(session.decisions.some((d:{name:string})=>d.name==='browser.verify_submission'));
   assert.doesNotMatch(JSON.stringify(session),/\/home\/ubuntu|Authorization|Bearer /);
   const tasks=new AgentStore(join(root,'run','tasks.sqlite'));const store=new EvidenceStore(join(root,'run','evidence'));
   try{const task=tasks.get(result.taskId);assert.equal(task.browser?.submission?.state,'verified');assert.ok(store.read({accountId:'fictional-owner',workspaceId:'fictional-demo'},task.browser!.submission!.evidence!.artifactId).length);}finally{tasks.close();store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});

test('injected offline Nebius HTTP uses real adapter parsing and persisted envelopes, without exporting credentials',async()=>{
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'browser-nebius-offline-'));
 const planner=scripted({verified:false}),budget=new CallBudget(1,16);let requests=0;
 try{const result=await runBrowserLoop({outputDir:join(root,'run'),executablePath,approveFictionalSubmit:true,recordVideo:false,provider:{kind:'nebius',options:{
  model:{provider:'nebius',id:'offline-fixture-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:0.3,outputUsdPerMillion:0.9,verifiedAt:'2026-10-28',source:'https://example.test/offline-pricing'}},budget,
  credential:async()=>'sk-offline-secret-sentinel',transport:async(_url,init)=>{
   requests++;const request=JSON.parse(String(init?.body));const message=JSON.parse(request.messages[1].content);
   const decision=await planner.next(message.untrustedTask,message.registeredTools);
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:decision})}}],usage:{prompt_tokens:100,completion_tokens:30}}));
  }
 }}});
 assert.equal(result.accepted,true);assert.equal(result.proof,'injected-nebius-transport');assert.ok(requests>5);
 const session=JSON.parse(readFileSync(join(root,'run','visible-session.json'),'utf8'));
 assert.equal(session.modelCalls.length,requests);assert.ok(session.modelCalls.every((c:{responsePersisted:boolean})=>c.responsePersisted));assert.doesNotMatch(JSON.stringify(session),/offline-secret-sentinel|system|developer|reasoning/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('visible export preserves observed refs for batch decisions and persisted model envelopes',async()=>{
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'browser-batch-export-'));
 const planner:AgentProvider={id:'scripted-batch-NOT-model',async next(t){
  const input=JSON.parse(t.requestedOutcome) as BrowserLoopInput,view=t.observations.map(o=>o.data as View).find(v=>v?.snapshotRef&&v.fields);
  if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
  if(!t.decisions.some(d=>d.kind==='batch'))return {kind:'batch',calls:view.fields.map((f,i)=>({callId:`observed-${i}`,name:f.type==='file'?'browser.upload':'browser.fill',args:{snapshotRef:view.snapshotRef,fieldRef:f.ref,...(f.type==='file'?{artifactId:input.attachments.find(a=>a.field===f.name)!.artifactId}:{value:input.fields.find(v=>v.name===f.name)!.value})}}))};
  if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};
  if(!t.observations.some(o=>(o.data as {state?:string})?.state==='verified'))return {kind:'tool',name:'browser.verify_submission',args:{}};
  return {kind:'ready',result:'Observed retained receipt'};
 }};
 try{
  const result=await runBrowserLoop({outputDir:join(root,'run'),executablePath,approveFictionalSubmit:true,recordVideo:false,provider:{kind:'nebius',options:{model:{provider:'nebius',id:'offline-batch-export',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:.3,outputUsdPerMillion:.9,verifiedAt:'2026-10-28',source:'https://example.test/pricing'}},budget:new CallBudget(1,10),credential:async()=>'offline-only',transport:async(_url,init)=>{const request=JSON.parse(String(init?.body)),message=JSON.parse(request.messages[1].content),decision=await planner.next(message.untrustedTask,message.registeredTools);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:decision})}}],usage:{prompt_tokens:100,completion_tokens:30}}));}}}});
  assert.equal(result.accepted,true);const session=JSON.parse(readFileSync(join(root,'run','visible-session.json'),'utf8'));
  const batch=session.decisions.find((d:{kind:string})=>d.kind==='batch'),view=session.results.find((r:{data?:View})=>r.data?.snapshotRef).data;
  assert.deepEqual(batch.calls.map((c:{args:{fieldRef:string}})=>c.args.fieldRef),view.fields.map((f:{ref:string})=>f.ref));assert.ok(batch.calls.every((c:{args:{snapshotRef:string}})=>c.args.snapshotRef===view.snapshotRef));
  assert.deepEqual(session.modelCalls.find((c:{decision:{kind:string}})=>c.decision.kind==='batch').decision,batch);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('post-dispatch refill is blocked; evidence counts the actual committed receipt after server drain',async()=>{
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'browser-refill-')),base=scripted({verified:false});
 try{
  const result=await runBrowserLoop({outputDir:join(root,'run'),executablePath,approveFictionalSubmit:true,recordVideo:false,provider:{kind:'scripted-test',provider:{id:'scripted-invalid-refill-NOT-model',async next(t,metadata,context){
   if(t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit')){
    const view=t.observations.map(o=>o.data as View).find(v=>v?.snapshotRef&&v.fields)!;
    return {kind:'tool',name:'browser.fill',args:{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Mira Example'}};
   }
   return base.next(t,metadata,context);
  }}}});
  assert.equal(result.accepted,false);assert.equal(result.status,'blocked');assert.equal(result.recordCount,1);assert.equal(result.fileBytesVerified,true);
  assert.equal(result.providerObservedVerification,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('premature provider Ready is not acceptance and shared caller stores remain open',async()=>{
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'browser-early-'));
 const tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const namespace={accountId:'fictional-mail-owner',workspaceId:'fictional-demo'};
 const task=tasks.admit({...namespace,messageId:'invented-email',outcome:'Invented email request'},128);
 try{const result=await runBrowserLoop({outputDir:join(root,'run'),executablePath,approveFictionalSubmit:true,recordVideo:false,binding:{tasks,store,namespace,taskId:task.id},provider:{kind:'scripted-test',provider:{id:'premature-ready',async next(){return {kind:'ready',result:'Not actually submitted'};}}}});
  assert.equal(result.accepted,false);assert.equal(result.recordCount,0);assert.equal(tasks.get(task.id).status,'blocked');assert.equal(result.taskId,task.id);assert.ok(store.db.prepare('SELECT 1').get());
 }finally{tasks.close();store.close();rmSync(root,{recursive:true,force:true});}
});
