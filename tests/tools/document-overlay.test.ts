import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import type {ToolContext} from '../../core/agent/contracts.js';

test('flat PDF retains no_editable_fields but supports generic overlay, actual text readback and rendering',async()=>{
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','overlay-'));const store=new EvidenceStore(dir);
 try {
  const doc=await PDFDocument.create();doc.addPage([400,300]).drawText('Invented flat form');
  const original=Buffer.from(await doc.save());const ns={workspaceId:'w',accountId:'invented'};
  const source=store.put(ns,original,'application/pdf',[],{provider:'user',providerId:'flat-invented'}).source!;
  const ctx:ToolContext={...ns,callId:'overlay',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:new AbortController().signal,budget:{used:0,limit:20},isCurrent:()=>true};
  const tools=createDocumentTools(store,{pdftoppmExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOPPM,pdftotextExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOTEXT});
  const call=(name:string,args:object)=>{const t=tools.find(t=>t.name===`document.${name}`);assert.ok(t,`registered document.${name}`);return t.invoke(args,ctx);};
  const old=await call('edit',{inputId:source.id,values:{account:'0012345'}});assert.equal((old.data as any).issues[0].code,'no_editable_fields');
  const inspected=await call('inspect',{inputId:source.id});assert.equal((inspected.data as any).metadata.editingCapabilities.overlay,'supported');
  const result=await call('overlay',{inputId:source.id,pageIndex:0,coordinateSpace:{kind:'page_points'},placements:[{type:'text',box:{x:40,y:90,width:180,height:30},value:'0012345',fontSize:14}]});
  assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.artifacts.length,1);
  const output=result.artifacts[0]!;assert.deepEqual(output.derivedFrom,[source.id]);assert.equal((await PDFDocument.load(store.read(ns,output.id))).getPageCount(),1);
  const read=await call('extract_text',{inputId:output.id,pageIndex:0});assert.equal(read.status,'ok',JSON.stringify(read));assert.match((read.data as any).metadata.text,/0012345/);
  const rendered=await call('render',{inputId:output.id,pageIndex:0});assert.equal(rendered.status,'ok',JSON.stringify(rendered));const meta=(rendered.data as any).metadata.render;
  assert.equal(meta.pageIndex,0);assert.equal(meta.sourceHash,output.sha256);assert.equal(meta.imageHash,rendered.artifacts[0]!.sha256);assert.deepEqual(meta.pagePoints,{width:400,height:300});assert.deepEqual(meta.pixelDimensions,{width:1600,height:1200});
  assert.deepEqual(store.read(ns,source.snapshotArtifactId),original);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
