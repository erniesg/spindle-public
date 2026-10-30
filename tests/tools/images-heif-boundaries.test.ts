import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createImageTools,canonicalizeImage} from '../../core/tools/images.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_HEIF_PYTHON;
const skip=python?false:'Explicit trusted Pillow + pinned pillow-heif interpreter required';
const parameters={format:'PNG',crop:[0,0,64,40],width:32,height:20,backgroundRGB:[255,255,255],maxBytes:100000,quality:90};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'heif-bound-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
 const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
 const encode=(body:string)=>execFileSync(python!,['-c',`from PIL import Image; import pillow_heif,sys; pillow_heif.register_heif_opener(); ${body}`]);
 const source=(bytes:Buffer)=>{const s=store.put(ns,bytes,'image/heif',[],{provider:'user'}).source!;ctx.scope.sources.push(s);return s;};
 return {dir,store,ns,ctx,encode,source,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('real HEIF EXIF/container orientation is applied once and retained in metadata',{skip},async()=>{
 const f=fixture();try{
  const bytes=f.encode("im=Image.new('RGB',(64,40),(200,40,20)); e=Image.Exif(); e[274]=6; im.save(sys.stdout.buffer,format='HEIF',quality=-1,exif=e.tobytes())");
  const source=f.source(bytes);const inspect=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.inspect')!;
  const result=await inspect.invoke({inputId:source.id,parameters:{}},f.ctx);assert.equal(result.status,'ok');const meta=(result.data as any).metadata;assert.equal(meta.originalOrientation,6);assert.equal(meta.exifOrientation,1);assert.equal(meta.width,40);assert.equal(meta.height,64);
  const canonical=await canonicalizeImage(bytes,f.ctx.signal,python);assert.deepEqual(canonical.orientedDimensions,[40,64]);assert.equal(canonical.originalOrientation,6);assert.deepEqual(canonical.sourceToEncoded,[1,0,0,0,1,0]);assert.equal(canonical.decoder.containerTransformsApplied,true);
 }finally{f.close();}
});
test('malformed and multiframe HEIF publish nothing',{skip},async()=>{
 const f=fixture();try{
  const multi=f.encode("im=Image.new('RGB',(64,40),'red'); im.save(sys.stdout.buffer,format='HEIF',save_all=True,append_images=[Image.new('RGB',(64,40),'blue')])");
  const inspect=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.inspect')!;
  for(const bytes of [multi.subarray(0,48),multi]){
   const s=f.source(bytes);const before=f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n;
   const failed=await inspect.invoke({inputId:s.id,parameters:{}},f.ctx);assert.equal(failed.status,'failed');assert.deepEqual(failed.artifacts,[]);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,before);
  }
 }finally{f.close();}
});
test('image intake accepts real images above old probe size and enforces 24MiB/64MP bounds',{skip},async()=>{
 const f=fixture();try{
  const inspect=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.inspect')!;
  const noisy=f.encode("import random; Image.frombytes('RGB',(500,500),random.Random(51).randbytes(750000)).save(sys.stdout.buffer,format='PNG')");assert.ok(noisy.length>512000);
  const large=f.encode("Image.new('RGB',(8001,8000),'white').save(sys.stdout.buffer,format='PNG')");
  for(const [bytes,expected] of [[noisy,'ok'],[large,'failed'],[Buffer.alloc(24*1024*1024+1),'failed']] as const){
   const source=f.store.put(f.ns,bytes,'image/png',[],{provider:'user'}).source!;f.ctx.scope.sources.push(source);const before=f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n;
   const r=await inspect.invoke({inputId:source.id,parameters:{}},f.ctx);assert.equal(r.status,expected);assert.deepEqual(r.artifacts,[]);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,before);
  }
 }finally{f.close();}
});
test('genuine SQLite read/publication faults escape image failures for reconciliation',{skip},async()=>{
 for(const stage of ['read','publish']){
  const f=fixture();try{
   const source=f.source(f.encode("Image.new('RGB',(64,40),'red').save(sys.stdout.buffer,format='HEIF')"));
   const tool=createImageTools(f.store,{pythonExecutable:python}).find(t=>t.name==='image.crop_resize')!;
   if(stage==='read')f.store.db.exec('DROP TABLE sources');
   else f.store.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'invented fault'); END");
   await assert.rejects(tool.invoke({inputId:source.id,parameters},f.ctx),(e:any)=>e.code==='ERR_SQLITE_ERROR');
   assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,1);
  }finally{f.close();}
 }
});
test('missing decoder gives meaningful trusted-configuration failure instead of a product exclusion',{skip:python&&process.platform!=='win32'?false:skip||'POSIX-only isolated interpreter test'},async()=>{
 const f=fixture();try{
  const bytes=f.encode("Image.new('RGB',(64,40),'red').save(sys.stdout.buffer,format='HEIF')");const source=f.source(bytes);
  // Explicit test override, not dependent on installed system HEIF support.
  const launcher=join(f.dir,'python-no-heif');
  writeFileSync(launcher,`#!${python}\nimport runpy,sys\nsys.modules['pillow_heif']=None\nsys.argv=sys.argv[2:]\nrunpy.run_path(sys.argv[0],run_name='__main__')\n`);chmodSync(launcher,0o700);
  const tool=createImageTools(f.store,{pythonExecutable:launcher}).find(t=>t.name==='image.inspect')!;
  const r=await tool.invoke({inputId:source.id,parameters:{}},f.ctx);assert.equal(r.status,'failed');assert.match(r.error!.message,/HEIF decoder unavailable/);assert.deepEqual(r.artifacts,[]);
 }finally{f.close();}
});
