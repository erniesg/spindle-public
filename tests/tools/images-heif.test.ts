import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {createImageTools,canonicalizeImage} from '../../core/tools/images.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_HEIF_PYTHON;
const skip=python?false:'Explicit trusted Pillow + pinned pillow-heif interpreter required';
test('actual invented HEIF decode, alpha, changed transforms and immutable original through public image tools',{skip},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heif-'));const store=new EvidenceStore(dir);const ns={workspaceId:'w',accountId:'a'};
 try {
  const bytes=execFileSync(python!,['-c',`from PIL import Image; import pillow_heif,sys; pillow_heif.register_heif_opener(); im=Image.new('RGBA',(64,40),(200,40,20,128)); im.save(sys.stdout.buffer,format='HEIF',quality=-1,chroma=444)`]);
  assert.equal(bytes.toString('ascii',4,8),'ftyp');
  const source=store.put(ns,bytes,'image/heif',[],{provider:'user'}).source!;
  const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
  const tools=createImageTools(store,{pythonExecutable:python});
  const invoke=(op:string,parameters:unknown)=>tools.find(t=>t.name===`image.${op}`)!.invoke({inputId:source.id,parameters},ctx);
  const inspected=await invoke('inspect',{});assert.equal(inspected.status,'ok',JSON.stringify(inspected));assert.equal((inspected.data as any).metadata.decoder.backend,'pillow-heif');assert.equal((inspected.data as any).metadata.width,64);
  for(const [width,height,format] of [[32,20,'PNG'],[24,30,'JPEG']] as const){
   const result=await invoke('crop_resize',{crop:[0,0,64,40],width,height,format,backgroundRGB:[255,255,255],maxBytes:100000,quality:90});assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.artifacts.length,1);assert.equal((result.data as any).sourceMetadata.decoder.version,'1.8.1');assert.equal((result.data as any).metadata.width,width);assert.equal((result.data as any).inputHash,digest(bytes));
   const pixel=execFileSync(python!,['-c',`from PIL import Image; import io,sys,json; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps(list(im.convert('RGB').getpixel((0,0)))))`],{input:store.read(ns,result.artifacts[0].id)});const rgb=JSON.parse(pixel.toString());assert.ok(rgb[0]>210&&rgb[1]>130&&rgb[2]>120,'alpha composited to chosen white');
  }
  const canonical=await canonicalizeImage(bytes,ctx.signal,python);assert.deepEqual(canonical.orientedDimensions,[64,40]);assert.equal(canonical.originalHash,digest(bytes));assert.equal(canonical.decoder.backend,'pillow-heif');
  const before=store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n;
  for(const parameters of [{crop:[0,0,65,40],width:32,height:20,format:'PNG',backgroundRGB:[255,255,255],maxBytes:100000,quality:90},{crop:[0,0,64,40],width:4096,height:4096,format:'PNG',backgroundRGB:[255,255,255],maxBytes:1,quality:90}])assert.equal((await invoke('crop_resize',parameters)).status,'failed');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,before);assert.deepEqual(store.read(ns,source.snapshotArtifactId),bytes);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
