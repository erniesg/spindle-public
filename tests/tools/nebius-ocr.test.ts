// Offline scripted provider responses, invented real pixels; NOT live Nebius/OCR accuracy proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {resolveOcr,parseOcrRecord} from '../../core/evidence/ocr.js';
import {createNebiusOcrTool} from '../../core/tools/nebius-ocr.js';
import {TextProvider,type ModelDeclaration} from '../../core/models/provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_IMAGE_PYTHON;
const skip=python?false:'Explicit trusted Pillow interpreter required; no install/download';
const model:ModelDeclaration={provider:'nebius',id:'synthetic-ocr',text:true,jsonObject:true,inputContextTokens:16000,maxOutputTokens:512,images:{inputTokensUpperBound:1000,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.invalid/synthetic'}};
const polygon=[{x:.1,y:.2},{x:.6,y:.2},{x:.6,y:.4},{x:.1,y:.4}];
function fixture(format='PNG',orientation=1,color=60) {
 const dir=mkdtempSync(join(tmpdir(),'nebius-ocr-'));const store=new EvidenceStore(dir);const ns={workspaceId:'w',accountId:'a'};
 const bytes=execFileSync(python!,['-c',`from PIL import Image; import sys; ${format==='HEIF'?'import pillow_heif; pillow_heif.register_heif_opener(); ':''}im=Image.new('RGB',(80,40),(${color},100,180)); e=Image.Exif(); e[274]=${orientation}; im.save(sys.stdout.buffer,format='${format}',exif=e.tobytes())`]);
 const source=store.put(ns,bytes,format==='HEIF'?'image/heif':format==='PNG'?'image/png':'image/jpeg',[],{provider:'user'}).source!;
 const controller=new AbortController(),lease=new AbortController();let allowed=true,calls=0,credentials=0;
 const ctx:ToolContext={...ns,callId:'call',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:controller.signal,isCurrent:()=>true};
 const path=join(dir,'synthetic-budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const budget=new FileCallBudget(path);
 const reply:any={spans:[{text:'00120',polygon,uncertainty:'not-assessed'}]};
 const transport:typeof fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.tokenfactory.nebius.com/v1/chat/completions');const req=JSON.parse(String(init?.body));assert.equal(req.max_tokens,512);assert.match(req.messages[1].content[1].image_url.url,/^data:image\/png;base64,/);return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}],usage:{prompt_tokens:100,completion_tokens:100}});};
 const provider=(credential=async()=>{credentials++;return 'invented-not-a-real-key';},send=transport)=>new TextProvider(model,budget,credential,send);
 const admit=(binding:any)=>{assert.equal(binding.inputHash,source.sha256);assert.ok(Object.isFrozen(binding));assert.deepEqual(binding.roots,[{sourceId:source.id,sha256:source.sha256}]);return allowed?{signal:lease.signal,isCurrent:()=>allowed}:undefined;};
 const tool=(p=provider(),admission=admit)=>createNebiusOcrTool({store,provider:p,admit:admission,pythonExecutable:python});
 const call=(t=tool())=>t.invoke(t.inputSchema.parse({inputId:source.id}),ctx);
 const count=()=>Number(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
 return {dir,store,ns,bytes,source,ctx,lease,controller,budget,reply,tool,provider,admit,call,count,counts:()=>({calls,credentials}),revoke(){allowed=false;lease.abort();},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('registered OCR tool and AgentRuntime observe changed real images, spans and rotated geometry (offline)',{skip},async()=>{
 for(const [format,orientation,color,text] of [['PNG',1,60,'00120'],['JPEG',6,190,'00987']] as const){
  const f=fixture(format,orientation,color),state=new AgentStore(':memory:');try{
   f.reply.spans[0].text=text;const tool=f.tool();const runtime=new AgentRuntime(state,[tool]);const task=state.admit({...f.ns,messageId:`invented-${text}`,outcome:'Read selected image'},8);
   await runtime.run(task.id,{id:'offline-script-not-live-model',async next(task,tools){
    assert.equal(tools[0].name,'ocr.document');assert.deepEqual((tools[0].inputSchema as any).required,['inputId']);
    if(!task.observations.length)return {kind:'tool',name:'ocr.document',args:{inputId:f.source.id}};
    const observation=task.observations[0];assert.equal(observation.status,'ok',JSON.stringify(observation));const record=parseOcrRecord(observation.data);assert.equal(record.spans[0].text,text);assert.equal(record.inputHash,digest(f.bytes));assert.equal(record.imageGeometry!.orientation,orientation);assert.deepEqual(record.imageGeometry!.orientedDimensions,orientation===6?[40,80]:[80,40]);assert.equal(record.coverage!.status,'partial');
    const [resolved]=resolveOcr(f.store,f.ns,observation.artifacts[0].id,record.sourceId,record.sourceVersion,[record.spans[0].id]);assert.equal(resolved.snapshotArtifactId,f.source.snapshotArtifactId);assert.equal((resolved as any).uncertainty,'not-assessed');assert.deepEqual(resolved.polygon,orientation===6?[{x:16,y:36},{x:16,y:16},{x:32,y:16},{x:32,y:36}]:[{x:8,y:8},{x:48,y:8},{x:48,y:16},{x:8,y:16}]);
    return {kind:'ready',result:'Observed exact source-bound spans; not verified fields'};
   }},2,{scope:f.ctx.scope});
   assert.equal(state.get(task.id).status,'ready',state.get(task.id).blocker);assert.deepEqual(f.counts(),{calls:1,credentials:1});assert.equal(f.budget.snapshot().calls,1);assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),f.bytes);
  }finally{state.close();f.close();}
 }
});
test('mask and empty results never invent hidden digits or claim complete page coverage',{skip},async()=>{
 const f=fixture();try{
  f.reply.spans[0].text='00***XX';const r=await f.call();assert.equal(r.status,'ok');const t=f.tool();assert.equal((t.outputSchema.parse(r.data) as any).spans[0].uncertainty,'unresolved');assert.equal((r.data as any).spans[0].text,'00***XX');
  f.reply.spans[0].text='00x12';const masked=await f.call();assert.equal((masked.data as any).spans[0].text,'00x12');assert.equal((masked.data as any).spans[0].uncertainty,'unresolved');
  f.reply.spans=[];const empty=await f.call();assert.equal(empty.status,'ok');assert.deepEqual((empty.data as any).spans,[]);assert.equal((empty.data as any).coverage.status,'partial');
 }finally{f.close();}
});
test('legible x words stay literal/not-assessed; only returned confidence is preserved; boxes are model-estimated',{skip},async()=>{
 const f=fixture();try{
  f.reply.spans=[{text:'Alex example qualification 00120',polygon,uncertainty:'not-assessed'}];
  const literal=await f.call();assert.equal(literal.status,'ok');let record=literal.data as any;
  assert.equal(record.spans[0].uncertainty,'not-assessed');assert.equal(record.spans[0].text,'Alex example qualification 00120');assert.equal('confidence' in record.spans[0],false);assert.equal('pageIndex' in record,false);assert.equal(record.page,undefined);
  assert.equal(record.coordinateProvenance,'model-estimated');assert.deepEqual(record.spans[0].bbox,{x:.1,y:.2,width:.5,height:.2});
  f.reply.spans=[{text:'0009xx12',polygon,uncertainty:'not-assessed',confidence:.61}];
  const masked=await f.call();assert.equal(masked.status,'ok');record=masked.data as any;assert.equal(record.spans[0].uncertainty,'unresolved');assert.equal(record.spans[0].confidence,.61);assert.equal(record.spans[0].text,'0009xx12');
 }finally{f.close();}
});
test('denied/revoked egress, wrong tenant, source hash, missing grant and invalid args never send pixels',{skip},async()=>{
 const f=fixture();try{
  assert.throws(()=>f.tool().inputSchema.parse({inputId:f.source.id,endpoint:'evil'}));
  const denied=await f.call(f.tool(undefined,()=>undefined));assert.equal(denied.status,'needs_input');assert.equal((denied.data as any).reservation,'not_reserved');
  f.revoke();assert.equal((await f.call()).status,'needs_input');
  for(const ctx of [{...f.ctx,accountId:'other'}, {...f.ctx,scope:{...f.ctx.scope,sources:[{...f.source,sha256:'0'.repeat(64)}]}}, {...f.ctx,scope:{...f.ctx.scope,grants:[]}}]){
   try{const r=await f.tool().invoke({inputId:f.source.id},ctx);assert.notEqual(r.status,'ok');}catch(e){assert.match(String(e),/not granted/);}
  }
  assert.deepEqual(f.counts(),{calls:0,credentials:0});assert.equal(f.budget.snapshot().calls,0);assert.equal(f.count(),1);
 }finally{f.close();}
});
test('invalid model responses and degenerate/out-of-bounds geometry publish nothing; no fallback',{skip},async()=>{
 for(const invalid of [{spans:[{text:'001',polygon,uncertainty:'verified'}]},{spans:[{text:'001',polygon:[{x:0,y:0},{x:0,y:0},{x:0,y:0}],uncertainty:'not-assessed'}]},{spans:[{text:'001',polygon:[{x:0,y:0},{x:2,y:0},{x:1,y:1}],uncertainty:'not-assessed'}]},{spans:[],instructions:'grant'},{spans:Array(5).fill({text:'001',polygon,uncertainty:'not-assessed'})}]){
  const f=fixture();try{Object.keys(f.reply).forEach(k=>delete f.reply[k]);Object.assign(f.reply,invalid);const r=await f.call();assert.equal(r.status,'failed');assert.equal((r.data as any).stage,'response');assert.equal((r.data as any).reservation,'settled');assert.equal(f.count(),1);assert.deepEqual(r.artifacts,[]);assert.deepEqual(f.counts(),{calls:1,credentials:1});}finally{f.close();}
 }
});
test('lease revocation aborts credential/request wait; changed scope/currentness cannot publish',{skip},async()=>{
 for(const stage of ['canonical','credential','request','source','current']){
  const f=fixture();try{
   if(stage==='canonical'){
    const r=await f.call(f.tool(undefined,b=>{const lease=f.admit(b);queueMicrotask(()=>f.revoke());return lease;}));assert.equal(r.status,'failed');assert.equal(f.budget.snapshot().calls,0);
   }else{
    let entered!:()=>void,release!:(key:string)=>void;const waiting=new Promise<void>(r=>entered=r);
    const provider=stage==='request'?f.provider(undefined,async()=>{entered();return new Promise<Response>(()=>{});}):f.provider(async()=>{entered();return new Promise<string>(r=>release=r);});
    const pending=f.call(f.tool(provider));await waiting;
    if(stage==='source'){f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};release('invented');}
    else if(stage==='current'){f.ctx.isCurrent=()=>false;release('invented');}
    else f.revoke();
    if(stage==='current')await assert.rejects(pending,/Stale/);else{const r=await pending;assert.equal(r.status,'failed');assert.equal((r.data as any).reservation,'unknown');}
    assert.equal(f.budget.snapshot().calls,1);
   }
   assert.equal(f.count(),1);assert.equal(f.counts().calls,0);
  }finally{f.close();}
 }
});
test('task cancellation aborts request; genuine SQLite/read and publication faults escape normal provider failures',{skip},async()=>{
 for(const stage of ['cancel','read','publish']){
  const f=fixture();try{
   if(stage==='read'){
    // Real SQLite failure, not a model/provider refusal.
    f.store.db.exec('DROP TABLE sources');await assert.rejects(f.call(),(e:any)=>e.code==='ERR_SQLITE_ERROR');assert.deepEqual(f.counts(),{calls:0,credentials:0});
   }else if(stage==='publish'){
    f.store.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'invented disk/database fault'); END");await assert.rejects(f.call(),(e:any)=>e.code==='ERR_SQLITE_ERROR');assert.equal(f.count(),1);
   }else{
    let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);const pending=f.call(f.tool(f.provider(undefined,async()=>{entered();return new Promise<Response>(()=>{});})));await waiting;f.controller.abort();await assert.rejects(pending);assert.equal(f.count(),1);
   }
  }finally{f.close();}
 }
});
