// Invented real raster + lineage fixture. Injected HTTP only, never live Nebius.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {resolveOcr,parseOcrRecord} from '../../core/evidence/ocr.js';
import {createNebiusOcrTool} from '../../core/tools/nebius-ocr.js';
import {createImageTools} from '../../core/tools/images.js';
import {TextProvider,type ModelDeclaration} from '../../core/models/provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_HEIF_PYTHON;
const skip=python?false:'Trusted pinned HEIF/Pillow interpreter required';
const model:ModelDeclaration={provider:'nebius',id:'synthetic-ocr',text:true,jsonObject:true,inputContextTokens:16000,maxOutputTokens:512,images:{inputTokensUpperBound:1000,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.invalid/synthetic'}};
test('real HEIF -> derived PNG -> admitted OCR keeps both hashes and exact derived image citation',{skip},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heif-ocr-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
 try{
  const bytes=execFileSync(python!,['-c',"from PIL import Image; import pillow_heif,sys; pillow_heif.register_heif_opener(); Image.new('RGB',(80,40),'blue').save(sys.stdout.buffer,format='HEIF',quality=-1)"]);
  const source=store.put(ns,bytes,'image/heif',[],{provider:'user'}).source!;
  const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
  const crop=createImageTools(store,{pythonExecutable:python}).find(t=>t.name==='image.crop_resize')!;
  const derived=await crop.invoke({inputId:source.id,parameters:{format:'PNG',crop:[0,0,80,40],width:40,height:20,backgroundRGB:[255,255,255],maxBytes:100000,quality:90}},ctx);assert.equal(derived.status,'ok');const image=derived.artifacts[0];
  const journal=join(dir,'synthetic-budget.json');writeFileSync(journal,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const budget=new FileCallBudget(journal);let calls=0,credentials=0;
  const value={spans:[{text:'0007***',uncertainty:'unresolved',polygon:[{x:0,y:0},{x:.5,y:0},{x:.5,y:.5},{x:0,y:.5}]}]};
  let missingUsage=false;
  const provider=new TextProvider(model,budget,async()=>{credentials++;return 'invented';},async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}],...(!missingUsage?{usage:{prompt_tokens:100,completion_tokens:100}}:{})});});
  let selected=image;
  const tool=createNebiusOcrTool({store,provider,pythonExecutable:python,admit:binding=>{assert.equal(binding.artifactId,selected.id);assert.equal(binding.inputHash,selected.sha256);assert.deepEqual(binding.roots,[{sourceId:source.id,sha256:source.sha256}]);return{signal:ctx.signal,isCurrent:()=>true};}});
  const r=await tool.invoke({inputId:image.id},ctx);assert.equal(r.status,'ok');const record=parseOcrRecord(tool.outputSchema.parse(r.data));assert.equal(record.sourceVersion,digest(bytes));assert.equal(record.inputHash,image.sha256);assert.deepEqual(record.imageGeometry!.encodedDimensions,[40,20]);
  const [citation]=resolveOcr(store,ns,r.artifacts[0].id,source.id,source.sha256,[record.spans[0].id]);assert.equal(citation.snapshotArtifactId,image.id);assert.equal(citation.uncertainty,'unresolved');assert.equal(citation.text,'0007***');assert.notEqual(citation.snapshotArtifactId,source.snapshotArtifactId);
  // Same public OCR factory also decodes original HEIF, not only preconverted PNG.
  selected=store.artifact(ns,source.snapshotArtifactId);missingUsage=true;
  const original=await tool.invoke({inputId:source.id},ctx);assert.equal(original.status,'ok',JSON.stringify(original));assert.equal((original.data as any).imageGeometry.geometryBasis,'libheif-display-raster-edges');assert.equal((original.data as any).imageGeometry.originalOrientation,1);assert.equal((original.data as any).inputHash,source.sha256);assert.ok(new FileCallBudget(journal).snapshot().accountedUsd>0);
  // Exhausted durable synthetic journal does not reach credentials/network.
  const remaining=1-budget.snapshot().accountedUsd;budget.reserve(remaining);
  const denied=await tool.invoke({inputId:source.id},ctx);assert.equal(denied.status,'failed');assert.equal((denied.data as any).reason,'BUDGET_DENIED');assert.equal((denied.data as any).reservation,'unknown');assert.equal(credentials,2);assert.equal(calls,2);
  assert.deepEqual(store.read(ns,source.snapshotArtifactId),bytes);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
