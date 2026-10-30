// Offline scripted provider responses on invented pixels; NOT live Nebius/OCR accuracy proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {parseOcrRecord} from '../../core/evidence/ocr.js';
import {createNebiusOcrTool} from '../../core/tools/nebius-ocr.js';
import {TextProvider,type ModelDeclaration} from '../../core/models/provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_IMAGE_PYTHON;
const skip=python?false:'Explicit trusted Pillow interpreter required; no install/download';
const declare=(id:string):ModelDeclaration=>({provider:'nebius',id,text:true,jsonObject:true,inputContextTokens:16000,maxOutputTokens:1024,images:{inputTokensUpperBound:1000,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-28',source:'https://example.invalid/synthetic'}});
function fixture(secondLines:string[]|'fail',secondOverrides:Partial<ModelDeclaration>={}){
 const dir=mkdtempSync(join(tmpdir(),'nebius-ocr-zoom-'));const store=new EvidenceStore(dir);const ns={workspaceId:'w',accountId:'a'};
 const bytes=execFileSync(python!,['-c',"from PIL import Image; import sys; Image.new('RGB',(400,200),(250,250,250)).save(sys.stdout.buffer,format='PNG')"]);
 const source=store.put(ns,bytes,'image/png',[],{provider:'user'}).source!;
 const ctx:ToolContext={...ns,callId:'call',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
 const path=join(dir,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const budget=new FileCallBudget(path);
 const seen:{model:string;image:string;text:string;maxTokens:number;thinking?:boolean}[]=[];
 const transport:typeof fetch=async(_url,init)=>{const req=JSON.parse(String(init?.body));seen.push({model:req.model,image:req.messages[1].content[1].image_url.url,text:req.messages[1].content[0].text,maxTokens:req.max_tokens,thinking:req.chat_template_kwargs?.enable_thinking});
  if(req.model==='second'){if(secondLines==='fail')return new Response('down',{status:503});return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({lines:secondLines})}}],usage:{prompt_tokens:10,completion_tokens:10}});}
  // Whole region image, normalized: top-left quarter.
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({spans:[{text:'S1234567D',polygon:[{x:0,y:0},{x:.5,y:0},{x:.5,y:.5},{x:0,y:.5}],uncertainty:'not-assessed'},{text:'123-45678-9',polygon:[{x:.5,y:.5},{x:1,y:.5},{x:1,y:1},{x:.5,y:1}],uncertainty:'not-assessed'}]})}}],usage:{prompt_tokens:10,completion_tokens:10}});};
 const provider=(id:string,overrides:Partial<ModelDeclaration>={})=>new TextProvider({...declare(id),...overrides},budget,async()=>'invented-not-a-real-key',transport);
 const tool=createNebiusOcrTool({store,provider:provider('primary'),secondProvider:provider('second',secondOverrides),admit:()=>({signal:new AbortController().signal,isCurrent:()=>true}),pythonExecutable:python,maximumSpans:16});
 return {store,ctx,seen,tool,source,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('zoomed OCR reads a full-resolution region, maps spans to whole-image coordinates and runs both readers',{skip},async()=>{
 const f=fixture(['S1234567D','123-45678-9']);try{
  const r=await f.tool.invoke(f.tool.inputSchema.parse({inputId:f.source.id,region:[200,100,400,200],focus:'ID and account numbers'}),f.ctx);
  assert.equal(r.status,'ok',JSON.stringify(r.data));const record=parseOcrRecord(r.data);
  assert.deepEqual(f.seen.map(s=>s.model).sort(),['primary','second']);
  assert.ok(f.seen.every(s=>s.text.includes('ID and account numbers')));
  // Region [200,100,400,200] of a 400x200 image: region (0,0) maps to (0.5,0.5); (1,1) maps to (1,1).
  assert.deepEqual(record.spans[0]!.polygon[0],{x:.5,y:.5});assert.deepEqual(record.spans[1]!.polygon[2],{x:1,y:1});
  assert.ok(record.spans.every(s=>s.uncertainty==='not-assessed'));
  assert.ok(r.observations.some(o=>o.includes('agreed with every span')));assert.ok(r.observations.some(o=>o.startsWith('Zoomed read')));
 }finally{f.close();}
});
test('reader disagreement marks the span unresolved and reports both readings; a failed second reader is reported, not fatal',{skip},async()=>{
 const f=fixture(['S123456ID','123-45678-9']);try{
  const r=await f.tool.invoke(f.tool.inputSchema.parse({inputId:f.source.id}),f.ctx);const record=parseOcrRecord(r.data);
  assert.equal(record.spans[0]!.uncertainty,'unresolved');assert.equal(record.spans[1]!.uncertainty,'not-assessed');
  assert.ok(r.observations.some(o=>o.includes('"S1234567D" vs second "S123456ID"')));
 }finally{f.close();}
 const g=fixture('fail');try{
  const r=await g.tool.invoke(g.tool.inputSchema.parse({inputId:g.source.id}),g.ctx);assert.equal(r.status,'ok');
  assert.ok(r.observations.some(o=>o.includes('Second reader second unavailable')));assert.ok(parseOcrRecord(r.data).spans.every(s=>s.uncertainty==='unresolved'),'single-reader spans are not trusted');
 }finally{g.close();}
});
test('a reasoning second reader gets its declared output budget and explicit thinking; a plain one stays capped at 1024',{skip},async()=>{
 const f=fixture(['S1234567D','123-45678-9'],{thinking:true,maxOutputTokens:8192});try{
  const r=await f.tool.invoke(f.tool.inputSchema.parse({inputId:f.source.id}),f.ctx);assert.equal(r.status,'ok');
  const second=f.seen.find(s=>s.model==='second')!;assert.equal(second.maxTokens,8192);assert.equal(second.thinking,true);
 }finally{f.close();}
 const g=fixture(['S1234567D','123-45678-9'],{maxOutputTokens:8192});try{
  await g.tool.invoke(g.tool.inputSchema.parse({inputId:g.source.id}),g.ctx);
  const second=g.seen.find(s=>s.model==='second')!;assert.equal(second.maxTokens,1024);assert.equal(second.thinking,undefined);
 }finally{g.close();}
});
test('OCR rejects malformed zoom arguments before any work',()=>{
 const tool=createNebiusOcrTool({store:{} as EvidenceStore,provider:new TextProvider(declare('p'),{reserve:()=>1,settle(){},stop(){},snapshot:()=>({limitUsd:1,accountedUsd:0,calls:0,exhausted:false})},async()=>'k'),admit:()=>undefined});
 for(const bad of [{inputId:'x',region:[5,5,1,1]},{inputId:'x',rotation:400},{inputId:'x',focus:''},{inputId:'x',extra:1}])assert.throws(()=>tool.inputSchema.parse(bad));
});
