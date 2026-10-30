import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFString,PDFHexString} from 'pdf-lib';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createDocumentTools} from '../../core/tools/documents.js';
import {overlayFixture,placement,backend} from './document-overlay-fixtures.js';
async function flat(){const d=await PDFDocument.create();d.addPage([400,300]);return d.save();}
const args=()=>({pageIndex:0,coordinateSpace:{kind:'page_points'},placements:[placement()]});
const count=(f:Awaited<ReturnType<typeof overlayFixture>>)=>Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);

test('overlay schema rejects unknown units/keys/types/nonfinite/range and worker rejects bounds/overflow/glyphs without publishing',async()=>{
 const f=await overlayFixture(await flat());try {
  const tool=f.tools.find(t=>t.name==='document.overlay')!;
  for(const bad of [
   {coordinateSpace:undefined},{coordinateSpace:{kind:'pdf'}},{coordinateSpace:{kind:'page_points',width:400}},{coordinateSpace:{kind:'render_pixels'}},
   {pageIndex:-1},{pageIndex:0.5},{pageIndex:100},{placements:[]},{placements:Array.from({length:129},()=>placement())},
   {placements:[{...placement(),fontSize:0}]},{placements:[{...placement(),fontSize:145}]},{placements:[{...placement(),value:123}]},
   {placements:[{...placement(),value:'x'.repeat(4097)}]},{placements:[{...placement(),type:'signature'}]},
   {placements:[{...placement(),box:{...placement().box,x:Infinity}}]},{placements:[{...placement(),extra:'unknown'}]},
  ])assert.throws(()=>tool.inputSchema.parse({inputId:f.source.id,...args(),...bad}));
  for(const [p,code] of [
   [{...placement(),box:{x:-1,y:0,width:50,height:20}},'placement_bounds'],
   [{...placement(),box:{x:390,y:0,width:50,height:20}},'placement_bounds'],
   [{...placement(),box:{x:10,y:290,width:50,height:20}},'placement_bounds'],
   [{...placement(),box:{x:10,y:10,width:0,height:20}},'placement_bounds'],
   [{...placement(),box:{x:10,y:10,width:50,height:0}},'placement_bounds'],
   [{...placement(),value:'W'.repeat(100)},'field_overflow'],
   [{...placement(),value:'one\ntwo\nthree'},'field_overflow'],
   [{...placement(),value:'漢字'},'unsupported_glyph'],
   [{...placement(),value:'secret\u0000value'},'invalid_placement'],
  ] as const) {
   const before=count(f),result=await f.call('overlay',{...args(),placements:[p]});assert.equal(result.status,'failed',JSON.stringify(result));assert.equal((result.data as any).issues[0].code,code);assert.deepEqual(result.artifacts,[]);assert.equal(count(f),before);assert.ok(!JSON.stringify(result).includes(p.value));
  }
  const badPage=await f.call('overlay',{...args(),pageIndex:1});assert.equal((badPage.data as any).issues[0].code,'invalid_page');
  const valid=await f.call('overlay',{...args(),placements:[{...placement(),box:{x:0,y:0,width:400,height:300},value:'First line\n0012345'}]});assert.equal(valid.status,'ok',JSON.stringify(valid));assert.equal(count(f),2);
 }finally{f.close();}
});

for(const kind of ['signed','credential','active','encryption-marker'] as const)test(`overlay refuses actual ${kind} PDF structures with no artifact or leaked value`,async()=>{
 const d=await PDFDocument.create();const page=d.addPage([400,300]);
 if(kind==='signed')d.catalog.set(PDFName.of('Signature'),d.context.obj({Type:'Sig',ByteRange:[0,10,20,30],Contents:PDFString.of('invented signature')}));
 if(kind==='active')d.catalog.set(PDFName.of('Custom'),d.context.obj({Nested:[{S:'SubmitForm',F:PDFString.of('https://example.invalid')}]}));
 if(kind==='credential'){const field=d.getForm().createTextField('credential');field.enablePassword();field.setText('invented-private-value');field.addToPage(page,{x:10,y:10,width:100,height:30});}
 // A structurally declared Standard encryption dictionary, not a cryptographic
 // encryption implementation or proof of password-decryption support.
 if(kind==='encryption-marker')d.context.trailerInfo.Encrypt=d.context.register(d.context.obj({Filter:'Standard',V:1,R:2,O:PDFHexString.of('0'.repeat(64)),U:PDFHexString.of('0'.repeat(64)),P:-4}));
 const original=await d.save(),f=await overlayFixture(original);try {
  const result=await f.call('overlay',args());assert.equal(result.status,'failed');assert.equal((result.data as any).issues[0].code,'unsupported_pdf');assert.deepEqual(result.artifacts,[]);assert.equal(count(f),1);assert.ok(!JSON.stringify(result).includes('invented-private-value'));assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),Buffer.from(original));
 }finally{f.close();}
});

test('overlay exact namespace/grant/hash/lineage and pre/inflight currentness/cancellation fences publish nothing',async()=>{
 const f=await overlayFixture(await flat());try {
  const before=count(f);
  f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};assert.equal((await f.call('overlay',args())).status,'failed');f.ctx.scope.sources[0]=f.source;
  f.ctx.accountId='other';assert.equal((await f.call('overlay',args())).status,'failed');f.ctx.accountId=f.ns.accountId;
  f.ctx.workspaceId='other';assert.equal((await f.call('overlay',args())).status,'failed');f.ctx.workspaceId=f.ns.workspaceId;
  f.ctx.scope={...f.ctx.scope,sources:[]};assert.equal((await f.call('overlay',args())).status,'failed');f.ctx.scope={...f.ctx.scope,sources:[f.source]};
  f.ctx.scope={...f.ctx.scope,grants:[]};await assert.rejects(f.call('overlay',args()));f.ctx.scope={...f.ctx.scope,grants:['document.processing']};
  f.ctx.isCurrent=()=>false;await assert.rejects(f.call('overlay',args()));f.ctx.isCurrent=()=>true;
  const pending=f.call('overlay',args());f.ctx.isCurrent=()=>false;await assert.rejects(pending);f.ctx.isCurrent=()=>true;
  const cancelled=f.call('overlay',args());f.controller.abort();await assert.rejects(cancelled);
  assert.equal(count(f),before);
 }finally{f.close();}
});

test('modified input bytes and changed source record cannot publish an overlay',async()=>{
 for(const tamperBytes of [true,false]) {
  const f=await overlayFixture(await flat());try {
   const pending=f.call('overlay',args());
   if(tamperBytes)writeFileSync(join(f.dir,'artifacts',f.source.snapshotArtifactId),'changed snapshot');
   else f.store.db.prepare('UPDATE sources SET body=? WHERE id=?').run(JSON.stringify({...f.source,sha256:'0'.repeat(64)}),f.source.id);
   const result=await pending;assert.equal(result.status,'failed');assert.deepEqual(result.artifacts,[]);assert.equal(count(f),1);
  }finally{f.close();}
 }
});

test('render-pixel coordinates reject another page/image/source and never accept caller dimensions as geometry',async()=>{
 const d=await PDFDocument.create();d.addPage([400,300]).drawText('First invented page');d.addPage([500,400]).drawText('Second invented page');const f=await overlayFixture(await d.save());try {
  const render=await f.call('render',{pageIndex:0});assert.equal(render.status,'ok');const imageId=render.artifacts[0]!.id;
  const mismatch=await f.call('overlay',{...args(),pageIndex:1,coordinateSpace:{kind:'render_pixels',imageArtifactId:imageId}});assert.equal((mismatch.data as any).issues[0].code,'render_mismatch');
  const forged=f.store.put(f.ns,Buffer.from('not a PNG'),'image/png',[f.source.id]).artifact;
  const invalid=await f.call('overlay',{...args(),coordinateSpace:{kind:'render_pixels',imageArtifactId:forged.id}});assert.equal((invalid.data as any).issues[0].code,'render_mismatch');
  const wrongType=await f.call('overlay',{...args(),coordinateSpace:{kind:'render_pixels',imageArtifactId:f.source.snapshotArtifactId}});assert.equal((wrongType.data as any).issues[0].code,'render_mismatch');
  const edited=await f.call('overlay',args());assert.equal(edited.status,'ok');
  const stale=await f.call('overlay',{...args(),inputId:edited.artifacts[0]!.id,coordinateSpace:{kind:'render_pixels',imageArtifactId:imageId}});assert.equal((stale.data as any).issues[0].code,'render_mismatch');
  const countBefore=count(f);const unconfigured=createDocumentTools(f.store).find(t=>t.name==='document.render')!;const failed=await unconfigured.invoke({inputId:f.source.id,pageIndex:0},f.ctx);assert.equal((failed.data as any).issues[0].code,'render_unavailable');assert.equal(count(f),countBefore);
 }finally{f.close();}
});

test('PDF input bounds come from the actual worker; an ordinary >512000-byte PDF remains usable',async()=>{
 const d=await PDFDocument.create(),page=d.addPage([400,300]);
 // Genuine large harmless PDF page content: one invented random comment, not
 // an embedded attachment or an old small probe wrapper.
 page.node.addContentStream(d.context.register(d.context.stream(Buffer.from('%'+randomBytes(320000).toString('hex')+'\n'))));
 const bytes=await d.save();assert.ok(bytes.length>512000&&bytes.length<8*1024*1024);
 const f=await overlayFixture(bytes);try {
  const inspect=await f.call('inspect');assert.equal(inspect.status,'ok');const limits=(inspect.data as any).metadata.limits;assert.equal(limits.inputPdfBytes,8*1024*1024);assert.equal(limits.pages,100);
  const result=await f.call('overlay',args());assert.equal(result.status,'ok',JSON.stringify(result));
  const read=await f.call('extract_text',{inputId:result.artifacts[0]!.id,pageIndex:0});assert.match((read.data as any).metadata.text,/0098765/);
  const oversized=f.store.put(f.ns,Buffer.alloc(8*1024*1024+1),'application/pdf',[],{provider:'user',providerId:'oversized-invented'}).source!;f.ctx.scope.sources.push(oversized);
  const failed=await f.call('overlay',{...args(),inputId:oversized.id});assert.equal(failed.status,'failed');assert.deepEqual(failed.artifacts,[]);
 }finally{f.close();}
});

test('active render cancellation kills the directly owned synthetic helper and leaves no overlay artifact',async()=>{
 const f=await overlayFixture(await flat());try {
  const render=await f.call('render',{pageIndex:0});assert.equal(render.status,'ok');
  const marker=join(f.dir,'pid'),helper=join(f.dir,'wait-render.cjs');writeFileSync(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});
  const tool=createDocumentTools(f.store,{...backend,pdftoppmExecutable:helper}).find(t=>t.name==='document.overlay')!;
  const pending=tool.invoke({inputId:f.source.id,...args(),coordinateSpace:{kind:'render_pixels',imageArtifactId:render.artifacts[0]!.id}},f.ctx);const settled=pending.then(value=>({value}),error=>({error}));
  const deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(marker));const pid=Number(readFileSync(marker,'utf8'));f.controller.abort();assert.ok('error' in await settled);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(count(f),2);
 }finally{f.close();}
});
