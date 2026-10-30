import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import type {ToolContext} from '../../core/agent/contracts.js';
test('configured renderer emits actual edited page with leading zeros', {skip:!process.env.SPINDLE_DOCUMENT_TEST_PDFTOPPM},async()=>{
 const root='.local/retained-pr47';mkdirSync(root,{recursive:true});const store=new EvidenceStore(`${root}/store`);
 try {
 const doc=await PDFDocument.create();const page=doc.addPage();const field=doc.getForm().createTextField('Changed application code');field.enableRequired();field.addToPage(page,{x:50,y:600,width:250,height:30});field.setFontSize(12);
 const bytes=Buffer.from(await doc.save());writeFileSync(`${root}/source.pdf`,bytes);
 const ns={workspaceId:'render',accountId:'invented'};const source=store.put(ns,bytes,'application/pdf',[],{provider:'user',providerId:'invented-render'}).source!;
 const ctx:ToolContext={...ns,callId:'render',taskId:'task',runId:'run',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:new AbortController().signal,budget:{used:0,limit:10},isCurrent:()=>true};
 const tools=createDocumentTools(store,{pdftoppmExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOPPM});
 const edited=await tools.find(t=>t.name==='document.edit')!.invoke({inputId:source.id,values:{'Changed application code':'0012345'}},ctx);assert.equal(edited.status,'ok');
 const id=edited.artifacts[0]!.id;writeFileSync(`${root}/edited.pdf`,store.read(ns,id));
 const rendered=await tools.find(t=>t.name==='document.export')!.invoke({inputId:id,format:'png',pageIndex:0},ctx);assert.equal(rendered.status,'ok',JSON.stringify(rendered));assert.equal(rendered.artifacts.length,1);
 writeFileSync(`${root}/render.png`,store.read(ns,rendered.artifacts[0]!.id));writeFileSync(`${root}/manifest.json`,JSON.stringify({source,edited,rendered,limits:'Direct tool invocation, not ToolRuntime or AgentStore restart proof; font/native/live acceptance pending'},null,2));
 assert.deepEqual(store.read(ns,source.snapshotArtifactId),bytes);
 const invalid=await tools.find(t=>t.name==='document.export')!.invoke({inputId:id,format:'png',pageIndex:99},ctx);assert.equal(invalid.status,'failed');assert.equal(invalid.artifacts.length,0);
 }finally{store.close();}
});
