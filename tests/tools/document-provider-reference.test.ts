import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{PDFDocument}from'pdf-lib';import{EvidenceStore}from'../../core/evidence/store.js';import{createDocumentTools}from'../../core/tools/documents.js';import type{ToolContext}from'../../core/agent/contracts.js';
test('captured document.inspect provider-ID pattern resolves only after actual scoped PDF bytes are admitted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'doc-provider-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'owner'},sources:ToolContext['scope']['sources']=[];
 const ctx:ToolContext={callId:'invented-document-check',taskId:'t',runId:'r',...ns,scope:{sources,destinations:[],grants:['document.processing']},budget:{limit:10,used:0},signal:new AbortController().signal,isCurrent:()=>true};
 try{
  const inspect=createDocumentTools(store).find(t=>t.name==='document.inspect')!,inputId='invented-observed-drive-file';
  const before=await inspect.invoke(inspect.inputSchema.parse({inputId}),ctx);assert.equal(before.status,'failed');assert.equal((before.data as any).issues[0].code,'input_unavailable');
  const pdf=await PDFDocument.create();pdf.addPage([300,300]);const snapshot=store.put(ns,await pdf.save(),'application/pdf',[],{provider:'drive',accountId:'owner',providerId:inputId,providerVersion:'2'});sources.push(snapshot.source!);
  const after=await inspect.invoke(inspect.inputSchema.parse({inputId}),ctx);assert.equal(after.status,'ok',JSON.stringify(after));assert.equal((after.data as any).inputId,inputId);assert.equal((after.data as any).inputHash,snapshot.artifact.sha256);
  const foreign=await inspect.invoke({inputId},{...ctx,accountId:'foreign'});assert.equal(foreign.status,'failed');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
