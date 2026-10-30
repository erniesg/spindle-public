import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createImageTools} from '../../core/tools/images.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const python=process.env.SPINDLE_IMAGE_PYTHON,skip=python?false:'Configure existing trusted Pillow interpreter; no install/download';
const parameters={text:'Sample',x:20,y:320,fontSize:42,colorRGB:[255,255,255],opacity:230,strokeRGB:[0,0,0],strokeWidth:2};
function fixture(){mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/text-overlay-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};const bytes=execFileSync(python!,['-E','-c',"from PIL import Image; import sys; im=Image.new('RGB',(320,400)); im.putdata([(x%256,y%256,100) for y in range(400) for x in range(320)]); im.save(sys.stdout.buffer,format='PNG')"]);const source=store.put(ns,bytes,'image/png',[],{provider:'user',providerId:'invented-pixels'}).source!;const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};const tool=createImageTools(store,{pythonExecutable:python}).find(t=>t.name==='image.text_overlay');assert.ok(tool,'general registered text-overlay capability is required');let closed=false;return{dir,store,ns,bytes,source,ctx,tool,closeStore(){store.close();closed=true;},close(){if(!closed)store.close();rmSync(dir,{recursive:true,force:true});}};}
test('registered general text overlay draws actual Sample pixels; dimensions, literal text, bounds and original bytes persist',{skip},async()=>{const f=fixture();try{const out=await f.tool.invoke({inputId:f.source.id,parameters},f.ctx);assert.equal(out.status,'ok',JSON.stringify(out));const data=out.data as any;assert.equal(data.operation,'text_overlay');assert.equal(data.textOverlay.text,'Sample');assert.deepEqual([data.metadata.width,data.metadata.height,data.metadata.format],[320,400,'PNG']);const bytes=f.store.read(f.ns,out.artifacts[0].id);assert.notDeepEqual(bytes,f.bytes);const proof=execFileSync(python!,['-E','-c',"from PIL import Image,ImageChops,ImageDraw; import io,sys,json,base64; d=json.load(sys.stdin); a,b=[Image.open(io.BytesIO(base64.b64decode(v))).convert('RGBA') for v in d['images']]; assert a.size==b.size==(320,400); diff=ImageChops.difference(a,b).convert('RGB'); box=diff.getbbox(); assert box and box[2]-box[0]>100 and box[3]-box[1]>20; x,y,w,h=d['box']; assert x<=box[0] and y<=box[1] and box[2]<=x+w and box[3]<=y+h; ImageDraw.Draw(diff).rectangle((x,y,x+w-1,y+h-1),fill=(0,0,0)); assert diff.getbbox() is None; print('visible glyph pixels and unchanged outside box')"],{input:JSON.stringify({images:[f.bytes.toString('base64'),bytes.toString('base64')],box:data.textOverlay.box})});assert.match(proof.toString(),/visible glyph/);assert.deepEqual(f.store.read(f.ns,f.source.snapshotArtifactId),f.bytes);if(process.env.SPINDLE_TEXT_OVERLAY_PROOF){mkdirSync(process.env.SPINDLE_TEXT_OVERLAY_PROOF,{recursive:true});writeFileSync(join(process.env.SPINDLE_TEXT_OVERLAY_PROOF,'invented-sample.png'),bytes);}const second=await f.tool.invoke({inputId:f.source.id,parameters:{...parameters,text:'Draft',fontSize:24,x:8,y:8}},f.ctx);assert.equal(second.status,'ok');assert.notEqual(second.artifacts[0].sha256,out.artifacts[0].sha256);const saved=out.artifacts[0].id;f.closeStore();const reopened=new EvidenceStore(f.dir);try{assert.deepEqual(reopened.read(f.ns,saved),bytes);}finally{reopened.close();}}finally{f.close();}});
for(const mode of ['RGBA','LA','P','RGB'])test('text overlay preserves all outside-box RGBA pixels for transparent '+mode+' input',{skip},async()=>{
 const f=fixture();try{
  const bytes=execFileSync(python!,['-E','-c',`from PIL import Image
import sys
mode=sys.argv[1]; size=(160,100); opts={}
if mode=='P':
 im=Image.new('P',size,0); im.putpalette([70,80,90]+[0,0,0]*255); opts['transparency']=0
elif mode=='LA': im=Image.new(mode,size,(70,0))
elif mode=='RGBA': im=Image.new(mode,size,(70,80,90,0))
else:
 im=Image.new('RGB',size,(70,80,90)); opts['transparency']=(70,80,90)
im.save(sys.stdout.buffer,format='PNG',**opts)`,mode]);
  const source=f.store.put(f.ns,bytes,'image/png',[],{provider:'user',providerId:'invented-alpha-'+mode}).source!;f.ctx.scope.sources.push(source);
  const out=await f.tool.invoke({inputId:source.id,parameters:{...parameters,x:8,y:60,fontSize:24,strokeWidth:1}},f.ctx);assert.equal(out.status,'ok',JSON.stringify(out));
  const result=f.store.read(f.ns,out.artifacts[0].id);execFileSync(python!,['-E','-c',`from PIL import Image,ImageChops,ImageDraw
import io,sys,json,base64
d=json.load(sys.stdin); a,b=[Image.open(io.BytesIO(base64.b64decode(v))).convert('RGBA') for v in d['images']]
assert a.size==b.size==(160,100)
assert a.getpixel((0,0))==b.getpixel((0,0)) and b.getpixel((0,0))[3]==0
x,y,w,h=d['box']; diff=ImageChops.difference(a,b)
assert diff.getbbox(alpha_only=False)
ImageDraw.Draw(diff).rectangle((x,y,x+w-1,y+h-1),fill=(0,0,0,0))
assert diff.getbbox(alpha_only=False) is None`,],{input:JSON.stringify({images:[bytes.toString('base64'),result.toString('base64')],box:(out.data as any).textOverlay.box})});
  assert.equal((out.data as any).metadata.mode,'RGBA');assert.deepEqual(f.store.read(f.ns,source.snapshotArtifactId),bytes);
 }finally{f.close();}
});
test('text overlay uses actual EXIF/HEIF display dimensions and never changes original inputs',{skip},async()=>{const f=fixture();try{for(const kind of ['JPEG','HEIF']){const bytes=execFileSync(python!,['-E','-c',"from PIL import Image; import sys; im=Image.new('RGB',(100,160),(40,80,120))\nif sys.argv[1]=='JPEG':\n ex=Image.Exif(); ex[274]=6; im.save(sys.stdout.buffer,format='JPEG',exif=ex)\nelse:\n import pillow_heif; pillow_heif.register_heif_opener(); im=im.transpose(Image.Transpose.ROTATE_90); im.save(sys.stdout.buffer,format='HEIF',quality=90)",kind]);const source=f.store.put(f.ns,bytes,kind==='JPEG'?'image/jpeg':'image/heif',[],{provider:'user',providerId:'invented-'+kind}).source!;f.ctx.scope.sources.push(source);const out=await f.tool.invoke({inputId:source.id,parameters:{...parameters,x:8,y:60,fontSize:24,strokeWidth:1}},f.ctx);assert.equal(out.status,'ok',JSON.stringify(out));assert.deepEqual([(out.data as any).metadata.width,(out.data as any).metadata.height],[160,100]);assert.deepEqual(f.store.read(f.ns,source.snapshotArtifactId),bytes);}}finally{f.close();}});
test('text overlay rejects control/path/overflow, wrong owner/source/grant and cancellation without new artifacts',{skip},async()=>{const f=fixture();try{for(const p of [{...parameters,text:'x\nsecret'},{...parameters,fontSize:257},{...parameters,path:'/not-a-font'},{...parameters,opacity:0}])assert.throws(()=>f.tool.inputSchema.parse({inputId:f.source.id,parameters:p}));const before=Number((f.store.db.prepare('select count(*) n from artifacts').get() as any).n);const fail=await f.tool.invoke({inputId:f.source.id,parameters:{...parameters,x:319}},f.ctx);assert.equal(fail.status,'failed');assert.equal(Number((f.store.db.prepare('select count(*) n from artifacts').get() as any).n),before);f.ctx.accountId='other';assert.equal((await f.tool.invoke({inputId:f.source.id,parameters},f.ctx)).status,'failed');f.ctx.accountId='a';await assert.rejects(f.tool.invoke({inputId:f.source.id,parameters},{...f.ctx,scope:{...f.ctx.scope,grants:[]}}));const aborted=new AbortController();aborted.abort();f.ctx.signal=aborted.signal;await assert.rejects(f.tool.invoke({inputId:f.source.id,parameters},f.ctx));}finally{f.close();}});
