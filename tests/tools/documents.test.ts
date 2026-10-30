import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { EvidenceStore } from '../../core/evidence/store.js';
import { createDocumentTools } from '../../core/tools/documents.js';
import type { ToolContext } from '../../core/agent/contracts.js';
async function fixture(suffix='changed') {
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','documents-'));const store=new EvidenceStore(dir);
 const doc=await PDFDocument.create();const page=doc.addPage();const form=doc.getForm();
 const text=form.createTextField(`code-${suffix}`);text.enableRequired();text.addToPage(page,{x:20,y:600,width:200,height:30});text.setFontSize(10);
 const check=form.createCheckBox(`agree-${suffix}`);check.addToPage(page,{x:20,y:550,width:20,height:20});
 const select=form.createDropdown(`choice-${suffix}`);select.addOptions(['North','South']);select.addToPage(page,{x:20,y:500,width:200,height:30});
 const readonly=form.createTextField('locked');readonly.enableReadOnly();readonly.addToPage(page,{x:20,y:450,width:200,height:30});
 const password=form.createTextField('credential');password.enablePassword();password.setText('invented-secret');password.addToPage(page,{x:20,y:400,width:200,height:30});
 const bytes=Buffer.from(await doc.save());const ns={workspaceId:'w',accountId:'a'};const source=store.put(ns,bytes,'application/pdf',[],{provider:'user',providerId:`invented-${suffix}`}).source!;
 const ctx:ToolContext={...ns,callId:'call',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:new AbortController().signal,budget:{used:0,limit:10},isCurrent:()=>true};
 const tools=createDocumentTools(store);const call=(op:string,args:object={})=>tools.find(t=>t.name===`document.${op}`)!.invoke({inputId:source.id,...args},ctx);
 return {dir,store,source,ctx,tools,bytes,call,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('real field discovery, changed names/types and actual edited PDF reload/hash with immutable original',async()=>{
 for(const suffix of ['renamed','different']) {const f=await fixture(suffix);try {
  const inspected=await f.call('inspect');assert.equal(inspected.status,'ok');const fields=(inspected.data as any).metadata.fields;
  assert.equal(fields.find((x:any)=>x.name===`code-${suffix}`).required,true);assert.deepEqual(fields.find((x:any)=>x.name===`choice-${suffix}`).options,['North','South']);
  assert.equal(fields.find((x:any)=>x.name==='credential').value,'[redacted]');assert.ok(!JSON.stringify(inspected.data).includes('invented-secret'));
  const values={[`code-${suffix}`]:'0012345',[`agree-${suffix}`]:true,[`choice-${suffix}`]:'South'};
  const edited=await f.call('edit',{values});assert.equal(edited.status,'ok',JSON.stringify(edited));assert.equal(edited.artifacts.length,1);
  const bytes=f.store.read({workspaceId:'w',accountId:'a'},edited.artifacts[0]!.id);const out=await PDFDocument.load(bytes);const form=out.getForm();
  assert.equal(form.getTextField(`code-${suffix}`).getText(),'0012345');assert.match(form.getTextField(`code-${suffix}`).acroField.getDefaultAppearance()!,/10 Tf/);assert.equal(form.getCheckBox(`agree-${suffix}`).isChecked(),true);assert.deepEqual(form.getDropdown(`choice-${suffix}`).getSelected(),['South']);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),(edited.data as any).outputHash);assert.deepEqual(f.store.read({workspaceId:'w',accountId:'a'},f.source.snapshotArtifactId),f.bytes);
  assert.equal((await f.tools[0]!.invoke({inputId:edited.artifacts[0]!.id},f.ctx)).status,'ok');
 } finally{f.close();}}
});
test('unknown, readonly, credentials, overflow and invalid options fail without artifact or typed credential metadata',async()=>{
 const f=await fixture();try {
  for(const values of [{absent:'x'},{locked:'x'},{credential:'do-not-leak'},{'code-changed':'W'.repeat(100)},{'choice-changed':'Unlisted'},{'code-changed':'漢字'}]) {
   const result=await f.call('edit',{values});assert.equal(result.status,'failed');assert.deepEqual(result.artifacts,[]);assert.ok(!JSON.stringify(result).includes('do-not-leak'));
  }
  f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};assert.equal((await f.call('inspect')).status,'failed');f.ctx.scope.sources[0]=f.source;
  f.ctx.accountId='other';assert.equal((await f.call('inspect')).status,'failed');f.ctx.accountId='a';
  f.ctx.scope={...f.ctx.scope,grants:[]};await assert.rejects(f.call('inspect'));f.ctx.scope={...f.ctx.scope,grants:['document.processing']};
  const abort=new AbortController();f.ctx.signal=abort.signal;const pending=f.call('inspect');abort.abort();await assert.rejects(pending);
 }finally{f.close();}
});
test('actual export flattens supported form, active actions rejected and derived root permission retained',async()=>{
 const f=await fixture();try {
  const doc=await PDFDocument.create();const page=doc.addPage();const text=doc.getForm().createTextField('other');text.setText('Invented');text.addToPage(page,{x:20,y:500,width:200,height:30});
  const source=f.store.put({workspaceId:'w',accountId:'a'},Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:'another-template'}).source!;f.ctx.scope.sources.push(source);
  const result=await f.tools.find(t=>t.name==='document.export')!.invoke({inputId:source.id,flatten:true},f.ctx);assert.equal(result.status,'ok',JSON.stringify(result));
  const bytes=f.store.read({workspaceId:'w',accountId:'a'},result.artifacts[0]!.id);assert.equal((await PDFDocument.load(bytes)).getForm().getFields().length,0);
  f.ctx.scope={...f.ctx.scope,sources:f.ctx.scope.sources.filter(x=>x.id!==source.id)};assert.equal((await f.tools[0]!.invoke({inputId:result.artifacts[0]!.id},f.ctx)).status,'failed');
  doc.catalog.set(PDFName.of('OpenAction'),doc.context.obj({S:'JavaScript',JS:PDFString.of('invented')}));
  const active=f.store.put({workspaceId:'w',accountId:'a'},Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:'active'}).source!;f.ctx.scope.sources.push(active);
  assert.equal((await f.tools[0]!.invoke({inputId:active.id},f.ctx)).status,'failed');
 }finally{f.close();}
});

test('credential PNG preview is rejected before renderer launch without publishing an artifact',async()=>{
 const f=await fixture();try {
  const tools=createDocumentTools(f.store,{pdftoppmExecutable:'/nonexistent/renderer-must-not-start'});
  const result=await tools.find(t=>t.name==='document.export')!.invoke({inputId:f.source.id,format:'png'},f.ctx);
  assert.equal(result.status,'failed');assert.deepEqual(result.artifacts,[]);
  assert.match(result.error!.message,/credential preview/i);
  assert.ok(!JSON.stringify(result).includes('invented-secret'));
 }finally{f.close();}
});
test('signed source cannot produce an apparently valid edited PDF',async()=>{
 const f=await fixture();try {
  const doc=await PDFDocument.load(f.bytes);
  doc.catalog.set(PDFName.of('RetainedSignature'),doc.context.obj({Type:'Sig',ByteRange:[0,10,20,30],Contents:PDFString.of('invented-signature')}));
  const source=f.store.put({workspaceId:'w',accountId:'a'},Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:'signed'}).source!;
  f.ctx.scope.sources.push(source);
  const result=await f.tools.find(t=>t.name==='document.edit')!.invoke({inputId:source.id,values:{'code-changed':'0012345'}},f.ctx);
  assert.equal(result.status,'failed');assert.deepEqual(result.artifacts,[]);
 }finally{f.close();}
});
test('bounded nested graph rejects active actions but accepts benign A and ordinary URI links',async()=>{
 const f=await fixture();try {
  for(const active of [false,true]) {
   const doc=await PDFDocument.create();doc.addPage();
   doc.catalog.set(PDFName.of('Custom'),doc.context.obj({A:PDFString.of('benign'),Nested:[{S:active?'SubmitForm':'URI',URI:PDFString.of('https://example.invalid')}]}));
   const source=f.store.put({workspaceId:'w',accountId:'a'},Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:`nested-${active}`}).source!;
   f.ctx.scope.sources.push(source);
   const result=await f.tools[0]!.invoke({inputId:source.id},f.ctx);
   assert.equal(result.status,active?'failed':'ok');assert.deepEqual(result.artifacts,[]);
  }
 }finally{f.close();}
});
