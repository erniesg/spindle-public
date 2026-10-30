import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { PDFDocument } from 'pdf-lib';
import { EvidenceStore } from '../../core/evidence/store.js';
import { createDocumentTools } from '../../core/tools/documents.js';
import type { ToolContext } from '../../core/agent/contracts.js';

async function fixture(options:Parameters<typeof createDocumentTools>[1]={}) {
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','document-validation-'));const store=new EvidenceStore(dir);
 const doc=await PDFDocument.create();const page=doc.addPage();const form=doc.getForm();
 for(const [name,y] of [['name',600],['account',550]] as const) {const field=form.createTextField(name);field.enableRequired();field.addToPage(page,{x:40,y,width:240,height:30});field.setFontSize(12);}
 const check=form.createCheckBox('consent');check.addToPage(page,{x:40,y:500,width:20,height:20});
 const bytes=Buffer.from(await doc.save());const ns={workspaceId:'w',accountId:'a'};
 const source=store.put(ns,bytes,'application/pdf',[],{provider:'user',providerId:'invented-validation-template'}).source!;
 const ctx:ToolContext={...ns,callId:'validation',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:new AbortController().signal,budget:{used:0,limit:10},isCurrent:()=>true};
 const tools=createDocumentTools(store,options);const call=(op:string,args:object={})=>tools.find(t=>t.name===`document.${op}`)!.invoke({inputId:source.id,...args},ctx);
 return {dir,store,bytes,source,ctx,tools,call,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
for(const scanned of [false,true]) test(`ordinary ${scanned?'image-only':'nonfillable'} PDF discovers field-edit refusal and generic overlay capability before an edit`,async()=>{
 const f=await fixture();try {
  const doc=await PDFDocument.create();const page=doc.addPage();if(scanned) {const image=await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));page.drawImage(image,{x:40,y:400,width:100,height:100});}else page.drawText('Ordinary invented document 0098765');
  const source=f.store.put(f.ctx,Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:`ordinary-${scanned}`}).source!;f.ctx.scope.sources.push(source);
  const result=await f.tools[0]!.invoke({inputId:source.id},f.ctx);assert.equal(result.status,'ok');const metadata=(result.data as any).metadata;
  assert.deepEqual(metadata.fields,[]);assert.deepEqual(metadata.editingCapabilities,{editableFieldNames:[],fieldEditing:'unsupported',overlay:'supported',signedSource:false,credentialFieldsPresent:false});
  const failed=await f.tools.find(t=>t.name==='document.edit')!.invoke({inputId:source.id,values:{account:'0098765'}},f.ctx);assert.equal(failed.status,'failed');assert.equal((failed.data as any).issues[0].code,'no_editable_fields');assert.deepEqual(failed.artifacts,[]);
 }finally{f.close();}
});
test('actual PDF failures identify field and safe action without publishing or destroying prior versions',async()=>{
 const f=await fixture();try {
  const previous=await f.call('edit',{values:{name:'Invented',account:'0012345'}});assert.equal(previous.status,'ok');
  const prior=f.store.read(f.ctx,previous.artifacts[0]!.id);
  for(const [values,code,field] of [[{name:'W'.repeat(200)},'field_overflow','name'],[{name:'漢字'},'unsupported_glyph','name'],[{absent:'private-value'},'unknown_field','absent'],[{consent:'private-value'},'field_type','consent']] as const) {
   const result=await f.call('edit',{values});assert.equal(result.status,'failed');assert.deepEqual(result.artifacts,[]);
   const issue=(result.data as any).issues[0];assert.equal(issue.code,code);assert.equal(issue.field,field);assert.ok(issue.nextAction.length>10);
   assert.ok(!JSON.stringify(result).includes('private-value'));assert.ok(!JSON.stringify(result).includes('漢字'));
   assert.deepEqual(f.store.read(f.ctx,f.source.snapshotArtifactId),f.bytes);assert.deepEqual(f.store.read(f.ctx,previous.artifacts[0]!.id),prior);
  }
  const missing=await f.call('inspect');assert.deepEqual((missing.data as any).issues.map((x:any)=>[x.code,x.field]),[['missing_required_field','name'],['missing_required_field','account']]);
 }finally{f.close();}
});
for(const [value,code] of [['W'.repeat(200),'field_overflow'],['漢字','unsupported_glyph']] as const) test(`actual PDF ${code} identifies the affected field`,async()=>{
 const f=await fixture();try {const result=await f.call('edit',{values:{name:value}});assert.equal(result.status,'failed');assert.equal((result.data as any).issues[0].code,code);assert.equal((result.data as any).issues[0].field,'name');assert.deepEqual(result.artifacts,[]);}finally{f.close();}
});
test('unsupported PDF and configured font errors expose only bounded safe issues',async()=>{
 const f=await fixture();try {
  const malformed=f.store.put(f.ctx,Buffer.from('%PDF-invented malformed parser content /private/path'),'application/pdf',[],{provider:'user',providerId:'malformed'}).source!;f.ctx.scope.sources.push(malformed);
  const result=await f.tools[0]!.invoke({inputId:malformed.id},f.ctx);assert.equal((result.data as any).issues[0].code,'unsupported_pdf');assert.ok(!JSON.stringify(result).includes('/private/path'));
  const oversized=join(f.dir,'oversized.ttf');writeFileSync(oversized,'');truncateSync(oversized,4*1024*1024+1);
  const invalid=join(f.dir,'invalid.ttf');writeFileSync(invalid,'not a font /private/font-path');
  for(const path of ['relative.ttf',f.dir,join(f.dir,'missing-private-font.ttf'),oversized,invalid]) {
   const tool=createDocumentTools(f.store,{renderFontPath:path,renderFontLicense:'test-operator-license'}).find(t=>t.name==='document.edit')!;
   const failed=await tool.invoke({inputId:f.source.id,values:{name:'Invented'}},f.ctx);assert.equal((failed.data as any).issues[0].code,'unsupported_font');assert.deepEqual(failed.artifacts,[]);assert.ok(!JSON.stringify(failed).includes(f.dir));assert.ok(!JSON.stringify(failed).includes('/private/font-path'));
  }
 }finally{f.close();}
});
test('real runtime observes structured unsupported field and continues independent document work',async()=>{
 const f=await fixture();const tasks=new AgentStore(join(f.dir,'tasks.sqlite'));try {
  const task=tasks.admit({workspaceId:'w',accountId:'a',messageId:'document-validation',outcome:'Prepare permitted documents'},10);
  let turn=0;
  await new AgentRuntime(tasks,f.tools).run(task.id,{id:'script-not-live-model',async next(current){
   if(turn++===0)return {kind:'tool',name:'document.edit',args:{inputId:f.source.id,values:{name:'漢字'}}};
   assert.equal((current.observations[0]!.data as any).issues[0].code,'unsupported_glyph');
   return {kind:'tool',name:'document.inspect',args:{inputId:f.source.id}};
  }},2,{scope:f.ctx.scope});
  const current=tasks.get(task.id);assert.equal(current.observations.length,2);assert.equal(current.observations[0]!.status,'failed');assert.equal(current.observations[1]!.status,'ok');assert.equal(current.status,'working');
  const out=resolve('.local/retained-pr47-validation');mkdirSync(out,{recursive:true});writeFileSync(join(out,'runtime-result.json'),JSON.stringify(current.observations,null,2));
 }finally{tasks.close();f.close();}
});
if(process.env.SPINDLE_DOCUMENT_TEST_FONT) test('configured licensed font preserves Greek, extended Latin and leading zeros in real PDF and Poppler render',async()=>{
 const f=await fixture({renderFontPath:process.env.SPINDLE_DOCUMENT_TEST_FONT!,renderFontLicense:'Bitstream-Vera + DejaVu-public-domain',pdftoppmExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOPPM??'/usr/bin/pdftoppm'});try {
  const result=await f.call('edit',{values:{name:'Živa Ω',account:'0098765'}});assert.equal(result.status,'ok',JSON.stringify(result));
  const bytes=f.store.read(f.ctx,result.artifacts[0]!.id);const doc=await PDFDocument.load(bytes);assert.equal(doc.getForm().getTextField('name').getText(),'Živa Ω');assert.equal(doc.getForm().getTextField('account').getText(),'0098765');
  assert.equal((result.data as any).renderAssets[0].sha256.length,64);assert.equal((result.data as any).renderAssets[0].embeddingLicense,'Bitstream-Vera + DejaVu-public-domain');assert.deepEqual(result.artifacts[0]!.derivedFrom,[f.source.id]);
  const rendered=await f.tools.find(t=>t.name==='document.export')!.invoke({inputId:result.artifacts[0]!.id,format:'png'},f.ctx);assert.equal(rendered.status,'ok',JSON.stringify(rendered));
  const out=resolve('.local/retained-pr47-validation');mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'source.pdf'),f.bytes);writeFileSync(resolve(out,'unicode.pdf'),bytes);writeFileSync(resolve(out,'unicode.png'),f.store.read(f.ctx,rendered.artifacts[0]!.id));writeFileSync(resolve(out,'unicode-result.json'),JSON.stringify(result,null,2));
  const second=await f.tools.find(t=>t.name==='document.edit')!.invoke({inputId:result.artifacts[0]!.id,values:{account:'0012345'}},f.ctx);assert.equal(second.status,'ok',JSON.stringify(second));
  const secondBytes=f.store.read(f.ctx,second.artifacts[0]!.id);const secondDoc=await PDFDocument.load(secondBytes);assert.equal(secondDoc.getForm().getTextField('account').getText(),'0012345');assert.equal(secondDoc.getForm().getTextField('name').getText(),'Živa Ω');assert.notEqual(second.artifacts[0]!.id,result.artifacts[0]!.id);
  const secondRender=await f.tools.find(t=>t.name==='document.export')!.invoke({inputId:second.artifacts[0]!.id,format:'png'},f.ctx);assert.equal(secondRender.status,'ok',JSON.stringify(secondRender));
  assert.deepEqual(f.store.read(f.ctx,f.source.snapshotArtifactId),f.bytes);assert.deepEqual(f.store.read(f.ctx,result.artifacts[0]!.id),bytes);
  writeFileSync(resolve(out,'second.pdf'),secondBytes);writeFileSync(resolve(out,'second.png'),f.store.read(f.ctx,secondRender.artifacts[0]!.id));writeFileSync(resolve(out,'second-result.json'),JSON.stringify(second,null,2));
  // Reopen the actual evidence index and verify both immutable versions, not just memory.
  const reopened=new EvidenceStore(f.dir);try{assert.deepEqual(reopened.read(f.ctx,result.artifacts[0]!.id),bytes);assert.deepEqual(reopened.read(f.ctx,second.artifacts[0]!.id),secondBytes);assert.deepEqual(reopened.read(f.ctx,f.source.snapshotArtifactId),f.bytes);}finally{reopened.close();}
 }finally{f.close();}
});
