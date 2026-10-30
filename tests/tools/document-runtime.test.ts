import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {AgentStore} from '../../core/storage/agent-store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';

test('real runtime persists document provenance across restart and correction publishes one new PDF',async()=>{
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','doc-runtime-'));const evidence=new EvidenceStore(join(dir,'evidence'));let tasks=new AgentStore(join(dir,'tasks.sqlite'));
 try {
 const doc=await PDFDocument.create();const page=doc.addPage();const field=doc.getForm().createTextField('Application code');field.addToPage(page,{x:50,y:600,width:250,height:30});field.setFontSize(12);
 const original=Buffer.from(await doc.save());const ns={workspaceId:'w',accountId:'invented'};
 const source=evidence.put(ns,original,'application/pdf',[],{provider:'user',providerId:'invented-runtime'}).source!;
 const scope={sources:[source],grants:['document.processing'],destinations:[]};const task=tasks.admit({...ns,messageId:'invented',outcome:'Prepare invented application'},20);
 const tools=createDocumentTools(evidence);
 await new AgentRuntime(tasks,tools).run(task.id,{id:'script-not-live-model',async next(){return {kind:'tool',name:'document.edit',args:{inputId:source.id,values:{'Application code':'0012345'}}};}},1,{scope});
 const first=tasks.get(task.id).observations[0]!;assert.equal(first.status,'ok');assert.equal(first.artifacts.length,1);assert.equal(first.evidence[0]!.sourceId,source.id);
 tasks.close();tasks=new AgentStore(join(dir,'tasks.sqlite'));assert.deepEqual(tasks.get(task.id).observations[0],first);
 await new AgentRuntime(tasks,tools).run(task.id,{id:'script-correction-not-live-model',async next(){return {kind:'tool',name:'document.edit',args:{inputId:first.artifacts[0]!.id,values:{'Application code':'0098765'}}};}},1,{scope});
 const second=tasks.get(task.id).observations[1]!;assert.equal(second.status,'ok');assert.equal(second.artifacts.length,1);assert.notEqual(second.artifacts[0]!.id,first.artifacts[0]!.id);assert.deepEqual(second.artifacts[0]!.derivedFrom,[first.artifacts[0]!.id]);assert.equal(second.evidence[0]!.sourceId,source.id);assert.equal(second.evidence[0]!.sourceVersion,first.evidence[0]!.sourceVersion);
 for(const [result,value] of [[first,'0012345'],[second,'0098765']] as const){const pdf=await PDFDocument.load(evidence.read(ns,result.artifacts[0]!.id));assert.equal(pdf.getForm().getTextField('Application code').getText(),value);}
 assert.deepEqual(evidence.read(ns,source.snapshotArtifactId),original);
 }finally{tasks.close();evidence.close();rmSync(dir,{recursive:true,force:true});}
});
