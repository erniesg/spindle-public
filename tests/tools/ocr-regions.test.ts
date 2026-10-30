// Invented real PDF/Pillow rasters + scripted OCR HTTP responses only. NOT model accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PDFDocument,degrees,rgb} from 'pdf-lib';
import type {ToolContext,ToolResult} from '../../core/agent/contracts.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {parseOcrRecord,resolveOcr,mapOcrPolygon,ocrBoundingBox,type OcrPageGeometry} from '../../core/evidence/ocr.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import {createImageTools} from '../../core/tools/images.js';
import {createNebiusOcrTool} from '../../core/tools/nebius-ocr.js';
import {createOcrRegionTool,createOcrTool} from '../../core/tools/ocr.js';
import {TextProvider,type ModelDeclaration} from '../../core/models/provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
const python=process.env.SPINDLE_IMAGE_PYTHON,heifPython=process.env.SPINDLE_HEIF_PYTHON,pdftoppm=process.env.SPINDLE_PDFTOPPM;
const skip=python&&pdftoppm?false:'Explicit trusted Pillow and SPINDLE_PDFTOPPM renderer required; no install/download';
const model:ModelDeclaration={provider:'nebius',id:'synthetic-ocr-boxes',text:true,jsonObject:true,inputContextTokens:16000,maxOutputTokens:512,images:{inputTokensUpperBound:1000,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.invalid/synthetic'}};
async function fixture(rotation=0,resize=false){
 const dir=mkdtempSync(join(tmpdir(),'ocr-regions-')),store=new EvidenceStore(dir),state=new AgentStore(join(dir,'tasks.sqlite')),ns={workspaceId:'w',accountId:'a'};
 const pdf=await PDFDocument.create();pdf.addPage([400,300]).drawText('Invented distractor page - NOT cited');
 const page=pdf.addPage([400,300]);page.setRotation(degrees(rotation));
 const origin=rotation===270?[20,30]:[0,0];page.setMediaBox(origin[0],origin[1],400,300);page.setCropBox(origin[0],origin[1],400,300);
 const text=rotation===270?'Changed layout 00987':'Alex example 00120';
 const x=(rotation===270?80:40)+origin[0],y=(rotation===270?100:180)+origin[1],w=260,h=32;
 page.drawText(text,{x,y:y+8,size:18,color:rgb(0,0,0)});page.drawRectangle({x,y,width:w,height:h,borderColor:rgb(.6,.6,.6),borderWidth:.5});
 const pdfBytes=Buffer.from(await pdf.save()),source=store.put(ns,pdfBytes,'application/pdf',[],{provider:'user'}).source!;
 const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing','image.processing'],destinations:[]},budget:{used:0,limit:20},signal:new AbortController().signal,isCurrent:()=>true};
 const exported=await createDocumentTools(store,{pdftoppmExecutable:pdftoppm}).find(t=>t.name==='document.export')!.invoke({inputId:source.id,format:'png',pageIndex:1},ctx);
 assert.equal(exported.status,'ok',JSON.stringify(exported));const renderArtifact=exported.artifacts[0],renderBytes=store.read(ns,renderArtifact.id),rw=renderBytes.readUInt32BE(16),rh=renderBytes.readUInt32BE(20);
 let inputArtifact=renderArtifact,inputToRender=[1,0,0,0,1,0];const observations:ToolResult[]=[exported];
 if(resize){
  const crop=rotation===270?[100,100,rw-100,rh-100]:[0,0,rw,rh],width=rotation===270?500:600,height=rotation===270?700:800;
  const scaled=await createImageTools(store,{pythonExecutable:python}).find(t=>t.name==='image.crop_resize')!.invoke({inputId:renderArtifact.id,parameters:{crop,width,height,format:'PNG',backgroundRGB:[255,255,255],quality:90,maxBytes:1000000}},ctx);assert.equal(scaled.status,'ok',JSON.stringify(scaled));observations.push(scaled);inputArtifact=scaled.artifacts[0];inputToRender=[(crop[2]-crop[0])/width,0,crop[0],0,(crop[3]-crop[1])/height,crop[1]];
 }
 const inputBytes=store.read(ns,inputArtifact.id),iw=inputBytes.readUInt32BE(16),ih=inputBytes.readUInt32BE(20);
 // Actual parsed PDF rotation + returned PNG dimensions, not model-provided page identity.
 const parsed=await PDFDocument.load(pdfBytes),actual=parsed.getPage(1),crop=actual.getCropBox(),angle=actual.getRotation().angle;
 const matrices:Record<number,number[]>={0:[1,0,-crop.x,0,-1,crop.y+crop.height],90:[0,1,-crop.y,1,0,-crop.x],270:[0,-1,crop.y+crop.height,-1,0,crop.x+crop.width]};
 const pagePoints=angle===90||angle===270?[crop.height,crop.width]:[crop.width,crop.height],pdfToPage=matrices[angle];
 const pagePolygon=mapOcrPolygon([{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}],pdfToPage);
 const renderPolygon=pagePolygon.map(p=>({x:p.x*rw/pagePoints[0],y:p.y*rh/pagePoints[1]}));
 const polygon=renderPolygon.map(p=>({x:(p.x-inputToRender[2])/inputToRender[0]/iw,y:(p.y-inputToRender[5])/inputToRender[4]/ih}));
 const geometry:OcrPageGeometry={documentArtifactId:source.snapshotArtifactId,documentHash:source.sha256,pageIndex:1,renderArtifactId:renderArtifact.id,renderHash:renderArtifact.sha256,renderPixelDimensions:[rw,rh],pagePoints,rotation:angle,cropBox:[crop.x,crop.y,crop.width,crop.height],userUnit:1,pdfToPage,inputToRender,coordinateSystem:'displayed-crop-top-left-points'};
 const journal=join(dir,'synthetic-budget.json');writeFileSync(journal,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const budget=new FileCallBudget(journal);let calls=0,credentials=0;
 const reply:any={spans:[{text,polygon,uncertainty:'not-assessed',confidence:.57}]};
 const provider=new TextProvider(model,budget,async()=>{credentials++;return 'invented';},async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}],usage:{prompt_tokens:100,completion_tokens:100}});});
 // A trusted integration adapter reads actual persisted ToolResult provenance. No DB schema coupling in OCR.
 const task=state.admit({...ns,messageId:`invented-${rotation}`,outcome:'Display source-bound OCR regions'},20);
 state.update(task.id,t=>{t.observations.push(...observations);});ctx.taskId=task.id;
 const resolvePageGeometry=(context:ToolContext,id:string)=>{
  assert.equal(id,inputArtifact.id);const history=state.get(context.taskId).observations;
  const render=history.find(o=>o.artifacts.some(a=>a.id===renderArtifact.id))!;
  assert.equal((render.data as any).parameters.pageIndex,1);assert.equal((render.data as any).inputHash,geometry.documentHash);assert.equal(render.artifacts[0].sha256,geometry.renderHash);
  if(resize)assert.ok(history.some(o=>o.artifacts.some(a=>a.id===inputArtifact.id)));
  return geometry;
 };
 const ocr=(resolveGeometry:typeof resolvePageGeometry|undefined=resolvePageGeometry)=>createNebiusOcrTool({store,provider,admit:()=>({signal:ctx.signal,isCurrent:()=>true}),pythonExecutable:python,resolvePageGeometry:resolveGeometry});
 const overlay=createOcrRegionTool({store,pythonExecutable:python});
 return{dir,store,state,ns,ctx,task,source,pdfBytes,inputArtifact,inputBytes,renderBytes,geometry,pagePolygon,reply,provider,ocr,overlay,counts:()=>({calls,credentials}),budget,close(){state.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
function near(actual:any[],expected:any[]){assert.equal(actual.length,expected.length);actual.forEach((p,i)=>{assert.ok(Math.abs(p.x-expected[i].x)<1e-6,JSON.stringify([p,expected[i]]));assert.ok(Math.abs(p.y-expected[i].y)<1e-6);});}
test('registered persisted-span overlays bind actual page1/hash, rotation, changed layout and crop/resize scale (offline)',{skip},async()=>{
 for(const [rotation,resize] of [[0,false],[90,true],[270,true]] as const){
  const f=await fixture(rotation,resize);try{
   const runtime=new AgentRuntime(f.state,[f.ocr(),f.overlay]);
   await runtime.run(f.task.id,{id:'offline-script-not-live-model',async next(task,tools){
    assert.ok(tools.some(t=>t.name==='ocr.render_regions'));
    const ocr=task.observations.find(o=>(o.data as any)?.kind==='spindle.ocr.v1');
    if(!ocr)return{kind:'tool',name:'ocr.document',args:{inputId:f.inputArtifact.id}};
    assert.equal(ocr.status,'ok',JSON.stringify(ocr));const record=parseOcrRecord(ocr.data);assert.equal(record.page!.pageIndex,1);assert.equal(record.page!.renderHash,f.geometry.renderHash);assert.equal(record.spans[0].confidence,.57);assert.equal(record.coordinateProvenance,'model-estimated');
    const [region]=resolveOcr(f.store,f.ns,ocr.artifacts[0].id,record.sourceId,record.sourceVersion,[record.spans[0].id]);assert.equal(region.snapshotArtifactId,f.inputArtifact.id);assert.equal(region.imageHash,f.inputArtifact.sha256);assert.equal(region.pageHash,f.geometry.renderHash);near(region.pagePolygon!,f.pagePolygon);assert.equal(region.pageCoordinateSpace,'displayed-crop-top-left-points');assert.equal(region.coordinateProvenance,'model-estimated');assert.deepEqual(region.sourcePixelDimensions,[f.inputBytes.readUInt32BE(16),f.inputBytes.readUInt32BE(20)]);
    const preview=task.observations.find(o=>(o.data as any)?.kind==='spindle.ocr.regions.v1');
    if(!preview)return{kind:'tool',name:'ocr.render_regions',args:{ocrArtifactId:ocr.artifacts[0].id,spanIds:[record.spans[0].id]}};
    assert.equal(preview.status,'ok',JSON.stringify(preview));const data=preview.data as any;assert.equal(data.coordinateProvenance,'model-estimated');assert.equal(data.preview.pixelAccuracyVerified,false);assert.equal(data.preview.formSemanticsVerified,false);assert.equal(data.inputHash,f.inputArtifact.sha256);assert.equal(data.canonicalHash,record.canonicalHash);assert.equal(data.regions[0].pageIndex,1);
    return{kind:'ready',result:'Local estimated regions rendered; not form semantics or pixel-accuracy acceptance'};
   }},3,{scope:f.ctx.scope});
   const completed=f.state.get(f.task.id);assert.equal(completed.status,'ready',completed.blocker);const preview=completed.observations.find(o=>(o.data as any)?.kind==='spindle.ocr.regions.v1')!,record=completed.observations.find(o=>(o.data as any)?.kind==='spindle.ocr.v1')!.data as any;
   const bytes=f.store.read(f.ns,preview.artifacts[0].id),dims=(preview.data as any).preview.canonicalDimensions;
   // Actual Pillow pixel readback: red polygon border and preserved interior raster.
   const check=execFileSync(python!,['-c',"from PIL import Image,ImageChops,ImageDraw; import sys,io,json,base64; v=json.load(sys.stdin); a=Image.open(io.BytesIO(base64.b64decode(v['a']))).convert('RGB'); b=Image.open(io.BytesIO(base64.b64decode(v['b']))).convert('RGB'); x,y=v['point']; red=sum(1 for py in range(max(0,y-3),min(b.height,y+4)) for px in range(max(0,x-3),min(b.width,x+4)) if (lambda p:p[0]>150 and p[1]<80 and p[2]<80)(b.getpixel((px,py)))); assert red>0; assert b.height>a.height; l,t,r,bottom=v['box']; glyph=a.crop((l+4,t+4,r-4,bottom-4)).convert('L'); assert sum(glyph.histogram()[:80])>20; diff=ImageChops.difference(a,b.crop((0,0,a.width,a.height))); ImageDraw.Draw(diff).rectangle((max(0,l-4),max(0,t-24),min(a.width,r+4),min(a.height,bottom+4)),fill=(0,0,0)); assert diff.getbbox() is None; print('actual glyphs enclosed, red overlay pixels, outside-region pixels preserved, separate readable legend')"],{input:JSON.stringify({a:f.inputBytes.toString('base64'),b:bytes.toString('base64'),point:[Math.round(record.spans[0].polygon[0].x*dims[0]),Math.round(record.spans[0].polygon[0].y*dims[1])],box:[Math.floor(record.spans[0].bbox.x*dims[0]),Math.floor(record.spans[0].bbox.y*dims[1]),Math.ceil((record.spans[0].bbox.x+record.spans[0].bbox.width)*dims[0]),Math.ceil((record.spans[0].bbox.y+record.spans[0].bbox.height)*dims[1])]})});assert.match(check.toString(),/actual glyphs enclosed/);
   assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),f.pdfBytes);assert.deepEqual(f.counts(),{calls:1,credentials:1});
   if(process.env.SPINDLE_OCR_REGION_PROOF){const dir=resolve(process.env.SPINDLE_OCR_REGION_PROOF);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`rotation-${rotation}-input.png`),f.inputBytes);writeFileSync(join(dir,`rotation-${rotation}-overlay.png`),bytes);writeFileSync(join(dir,`rotation-${rotation}.json`),JSON.stringify({fixture:'invented PDF page1; offline scripted coordinates, not inference quality',geometry:f.geometry,record,preview:preview.data,outputHash:digest(bytes)},null,2)+'\n');}
  }finally{f.close();}
 }
});
test('PDF page metadata absent/mismatched/degenerate fails before credentials or provider; model cannot choose page or boxes',{skip},async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.ocr().inputSchema.parse({inputId:f.inputArtifact.id,pageIndex:0}));assert.throws(()=>f.overlay.inputSchema.parse({ocrArtifactId:'x',spanIds:['0'.repeat(64)],polygon:[]}));
  for(const geometry of [undefined,{...f.geometry,documentHash:'0'.repeat(64)},{...f.geometry,renderHash:'0'.repeat(64)},{...f.geometry,pdfToPage:[1,0,0,0,0,0]},{...f.geometry,inputToRender:[2,0,0,0,2,0]},{...f.geometry,renderPixelDimensions:[1,1]}]){
   const tool=createNebiusOcrTool({store:f.store,provider:f.provider,admit:()=>({signal:f.ctx.signal,isCurrent:()=>true}),pythonExecutable:python,resolvePageGeometry:()=>geometry});
   const r=await tool.invoke({inputId:f.inputArtifact.id},f.ctx);assert.equal(r.status,'failed');assert.equal((r.data as any).stage,'page_geometry');assert.deepEqual(r.artifacts,[]);
  }
  assert.deepEqual(f.counts(),{calls:0,credentials:0});assert.equal(f.budget.snapshot().calls,0);
 }finally{f.close();}
});
test('local overlay denies unknown spans/tenant, canonical tampering and genuine publication faults without remote calls',{skip},async()=>{
 const f=await fixture();try{
  const read=await f.ocr().invoke({inputId:f.inputArtifact.id},f.ctx);assert.equal(read.status,'ok');const record=read.data as any,ids=record.spans.map((s:any)=>s.id),artifactId=read.artifacts[0].id;
  for(const [id,spans,ctx] of [[artifactId,['0'.repeat(64)],f.ctx],[artifactId,ids,{...f.ctx,accountId:'other'}],[f.store.put(f.ns,Buffer.from(JSON.stringify({...record,canonicalHash:'0'.repeat(64)})),'application/vnd.spindle.ocr+json',[f.source.id,f.inputArtifact.id]).artifact.id,ids,f.ctx]] as const){
   const before=f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n;const r=await f.overlay.invoke({ocrArtifactId:id,spanIds:spans},ctx);assert.equal(r.status,'failed');assert.deepEqual(r.artifacts,[]);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,before);
  }
  f.store.db.exec("CREATE TRIGGER fail_preview BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'invented preview database fault'); END");await assert.rejects(f.overlay.invoke({ocrArtifactId:artifactId,spanIds:ids},f.ctx),(e:any)=>e.code==='ERR_SQLITE_ERROR');
  assert.deepEqual(f.counts(),{calls:1,credentials:1});
 }finally{f.close();}
});
test('local overlays remain bound to real JPEG/HEIF rotation and legacy NIM without invented page/confidence',{skip:python&&heifPython?false:'Explicit trusted Pillow + pinned HEIF interpreters required'},async()=>{
 for(const backend of ['NIM','JPEG','HEIF']){
  const dir=mkdtempSync(join(tmpdir(),'ocr-image-regions-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
  try{
   const format=backend==='NIM'?'PNG':backend,imagePython=backend==='HEIF'?heifPython:python;
   const bytes=execFileSync(imagePython!,['-c',`from PIL import Image; import sys; ${format==='HEIF'?'import pillow_heif; pillow_heif.register_heif_opener(); ':''}im=Image.new('RGB',(160,100),'white'); e=Image.Exif(); e[274]=${backend==='NIM'?1:6}; im.save(sys.stdout.buffer,format='${format}'${backend==='NIM'?'':',exif=e.tobytes()'})`]);
   const source=store.put(ns,bytes,backend==='HEIF'?'image/heif':backend==='JPEG'?'image/jpeg':'image/png',[],{provider:'user'}).source!;
   const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
   const polygon=[{x:.1,y:.2},{x:.8,y:.2},{x:.8,y:.5},{x:.1,y:.5}];
   let tool;
   if(backend==='NIM')tool=createOcrTool({store,endpoint:'https://example.invalid/v1/ocr',authorize:()=>true,fetch:async()=>Response.json({model:'invented-NIM',data:[{index:0,text_detections:[{text_prediction:{text:'Alex 00120'},bounding_box:{points:polygon}}]}]})});
   else{
    const journal=join(dir,'synthetic-budget.json');writeFileSync(journal,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));
    const provider=new TextProvider(model,new FileCallBudget(journal),async()=>'invented',async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({spans:[{text:'Alex 00120',polygon,uncertainty:'not-assessed'}]})}}],usage:{prompt_tokens:100,completion_tokens:100}}));
    tool=createNebiusOcrTool({store,provider,admit:()=>({signal:ctx.signal,isCurrent:()=>true}),pythonExecutable:imagePython,resolvePageGeometry:()=>{throw Error('Original image must not acquire a page index');}});
   }
   const result=await tool.invoke(backend==='NIM'?{sourceId:source.id}:{inputId:source.id},ctx);assert.equal(result.status,'ok',JSON.stringify(result));const record=parseOcrRecord(tool.outputSchema.parse(result.data));assert.equal(record.page,undefined);assert.equal('confidence' in record.spans[0],false);assert.equal(record.spans[0].uncertainty,'not-assessed');
   const overlay=createOcrRegionTool({store,pythonExecutable:imagePython});const preview=await overlay.invoke({ocrArtifactId:result.artifacts[0].id,spanIds:[record.spans[0].id]},ctx);assert.equal(preview.status,'ok',JSON.stringify(preview));assert.equal((preview.data as any).regions[0].pageIndex,undefined);assert.equal((preview.data as any).coordinateProvenance,backend==='NIM'?'backend-reported':'model-estimated');
   if(backend==='JPEG')assert.deepEqual((preview.data as any).regions[0].sourcePixelDimensions,[160,100]);
   if(backend==='HEIF')assert.deepEqual((preview.data as any).regions[0].sourcePixelDimensions,[100,160]);
   assert.deepEqual(store.read(ns,source.snapshotArtifactId),bytes);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 }
});
test('overlay cancellation/current-source fences publish nothing and close owned worker',{skip},async()=>{
 for(const change of ['cancel','source']){
  const f=await fixture();try{
   const result=await f.ocr().invoke({inputId:f.inputArtifact.id},f.ctx);assert.equal(result.status,'ok');const record=result.data as any;
   const controller=new AbortController();f.ctx.signal=controller.signal;const before=f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n;
   const pending=f.overlay.invoke({ocrArtifactId:result.artifacts[0].id,spanIds:[record.spans[0].id]},f.ctx);
   if(change==='cancel'){controller.abort();await assert.rejects(pending);}else{f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};const rejected=await pending;assert.equal(rejected.status,'failed');}
   assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,before);assert.deepEqual(f.counts(),{calls:1,credentials:1});
  }finally{f.close();}
 }
});
test('derived bbox cannot replace polygon; geometry labels cannot promote model estimates to ground truth',{skip},async()=>{
 const f=await fixture();try{
  const r=await f.ocr().invoke({inputId:f.inputArtifact.id},f.ctx);assert.equal(r.status,'ok');const record=r.data as any;
  assert.deepEqual(record.spans[0].bbox,ocrBoundingBox(record.spans[0].polygon));assert.throws(()=>parseOcrRecord({...record,coordinateProvenance:'backend-reported'}));assert.throws(()=>parseOcrRecord({...record,spans:[{...record.spans[0],bbox:{x:0,y:0,width:1,height:1}}]}));
  for(const confidence of [-.1,1.1,'high',null]){f.reply.spans[0].confidence=confidence;const failed=await f.ocr().invoke({inputId:f.inputArtifact.id},f.ctx);assert.equal(failed.status,'failed');assert.equal((failed.data as any).stage,'response');assert.deepEqual(failed.artifacts,[]);}
 }finally{f.close();}
});
