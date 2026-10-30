import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationPageGeometry} from '../../core/preparation/page-geometry.js';
import type {PreparationContext} from '../../core/preparation/service.js';
import type {ToolContext,ToolResult} from '../../core/agent/contracts.js';

test('PDF/OCR adapter preserves actual persisted page index, affine convention and crop/resize lineage',()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/geometry-')),tasks=new AgentStore(join(dir,'tasks.sqlite')),store=new EvidenceStore(join(dir,'evidence')),namespace={workspaceId:'w',accountId:'owner'};
 try{
  const task=tasks.admit({workspaceId:'w',accountId:'owner',messageId:'m',outcome:'Invented'},20),source=store.put(namespace,Buffer.from('%PDF invented metadata-only fixture'),'application/pdf',[],{provider:'drive',accountId:'owner',providerId:'source',providerVersion:'7'}).source!;
  // Metadata-only adapter fixture; not a PDF render or actual PNG decoder test.
  const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(400,16);png.writeUInt32BE(800,20);const render=store.put(namespace,png,'image/png',[source.id]).artifact;
  const crop=store.put(namespace,Buffer.from('invented derived image'),'image/png',[render.id]).artifact;
  const observation=(data:unknown,artifact:typeof render):ToolResult=>({callId:artifact.id,status:'ok',data,artifacts:[artifact],evidence:[],observations:['Invented adapter metadata fixture only']});
  tasks.update(task.id,t=>{t.observations.push(observation({kind:'spindle.document.v1',operation:'render',inputId:source.id,inputHash:source.sha256,outputId:render.id,outputHash:render.sha256,parameters:{pageIndex:2},metadata:{render:{sourceHash:source.sha256,imageHash:render.sha256,pageIndex:2,pixelDimensions:{width:400,height:800},pagePoints:{width:200,height:400},cropBox:{x:10,y:20,width:400,height:200},rotation:90,userUnit:1,pdfToPage:[0,1,1,0,-20,-10]}}},render),observation({kind:'spindle.image.v1',operation:'crop_resize',inputId:render.id,inputHash:render.sha256,outputId:crop.id,outputHash:crop.sha256,parameters:{crop:[100,200,300,600],width:100,height:200},metadata:{width:100,height:200}},crop));});
  const ctx:ToolContext={callId:'c',taskId:task.id,runId:'r',accountId:'owner',workspaceId:'w',scope:{sources:[source],destinations:[],grants:['document.processing']},budget:{limit:20,used:0},signal:new AbortController().signal,isCurrent:()=>true};
  const c={tasks,store,taskId:task.id,namespace} as PreparationContext;
  const direct=preparationPageGeometry(c,ctx,render.id)!;assert.equal(direct.pageIndex,2);assert.equal(direct.documentArtifactId,source.snapshotArtifactId);assert.deepEqual(direct.pdfToPage,[0,1,-20,1,0,-10]);assert.deepEqual(direct.inputToRender,[1,0,0,0,1,0]);
  const derived=preparationPageGeometry(c,ctx,crop.id)!;assert.equal(derived.renderArtifactId,render.id);assert.deepEqual(derived.inputToRender,[2,0,100,0,2,200]);
  const independent=store.put(namespace,Buffer.from('independent image'),'image/png').artifact;assert.equal(preparationPageGeometry(c,ctx,independent.id),undefined);
  tasks.update(task.id,t=>{(t.observations[0]!.data as any).metadata.render.imageHash='f'.repeat(64);});assert.throws(()=>preparationPageGeometry(c,ctx,render.id),/INVALID_PERSISTED_RENDER_GEOMETRY/);
 }finally{store.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
