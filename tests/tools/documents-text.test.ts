import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createDocumentTools } from '../../core/tools/documents.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import type { ToolContext } from '../../core/agent/contracts.js';
const retained=resolve('.local/retained-pr47-text');mkdirSync(retained,{recursive:true});
const poppler=process.env.SPINDLE_DOCUMENT_TEST_PDFTOTEXT;
const fontPath=process.env.SPINDLE_DOCUMENT_TEST_FONT;
const actualSkip=!poppler||!fontPath?'Configure trusted Poppler and licensed font paths; no downloads.':false;
async function pdf(kind='ascii') {
 const doc=await PDFDocument.create();const page=doc.addPage(kind==='large'?[4000,8000]:[600,800]);
 if(kind!=='blank') {
  let font;if(kind==='unicode'){doc.registerFontkit(fontkit);font=await doc.embedFont(readFileSync(fontPath!),{subset:true});}else font=await doc.embedFont(StandardFonts.Helvetica);
  if(kind==='large')for(let i=0;i<240;i++)page.drawText((`${i} invented ordinary statement 0098765 `).repeat(30),{x:10,y:7990-i*20,size:4,font});
  else {page.drawText(kind==='unicode'?'Živa Ω':'Invented account statement',{x:kind==='unicode'?130:30,y:700,size:16,font});page.drawText('0098765',{x:kind==='unicode'?270:60,y:kind==='unicode'?320:650,size:14,font});}
 }
 return Buffer.from(await doc.save());
}
async function fixture(kind='ascii') {
 const dir=mkdtempSync(resolve('.local','document-text-'));const store=new EvidenceStore(join(dir,'evidence'));const ns={workspaceId:'text',accountId:'invented'};const bytes=await pdf(kind);
 const source=store.put(ns,bytes,'application/pdf',[],{provider:'user',providerId:`invented-${kind}`}).source!;
 const ctx:ToolContext={...ns,callId:'text-call',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:new AbortController().signal,budget:{used:0,limit:10},isCurrent:()=>true};
 const tool=(options={pdftotextExecutable:poppler})=>createDocumentTools(store,options).find(t=>t.name==='document.extract_text')!;
 const call=(options?:Parameters<typeof createDocumentTools>[1])=>createDocumentTools(store,options??{pdftotextExecutable:poppler}).find(t=>t.name==='document.extract_text')!.invoke({inputId:source.id,pageIndex:0},ctx);
 return {dir,store,ns,source,bytes,ctx,tool,call,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('ordinary PDF text operation is registered with required bounded page argument',async()=>{
 const f=await fixture();try {const t=f.tool();assert.ok(t);for(const pageIndex of [-1,1.1,100,undefined,'0'])assert.throws(()=>t.inputSchema.parse({inputId:f.source.id,pageIndex}));assert.throws(()=>t.inputSchema.parse({inputId:f.source.id,pageIndex:0,path:'/tmp/evil'}));assert.equal((await t.invoke({inputId:f.source.id,pageIndex:1},f.ctx)).status,'failed');}finally{f.close();}
});
test('real Poppler pilot: dynamic nonform ASCII, licensed embedded Unicode and blank page preserve source',{skip:actualSkip},async()=>{
 for(const kind of ['ascii','unicode','blank']){const f=await fixture(kind);try {
  const result=await f.call();writeFileSync(join(retained,`${kind}.pdf`),f.bytes);writeFileSync(join(retained,`${kind}-result.json`),JSON.stringify(result,null,2));
  if(kind==='blank'){assert.equal(result.status,'failed');assert.equal((result.data as any).issues[0].code,'no_text_layer');assert.match((result.data as any).nextAction,/OCR/);assert.deepEqual(result.artifacts,[]);}else{
   assert.equal(result.status,'ok',JSON.stringify(result));const data=result.data as any;assert.match(data.metadata.text,/0098765/);if(kind==='unicode')assert.match(data.metadata.text,/Živa Ω/);
   assert.equal(data.inputHash,createHash('sha256').update(f.bytes).digest('hex'));assert.equal(data.metadata.pageIndex,0);assert.equal(data.metadata.textLayerCoverage,'unverified');assert.equal(data.metadata.outputLimitBytes,65536);assert.equal(result.evidence[0]!.sourceId,f.source.id);
   const text=f.store.read(f.ns,result.artifacts[0]!.id);assert.equal(text.toString('utf8'),data.metadata.text);writeFileSync(join(retained,`${kind}.txt`),text);
  }assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),f.bytes);
 }finally{f.close();}}
});
test('actual Poppler oversized text fails explicitly without partial output artifact',{skip:!poppler},async()=>{
 const f=await fixture('large');try{writeFileSync(join(retained,'large.pdf'),f.bytes);const result=await f.call();assert.equal(result.status,'failed',JSON.stringify(result));assert.equal((result.data as any).issues[0].code,'text_too_large');assert.deepEqual(result.artifacts,[]);writeFileSync(join(retained,'oversize-result.json'),JSON.stringify(result,null,2));}finally{f.close();}
});
test('scope/hash/namespace/revision and credential guards run before text extraction; signed source read is immutable',{skip:!poppler},async()=>{
 const f=await fixture();try{
  f.ctx.scope={...f.ctx.scope,sources:[{...f.source,sha256:'0'.repeat(64)}]};assert.equal((await f.call()).status,'failed');f.ctx.scope={...f.ctx.scope,sources:[]};assert.equal((await f.call()).status,'failed');f.ctx.scope={...f.ctx.scope,sources:[f.source]};
  f.ctx.accountId='other';assert.equal((await f.call()).status,'failed');f.ctx.accountId=f.ns.accountId;f.ctx.isCurrent=()=>false;await assert.rejects(f.call());f.ctx.isCurrent=()=>true;
  const doc=await PDFDocument.load(f.bytes);const field=doc.getForm().createTextField('credential');field.enablePassword();field.setText('invented-secret');field.addToPage(doc.getPage(0),{x:10,y:10,width:150,height:25});
  const source=f.store.put(f.ns,Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:'credential'}).source!;f.ctx.scope.sources.push(source);
  const result=await f.tool({pdftotextExecutable:'/does-not-exist'}).invoke({inputId:source.id,pageIndex:0},f.ctx);assert.match(result.error!.message,/Credential text preview/);assert.ok(!JSON.stringify(result).includes('invented-secret'));
  const signed=await PDFDocument.load(f.bytes);signed.catalog.set(PDFName.of('RetainedSignature'),signed.context.obj({Type:'Sig',ByteRange:[0,10,20,30],Contents:PDFString.of('invented')}));
  const bytes=Buffer.from(await signed.save());const signedSource=f.store.put(f.ns,bytes,'application/pdf',[],{provider:'user',providerId:'signed'}).source!;f.ctx.scope.sources.push(signedSource);
  assert.equal((await f.tool().invoke({inputId:signedSource.id,pageIndex:0},f.ctx)).status,'ok');assert.deepEqual(f.store.read(f.ns,signedSource.snapshotArtifactId),bytes);
 }finally{f.close();}
});
test('unconfigured/unavailable extractor and synthetic malformed UTF8 do not claim a semantic read',async()=>{
 const f=await fixture();try{
  for(const options of [{},{pdftotextExecutable:'/does-not-exist'}]){const result=await f.call(options);assert.equal(result.status,'failed');assert.equal((result.data as any).issues[0].code,'text_extraction_unavailable');}
  const helper=join(f.dir,'invalid-utf8');writeFileSync(helper,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([255])));`,{mode:0o700});
  const result=await f.call({pdftotextExecutable:helper});assert.equal(result.status,'failed');assert.equal((result.data as any).issues[0].code,'invalid_text_encoding');
 }finally{f.close();}
});
test('synthetic owned extractor deadline and active abort kill and reap the helper (not real Poppler cancellation proof)',async()=>{
 const f=await fixture();try{
  for(const cancel of [false,true]){
   const pidPath=join(f.dir,`pid-${cancel}`);const helper=join(f.dir,`wait-${cancel}`);writeFileSync(helper,`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});
   const controller=new AbortController();f.ctx.signal=controller.signal;const pending=f.call({pdftotextExecutable:helper,textDeadlineMs:cancel?5000:300});
   for(let i=0;i<300&&!existsSync(pidPath);i++)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(pidPath),'helper started');
   if(cancel){controller.abort();await assert.rejects(pending);}else assert.equal((await pending).status,'failed');
   const pid=Number(readFileSync(pidPath,'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');
  }
 }finally{f.close();}
});
test('scripted provider observes actual text via AgentRuntime; task and immutable evidence reopen after restart',{skip:actualSkip},async()=>{
 const f=await fixture('unicode');let tasks=new AgentStore(join(f.dir,'tasks.sqlite'));try{
  const task=tasks.admit({...f.ns,messageId:'ordinary-text',outcome:'Read invented statement'},10);let observed=false;
  await new AgentRuntime(tasks,createDocumentTools(f.store,{pdftotextExecutable:poppler})).run(task.id,{id:'script-not-live-model',async next(current){
   if(!current.observations.length)return {kind:'tool',name:'document.extract_text',args:{inputId:f.source.id,pageIndex:0}};
   assert.match((current.observations[0]!.data as any).metadata.text,/0098765/);observed=true;return {kind:'ready',result:'Read the invented text layer'};
  }},2,{scope:f.ctx.scope});assert.equal(observed,true);
  const observation=tasks.get(task.id).observations[0]!;assert.equal(observation.status,'ok');tasks.close();tasks=new AgentStore(join(f.dir,'tasks.sqlite'));assert.deepEqual(tasks.get(task.id).observations[0],observation);
  const reopened=new EvidenceStore(join(f.dir,'evidence'));try{assert.deepEqual(reopened.read(f.ns,f.source.snapshotArtifactId),f.bytes);assert.match(reopened.read(f.ns,observation.artifacts[0]!.id).toString('utf8'),/Živa Ω/);}finally{reopened.close();}
  writeFileSync(join(retained,'runtime-observation.json'),JSON.stringify(observation,null,2));
 }finally{tasks.close();f.close();}
});
