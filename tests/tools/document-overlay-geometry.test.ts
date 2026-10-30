import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {PDFDocument,degrees,PDFName,PDFNumber} from 'pdf-lib';
import {overlayFixture,backend,placement} from './document-overlay-fixtures.js';
import {transform,type Matrix} from '../../core/tools/document-geometry.js';

for(const [rotation,size,crop] of [[0,[400,300],[20,30,350,240]],[90,[600,400],[30,40,500,300]],[180,[400,600],[10,20,360,540]],[270,[650,420],[25,35,600,350]]] as const) test(`actual cropped ${rotation}-degree PDF: pixel placements, text bbox, immutable export and derived render geometry`,async()=>{
 assert.ok(backend.pdftoppmExecutable&&backend.pdftotextExecutable,'Configure actual Poppler paths; this affected test must not skip');
 const doc=await PDFDocument.create();doc.addPage([200,200]);const page=doc.addPage([...size]);page.setCropBox(crop[0],crop[1],crop[2],crop[3]);page.setRotation(degrees(rotation));
 const original=Buffer.from(await doc.save());const f=await overlayFixture(original);
 try {
  const render=await f.call('render',{pageIndex:1});assert.equal(render.status,'ok',JSON.stringify(render));const g=(render.data as any).metadata.render;
  assert.equal(g.pageIndex,1);assert.equal(g.rotation,rotation);assert.deepEqual(g.cropBox,{x:crop[0],y:crop[1],width:crop[2],height:crop[3]});
  assert.deepEqual(g.mediaBox,{x:0,y:0,width:size[0],height:size[1]});assert.equal(g.sourceHash,f.source.sha256);assert.equal(g.imageHash,render.artifacts[0]!.sha256);
  const expected={width:rotation%180?crop[3]:crop[2],height:rotation%180?crop[2]:crop[3]};assert.deepEqual(g.pagePoints,expected);
  const [px,py]=transform(g.pdfToImage as Matrix,crop[0],crop[1]);assert.ok(px>=-1e-7&&px<=g.pixelDimensions.width+1e-7);assert.ok(py>=-1e-7&&py<=g.pixelDimensions.height+1e-7);
  const p=placement(rotation===90?'0012345':'0098765');const pixelPlacement={...p,box:{x:p.box.x*g.scale.x,y:p.box.y*g.scale.y,width:p.box.width*g.scale.x,height:p.box.height*g.scale.y}};
  const result=await f.call('overlay',{pageIndex:1,coordinateSpace:{kind:'render_pixels',imageArtifactId:render.artifacts[0]!.id},placements:[pixelPlacement]});assert.equal(result.status,'ok',JSON.stringify(result));
  const output=result.artifacts[0]!,bytes=f.store.read(f.ns,output.id),reloaded=await PDFDocument.load(bytes);
  assert.equal(reloaded.getPage(1).getRotation().angle,rotation);assert.deepEqual(reloaded.getPage(1).getCropBox(),g.cropBox);assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),original);
  const bbox=spawnSync(backend.pdftotextExecutable!,['-f','2','-l','2','-cropbox','-bbox','-','-'],{input:bytes,timeout:15000,maxBuffer:65536});assert.equal(bbox.status,0);
  const word=bbox.stdout.toString().match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<\/word>/);assert.ok(word,bbox.stdout.toString());assert.equal(word[5],p.value);
  assert.ok(Math.abs(Number(word[1])-p.box.x)<0.1);assert.ok(Math.abs(Number(word[2])-p.box.y)<0.1);assert.ok(Number(word[3])<=p.box.x+p.box.width);assert.ok(Number(word[4])<=p.box.y+p.box.height);
  const exported=await f.call('export',{inputId:output.id,flatten:true});assert.equal(exported.status,'ok',JSON.stringify(exported));
  const rendered=await f.call('render',{inputId:exported.artifacts[0]!.id,pageIndex:1});assert.equal(rendered.status,'ok',JSON.stringify(rendered));assert.notEqual(rendered.artifacts[0]!.sha256,render.artifacts[0]!.sha256);
  const out=`.local/pdf-overlay/pilot-${rotation}`;mkdirSync(out,{recursive:true});for(const [path,data] of [['original.pdf',original],['overlay.pdf',bytes],['render.png',f.store.read(f.ns,rendered.artifacts[0]!.id)],['text-bbox.html',bbox.stdout],['result.json',JSON.stringify({render,result,exported,rendered},null,2)]] as const)writeFileSync(`${out}/${path}`,data);
 }finally{f.close();}
});

test('licensed Unicode font and physical UserUnit geometry retain literal leading zeroes and measured text',async()=>{
 assert.ok(process.env.SPINDLE_DOCUMENT_TEST_FONT,'Configure licensed DejaVu font; this affected test must not skip');
 const doc=await PDFDocument.create();const page=doc.addPage([400,300]);page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));
 const f=await overlayFixture(await doc.save(),{...backend,renderFontPath:process.env.SPINDLE_DOCUMENT_TEST_FONT,renderFontLicense:'Bitstream-Vera + DejaVu-public-domain'});
 try {
  const inspect=await f.call('inspect');const page=(inspect.data as any).metadata.pages[0];assert.equal(page.userUnit,2);assert.deepEqual(page.pagePoints,{width:800,height:600});
  const result=await f.call('overlay',{pageIndex:0,coordinateSpace:{kind:'page_points'},placements:[placement('Živa Ω 0012345')]});assert.equal(result.status,'ok',JSON.stringify(result));assert.equal((result.data as any).renderAssets[0].sha256.length,64);
  const read=await f.call('extract_text',{inputId:result.artifacts[0]!.id,pageIndex:0});assert.equal(read.status,'ok',JSON.stringify(read));assert.match((read.data as any).metadata.text,/Živa Ω 0012345/);
  const render=await f.call('render',{inputId:result.artifacts[0]!.id,pageIndex:0});assert.equal(render.status,'ok',JSON.stringify(render));assert.deepEqual((render.data as any).metadata.render.pixelDimensions,{width:1600,height:1200});
  const out='.local/pdf-overlay/pilot-unicode';mkdirSync(out,{recursive:true});writeFileSync(`${out}/overlay.pdf`,f.store.read(f.ns,result.artifacts[0]!.id));writeFileSync(`${out}/render.png`,f.store.read(f.ns,render.artifacts[0]!.id));
 }finally{f.close();}
});
