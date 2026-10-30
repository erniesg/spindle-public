import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvidenceStore } from '../../core/evidence/store.js';
import type { ToolContext } from '../../core/agent/contracts.js';
import { createImageTools } from '../../core/tools/images.js';
import { TextProvider, type ModelDeclaration } from '../../core/models/provider.js';
import { FileCallBudget } from '../../core/models/file-budget.js';
const python=process.env.SPINDLE_IMAGE_PYTHON;
const skip=python ? false : 'Trusted Pillow configuration required; no download.';
// SYNTHETIC declaration/pricing: no live capability or pricing claim.
const model:ModelDeclaration={provider:'nebius',id:'synthetic-vision',text:true,jsonObject:true,inputContextTokens:16000,maxOutputTokens:512,images:{inputTokensUpperBound:1000,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.invalid/synthetic'}};
function fixture(format='PNG',orientation=1) {
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/vision-'));
 const store=new EvidenceStore(dir), ns={workspaceId:'w',accountId:'a'};
 const bytes=execFileSync(python!,['-c',`from PIL import Image; import sys; im=Image.new('RGB',(80,40)); im.putdata([(x*3,y*6,80) for y in range(40) for x in range(80)]); e=Image.Exif(); e[274]=${orientation}; im.save(sys.stdout.buffer,format='${format}',exif=e)`]);
 const source=store.put(ns,bytes,format==='PNG'?'image/png':'image/jpeg',[],{provider:'user',providerId:'generated-pixels'}).source!;
 const controller=new AbortController(), lease=new AbortController();let allowed=true,calls=0,credentials=0;
 const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:controller.signal,isCurrent:()=>true};
 const path=resolve(dir,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:0.04,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const budget=new FileCallBudget(path);
 const reply={description:'Generated gradient; not a portrait.',regions:[{purpose:'crop',box:[100,100,500,500],reason:'Synthetic proposal'}]}; // 0-1000 normalized = canonical [4,8,20,40] on 40x80
 const transport:typeof fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.tokenfactory.nebius.com/v1/chat/completions');const request=JSON.parse(String(init?.body));assert.match(request.messages[1].content[1].image_url.url,/^data:image\/png;base64,/);return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}],usage:{prompt_tokens:100,completion_tokens:100}});};
 const provider=(getCredential=async()=>{credentials++;return 'synthetic-key';},send=transport)=>new TextProvider(model,budget,getCredential,send);
 const admission=(binding:any)=>{assert.equal(binding.inputHash,source.sha256);assert.deepEqual(binding.roots,[{sourceId:source.id,sha256:source.sha256}]);return allowed ? {signal:lease.signal,isCurrent:()=>allowed} : undefined;};
 const call=(vision?:any,parameters:Record<string,unknown>={})=>createImageTools(store,{pythonExecutable:python,...(vision?{vision}: {})}).find(t=>t.name==='image.inspect')!.invoke({inputId:source.id,parameters},ctx);
 return {dir,store,source,bytes,ctx,controller,lease,budget,path,reply,provider,admission,call,revoke(){allowed=false;lease.abort();},counts:()=>({calls,credentials}),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('competing journal reservation cannot be attributed to a failed image invocation',{skip},async()=>{
 const f=fixture();try {
  const competitor=new FileCallBudget(f.path);
  const provider=f.provider();const complete=provider.complete.bind(provider);let invoked=0;
  // Barrier is at provider invocation, independent of adapter snapshot placement.
  provider.complete=async(...args:Parameters<TextProvider['complete']>)=>{
   invoked++;competitor.reserve(0.04);return complete(...args);
  };
  const r=await f.call({provider,admit:f.admission});const semantic=(r.data as any).semantic;
  assert.equal(invoked,1);assert.equal(semantic.reason,'BUDGET_DENIED');
  assert.deepEqual(f.counts(),{calls:0,credentials:0});assert.equal((r.data as any).metadata.width,80);
  const journal=JSON.parse(readFileSync(f.path,'utf8'));
  assert.deepEqual(journal.requests,[{id:1,maximumUsd:0.04}]);
  assert.equal(journal.reservedWorstCase,0.04);assert.equal(semantic.reservation,'unknown');
  assert.equal(semantic.budgetScope,'shared_aggregate');assert.equal(semantic.budget.calls,1);
 }finally{f.close();}
});
test('metadata remains useful without semantic configuration; denial sends no pixels',{skip},async()=>{
 const f=fixture();try {for(const vision of [undefined,{provider:f.provider(),admit:()=>undefined}]) {const r=await f.call(vision);assert.equal(r.status,'ok');const d=r.data as any;assert.equal(d.metadata.width,80);assert.equal(d.semanticVision,false);assert.equal(d.semantic.status,'needs_input');assert.equal(d.semantic.reservation,'not_reserved');assert.equal(d.semantic.invocation,'not_invoked');assert.equal(r.artifacts.length,0);}assert.deepEqual(f.counts(),{calls:0,credentials:0});}finally{f.close();}
});
test('real JPEG EXIF canonicalization, strict proposals and durable reservation through injected HTTP boundary',{skip},async()=>{
 const f=fixture('JPEG',6);try {const r=await f.call({provider:f.provider(),admit:f.admission});assert.equal(r.status,'ok',JSON.stringify(r));const d=r.data as any;assert.equal(d.semanticVision,true);assert.equal(d.semantic.status,'ok');assert.deepEqual(d.semantic.canonical.encodedDimensions,[80,40]);assert.deepEqual(d.semantic.canonical.orientedDimensions,[40,80]);assert.deepEqual(d.semantic.canonical.canonicalDimensions,[40,80]);assert.equal(d.semantic.canonical.orientation,6);assert.deepEqual(d.semantic.regions[0].sourceBox,[4,8,20,40]);assert.deepEqual(d.semantic.regions[0].encodedPolygon,[[8,36],[8,20],[40,20],[40,36]]);assert.equal(d.semantic.reservation,'settled');assert.equal(d.semantic.producer.model,'synthetic-vision');assert.equal(d.semantic.usage.inputTokens,100);assert.equal(new FileCallBudget(f.path).snapshot().calls,1);assert.deepEqual(f.store.read({workspaceId:'w',accountId:'a'},f.source.snapshotArtifactId),f.bytes);assert.deepEqual(f.counts(),{calls:1,credentials:1});}finally{f.close();}
});
test('malformed, oversized and out-of-bounds semantic proposals cannot hide valid metadata',{skip},async()=>{
 // A bad individual proposal is dropped (counted) without discarding the valid description.
 for(const invalid of [{description:'x',regions:[{purpose:'crop',box:[0,0,9000,10],reason:'x'}]},{description:'x',regions:[{purpose:'retouch',box:[0,0,null,10],reason:'x'}]},{description:'x',regions:[{purpose:['crop'],box:[0,0,10,10],reason:'x'}]}]) {
  const f=fixture();try {Object.assign(f.reply,invalid);const r=await f.call({provider:f.provider(),admit:f.admission});assert.equal(r.status,'ok');const semantic=(r.data as any).semantic;assert.equal(semantic.status,'ok');assert.deepEqual(semantic.regions,[]);assert.equal(semantic.skippedRegions,1);assert.equal(semantic.description,'x');assert.equal((r.data as any).metadata.width,80);assert.equal(semantic.reservation,'settled');}finally{f.close();}
 }
 for(const invalid of [{description:'x',regions:[],grant:'remote'}, {description:'x'.repeat(1025),regions:[]}]) {
  const f=fixture();try {Object.assign(f.reply,invalid);const r=await f.call({provider:f.provider(),admit:f.admission});assert.equal(r.status,'ok');assert.equal((r.data as any).semantic.status,'failed');assert.equal((r.data as any).semanticVision,false);assert.equal((r.data as any).metadata.width,80);assert.equal((r.data as any).semantic.regions,undefined);assert.equal((r.data as any).semantic.reservation,'settled');assert.equal((r.data as any).semantic.invocation,'completed');}finally{f.close();}
 }
});
test('failed provider envelope is unknown; rejected proposal after completion keeps known settlement',{skip},async()=>{
 for(const [content,usage,expected] of [
  ['not json',{prompt_tokens:100,completion_tokens:100},'unknown'],
  [JSON.stringify({description:'Rejected semantic schema',regions:[],unexpected:true}),undefined,'retained'],
 ] as const) {
  const f=fixture();try {
   const provider=f.provider(undefined,async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content}}],...(usage?{usage}:{})}));
   const r=await f.call({provider,admit:f.admission});const d=r.data as any;
   assert.equal(r.status,'ok');assert.equal(d.metadata.width,80);assert.equal(d.semantic.status,'failed');
   assert.equal(d.semantic.reservation,expected);assert.equal(d.semantic.budgetScope,'shared_aggregate');
   assert.equal(new FileCallBudget(f.path).snapshot().calls,1);assert.equal(f.counts().credentials,1);
  }finally{f.close();}
 }
});
test('revocation during credential wait or active request aborts, keeps reservation and metadata; no retry',{skip},async()=>{
 for(const stage of ['credential','request']) {const f=fixture();try {
  let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  const provider=stage==='credential'?f.provider(async()=>{entered();return new Promise<string>(()=>{});}):f.provider(undefined,async(_url,init)=>{entered();return new Promise<Response>((_r,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
  const pending=f.call({provider,admit:f.admission});await waiting;f.revoke();const r=await pending;
  assert.equal((r.data as any).metadata.width,80);assert.equal((r.data as any).semantic.status,'failed');assert.equal((r.data as any).semantic.reservation,'unknown');assert.equal(new FileCallBudget(f.path).snapshot().calls,1);
 }finally{f.close();}}
});
test('missing usage retains durable reservation across reopen; next explicit call cannot bypass exhaustion',{skip},async()=>{
 const f=fixture();try {
  const provider=f.provider(undefined,async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({description:'Synthetic response without usage',regions:[]})}}]}));
  const first=await f.call({provider,admit:f.admission});assert.equal((first.data as any).semantic.reservation,'retained');assert.equal((first.data as any).semantic.usage,null);
  let credentials=0,network=0;const reopened=new TextProvider(model,new FileCallBudget(f.path),async()=>{credentials++;return 'synthetic';},async()=>{network++;throw new Error('must not call');});
  const second=await f.call({provider:reopened,admit:f.admission});assert.equal((second.data as any).semantic.reservation,'unknown');assert.equal((second.data as any).semantic.reason,'BUDGET_DENIED');assert.equal(credentials,0);assert.equal(network,0);assert.equal(new FileCallBudget(f.path).snapshot().calls,1);
 }finally{f.close();}
});
test('revocation while canonicalizing and source replacement during credentials prevent egress',{skip},async()=>{
 for(const stage of ['canonical','source']) {const f=fixture();try {
  if(stage==='canonical') {
   const r=await f.call({provider:f.provider(),admit:(binding:any)=>{const lease=f.admission(binding);queueMicrotask(()=>f.revoke());return lease;}});
   assert.equal((r.data as any).semantic.status,'failed');assert.equal((r.data as any).metadata.width,80);assert.equal((r.data as any).semantic.reservation,'not_reserved');assert.equal(f.budget.snapshot().calls,0);assert.deepEqual(f.counts(),{calls:0,credentials:0});
  } else {
   let entered!:()=>void,release!:(key:string)=>void;const waiting=new Promise<void>(r=>entered=r);
   const provider=f.provider(async()=>{entered();return new Promise<string>(r=>release=r);});
   const pending=f.call({provider,admit:f.admission});await waiting;
   f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};release('synthetic-key');
   const r=await pending;assert.equal(r.status,'failed');assert.deepEqual(r.artifacts,[]);assert.equal((r.data as any).semantic,undefined,'changed source scope cannot retain stale local metadata');assert.equal(f.budget.snapshot().calls,1,'already reserved provider budget is not reset');assert.equal(f.counts().calls,0);
  }
 }finally{f.close();}}
});
test('task cancellation aborts pending semantic request instead of accepting metadata as current',{skip},async()=>{
 const f=fixture();try {
  let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  const provider=f.provider(undefined,async()=>{entered();return new Promise<Response>(()=>{});});
  const pending=f.call({provider,admit:f.admission});await waiting;f.controller.abort();await assert.rejects(pending);assert.equal(f.budget.snapshot().calls,1);
 }finally{f.close();}
});
test('durable exhausted budget refuses credentials/network; args cannot mint grants',{skip},async()=>{
 const f=fixture();try {f.budget.reserve(0.04);const r=await f.call({provider:f.provider(),admit:f.admission});assert.equal((r.data as any).semantic.status,'failed');assert.equal((r.data as any).semantic.reservation,'unknown');assert.deepEqual(f.counts(),{calls:0,credentials:0});const tool=createImageTools(f.store).find(t=>t.name==='image.inspect')!;assert.throws(()=>tool.inputSchema.parse({inputId:f.source.id,parameters:{egress:true}}));}finally{f.close();}
});

test('image.inspect forwards an optional focus to the vision model and still validates it',{skip},async()=>{
 const f=fixture();try{
  let sent='';const provider=f.provider(undefined,async(_url,init)=>{sent=JSON.parse(String(init?.body)).messages[1].content[0].text;return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({description:'Synthetic',regions:[{purpose:'retouch',box:[0,0,500,500],reason:'focus box'}]})}}],usage:{prompt_tokens:10,completion_tokens:10}});});
  const r=await f.call({provider,admit:f.admission},{focus:'cheek blemish retouch box'});assert.equal(r.status,'ok');
  assert.match(sent,/cheek blemish retouch box/);assert.deepEqual((r.data as any).semantic.regions[0].canonicalBox,[0,0,40,20]);
  const tool=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.inspect')!;
  assert.throws(()=>tool.inputSchema.parse({inputId:f.source.id,parameters:{focus:'\u0007bad'}}));
 }finally{f.close();}
});
test('invalid retouch box reports the fixed, actionable parameter message (not decoder text)',{skip},async()=>{
 const f=fixture();try{
  const tool=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.retouch')!;
  const r=await tool.invoke({inputId:f.source.id,parameters:{mask:[40,10,20,8],cloneFrom:[0,0]}},f.ctx);
  assert.equal(r.status,'failed');assert.equal(r.effect,'none');
  assert.match(r.error!.message,/Invalid image parameters: Expected pixel box \[left,top,right,bottom\] inside 80x40 .*got \[40, 10, 20, 8\]/);
 }finally{f.close();}
});
