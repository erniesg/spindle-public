// Invented synthetic pixels only (no real faces); checks deterministic geometry of portrait helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvidenceStore } from '../../core/evidence/store.js';
import { createImageTools } from '../../core/tools/images.js';
import type { ToolContext } from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_IMAGE_PYTHON;
const skip=python ? false : 'Set SPINDLE_IMAGE_PYTHON to a trusted Pillow environment; no automatic install/download.';
const scratch=resolve('.local');mkdirSync(scratch,{recursive:true});
function fixture(code:string){
 const dir=mkdtempSync(resolve(scratch,'portrait-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
 const source=store.put(ns,execFileSync(python!,['-c',`from PIL import Image, ImageDraw; import sys\n${code}\nim.save(sys.stdout.buffer,format='PNG')`]),'image/png',[],{provider:'user'}).source!;
 const ctx:ToolContext={callId:'c',taskId:'t',runId:'r',...ns,scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
 const tools=createImageTools(store,{pythonExecutable:python});
 const call=(name:string,parameters:unknown)=>{const t=tools.find(t=>t.name===`image.${name}`)!;return t.invoke(t.inputSchema.parse({inputId:source.id,parameters}),ctx);};
 const pixels=(id:string,points:number[][])=>JSON.parse(execFileSync(python!,['-c',"import sys,json;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');print(json.dumps({'size':im.size,'px':[list(im.getpixel((x,y))) for (x,y) in json.loads(sys.argv[2])]}))",resolve(dir,store.artifact(ns,id).relativePath),JSON.stringify(points)]).toString()) as {size:number[];px:number[][]};
 return {store,ns,call,pixels,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
// Transparent canvas with an opaque "person": hair top at y=100, face 100..400 (chin y=400), shoulders below.
const person="im=Image.new('RGBA',(600,800),(0,0,0,0));d=ImageDraw.Draw(im);d.ellipse((200,100,400,400),fill=(200,150,120,255));d.rectangle((120,420,480,800),fill=(20,20,20,255))";
test('fit_photo produces the exact requested size with the head at the requested proportion, measured from the matte',{skip},async()=>{
 const f=fixture(person);try{
  const r=await f.call('fit_photo',{faceBox:[230,180,370,400],width:400,height:514,headHeight:60,topMargin:10});
  assert.equal(r.status,'ok',JSON.stringify(r.error));const fit=(r.data as any).fitPhoto??(r.data as any).metadata?.fitPhoto;
  assert.equal(fit.headTopBasis,'matte');assert.equal(fit.headTop,100);assert.equal(fit.achievedHeadHeightPercent,60);
  const out=f.pixels(r.artifacts[0]!.id,[[200,5],[5,500],[200,300]]);assert.deepEqual(out.size,[400,514]);
  assert.deepEqual(out.px[0],[255,255,255]);assert.ok(out.px[2][0]>150,'face centred in frame');
 }finally{f.close();}
});
test('healing clone matches the surrounding colour and never copies the blemish; overlapping sources are refused',{skip},async()=>{
 const f=fixture("im=Image.new('RGBA',(300,300),(180,140,120,255));d=ImageDraw.Draw(im);d.rectangle((140,140,160,160),fill=(90,20,20,255));d.rectangle((20,20,60,60),fill=(200,160,140,255))");try{
  const overlap=await f.call('retouch',{mask:[130,130,170,170],cloneFrom:[140,130]});assert.equal(overlap.status,'failed');assert.match(overlap.error!.message,/overlaps the mask/);
  const r=await f.call('retouch',{mask:[130,130,170,170],cloneFrom:[20,20]});assert.equal(r.status,'ok',JSON.stringify(r.error));
  const out=f.pixels(r.artifacts[0]!.id,[[150,150],[5,5],[100,100]]);
  // Centre was the dark blemish (90,20,20); after healing it matches the surrounding skin (180,140,120), not the brighter source.
  for(const [i,v] of out.px[0]!.entries())assert.ok(Math.abs(v-[180,140,120][i]!)<=6,`centre channel ${i}=${v}`);
  assert.deepEqual(out.px[1],[180,140,120]);assert.deepEqual(out.px[2],[180,140,120]);
  const inpaint=await f.call('retouch',{mask:[135,135,165,165],fill:'box'});assert.equal(inpaint.status,'ok');
  for(const [i,v] of f.pixels(inpaint.artifacts[0]!.id,[[150,150]]).px[0]!.entries())assert.ok(Math.abs(v-[180,140,120][i]!)<=6,`inpaint channel ${i}=${v}`);
 }finally{f.close();}
});
const birefnet=process.env.SPINDLE_BIREFNET_MODEL;
test('pinned BiRefNet-lite backend produces an RGBA cut-out with model provenance',{skip:python&&birefnet?false:'Set SPINDLE_IMAGE_PYTHON and SPINDLE_BIREFNET_MODEL (pinned BiRefNet-general-lite); no download.',timeout:240000},async()=>{
 const dir=mkdtempSync(resolve(scratch,'birefnet-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
 try{
  const source=store.put(ns,execFileSync(python!,['-c',"from PIL import Image, ImageDraw; import sys\nim=Image.new('RGB',(640,480),(40,120,200));d=ImageDraw.Draw(im);d.ellipse((220,80,420,300),fill=(210,160,130));d.rectangle((160,300,480,480),fill=(20,20,20))\nim.save(sys.stdout.buffer,format='PNG')"]),'image/png',[],{provider:'user'}).source!;
  const ctx:ToolContext={callId:'c',taskId:'t',runId:'r',...ns,scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
  const tool=createImageTools(store,{pythonExecutable:python,modelPath:birefnet}).find(t=>t.name==='image.remove_background')!;
  const r=await tool.invoke(tool.inputSchema.parse({inputId:source.id,parameters:{}}),ctx);
  assert.equal(r.status,'ok',JSON.stringify(r.error));const d=r.data as any;assert.equal(d.metadata.mode,'RGBA');assert.equal((d.inference??d.provenance?.inference)?.model??d.inference?.model,'birefnet-general-lite');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('spot inpaint removes a thin red mark but leaves a nearby dark feature untouched; nothing found changes nothing',{skip},async()=>{
 const f=fixture("import random\nrandom.seed(5)\nim=Image.new('RGBA',(300,300),(200,160,140,255));px=im.load()\nfor y in range(300):\n  for x in range(300):\n    v=random.randint(-4,4);px[x,y]=(200+v,160+v,140+v,255)\nd=ImageDraw.Draw(im);d.line((100,100,130,140),fill=(205,120,115,255),width=3);d.ellipse((170,110,200,135),fill=(60,40,40,255))");try{
  const r=await f.call('retouch',{mask:[95,95,210,145]});assert.equal(r.status,'ok',JSON.stringify(r.error));
  const out=f.pixels(r.artifacts[0]!.id,[[115,120],[185,122],[20,20]]);
  assert.ok(Math.abs(out.px[0]![1]!-160)<=12,`scratch healed ${out.px[0]}`);assert.ok(out.px[1]![0]!<90,`dark feature kept ${out.px[1]}`);
  const none=await f.call('retouch',{mask:[10,10,40,40]});assert.equal(none.status,'failed');assert.match(none.error!.message,/No blemish-like mark/);
 }finally{f.close();}
});
