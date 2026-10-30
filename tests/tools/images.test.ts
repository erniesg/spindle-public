import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EvidenceStore } from '../../core/evidence/store.js';
import type { ToolContext } from '../../core/agent/contracts.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { createImageTools } from '../../core/tools/images.js';
const scratch=resolve('.local');
import { mkdirSync } from 'node:fs';
mkdirSync(scratch,{recursive:true});
const python=process.env.SPINDLE_IMAGE_PYTHON;
const model=process.env.SPINDLE_MODNET_MODEL;
const pixelSkip=python ? false : 'Set SPINDLE_IMAGE_PYTHON to a trusted Pillow environment; no automatic install/download.';
const mattingSkip=python && model ? false : 'Set SPINDLE_IMAGE_PYTHON and SPINDLE_MODNET_MODEL for pinned local ORT acceptance; no automatic download.';
function fixture(pixels=false) {
 const dir=mkdtempSync(resolve(scratch,'images-'));
 const store=new EvidenceStore(dir), ns={workspaceId:'w',accountId:'a'};
 const bytes=pixels ? execFileSync(python!,['-c',"from PIL import Image; import sys,io; im=Image.new('RGB',(100,100)); im.putdata([(x*2,y*2,40) for y in range(100) for x in range(100)]); im.save(sys.stdout.buffer,format='PNG')"]) : Buffer.from('invented opaque image input; not decoded');
 const source=store.put(ns,bytes,'image/png',[],{provider:'user',providerId:'invented-gradient'}).source!;
 const ctx:ToolContext={callId:'c',taskId:'t',runId:'r',...ns,scope:{sources:[source],grants:['image.processing'],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true};
 const tools=createImageTools(store,{pythonExecutable:pixels ? python : resolve(dir,'no-backend-configured')});
 return {dir,store,source,ctx,bytes,call:(name:string,inputId:string,parameters:unknown={})=>tools.find(t=>t.name===`image.${name}`)!.invoke({inputId,parameters},ctx),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('actual pinned local MODNet produces reusable RGBA, JPEG and changed PNG; fail closed and cancel',{skip:mattingSkip},async()=>{
 const f=fixture(true);try {
  const options={pythonExecutable:python,modelPath:model};
  const tools=createImageTools(f.store,options);
  const matte=tools.find(t=>t.name==='image.remove_background')!;
  const result=await matte.invoke({inputId:f.source.id,parameters:{}},f.ctx);
  assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.artifacts.length,1);
  assert.equal((result.data as any).metadata.mode,'RGBA');assert.equal((result.data as any).inference.provider,'CPUExecutionProvider');
  assert.equal((result.data as any).inference.modelSHA256,'07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9');
  for(const [format,width,height] of [['JPEG',400,514],['PNG',240,320]] as const) {
   const out=await f.call('crop_resize',result.artifacts[0]!.id,{crop:[0,0,100,100],width,height,format,backgroundRGB:[255,255,255],maxBytes:250000,quality:90});
   assert.equal(out.status,'ok',JSON.stringify(out));
   const check=await f.call('verify',out.artifacts[0]!.id,{format,width,height,mode:'RGB',maxBytes:250000});assert.equal((check.data as any).passed,true);
  }
  const bad=createImageTools(f.store,{...options,modelPath:resolve('tools/image-worker/worker.py')}).find(t=>t.name==='image.remove_background')!;
  const failed=await bad.invoke({inputId:f.source.id,parameters:{}},f.ctx);assert.equal(failed.status,'failed');assert.deepEqual(failed.artifacts,[]);
  const controller=new AbortController();f.ctx.signal=controller.signal;
  const inflight=matte.invoke({inputId:f.source.id,parameters:{}},f.ctx);setTimeout(()=>controller.abort(),150);
  await assert.rejects(inflight);
 }finally{f.close();}
});

test('actual decode and changed requirements produce RGB JPEG with byte limit; derived artifacts chain',{skip:pixelSkip},async()=>{
 const f=fixture(true);try {
  const inspect=await f.call('inspect',f.source.id);assert.equal(inspect.status,'ok');assert.equal((inspect.data as any).metadata.width,100);
  for(const [width,height] of [[400,514],[320,200]]) {
   const result=await f.call('crop_resize',f.source.id,{crop:[0,0,100,100],width,height,backgroundRGB:[255,255,255],maxBytes:250000,quality:90});
   assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.artifacts.length,1);
   const verified=await f.call('verify',result.artifacts[0]!.id,{width,height,format:'JPEG',mode:'RGB',maxBytes:250000});
   assert.equal((verified.data as any).passed,true);assert.equal((verified.data as any).backgroundVerified,false);
  }
 }finally{f.close();}
});
test('JPEG encoding tries the permitted quality floor before rejecting the byte limit',{skip:pixelSkip},async()=>{
 const f=fixture(true);try {
  const bytes=execFileSync(python!,['-c',"from PIL import Image; import random,sys; Image.frombytes('RGB',(200,200),random.Random(46).randbytes(120000)).save(sys.stdout.buffer,format='PNG')"]);
  const source=f.store.put({workspaceId:'w',accountId:'a'},bytes,'image/png',[],{provider:'user',providerId:'invented-noise'}).source!;
  f.ctx.scope.sources.push(source);
  const result=await f.call('crop_resize',source.id,{crop:[0,0,200,200],width:200,height:200,backgroundRGB:[255,255,255],format:'JPEG',maxBytes:1500,quality:90});
  assert.equal(result.status,'ok',JSON.stringify(result));
  assert.ok((result.data as any).metadata.bytes<1500);
  const verified=await f.call('verify',result.artifacts[0]!.id,{width:200,height:200,format:'JPEG',mode:'RGB',maxBytes:1500});
  assert.equal((verified.data as any).passed,true);
  assert.deepEqual(f.store.read({workspaceId:'w',accountId:'a'},source.snapshotArtifactId),bytes);
 }finally{f.close();}
});

test('retouch changes only selected decoded mask; original bytes preserved',{skip:pixelSkip},async()=>{
 const f=fixture(true);try {
  const result=await f.call('retouch',f.source.id,{mask:[40,40,50,50],cloneFrom:[10,10]});assert.equal(result.status,'ok');
  const out=f.store.read({workspaceId:'w',accountId:'a'},result.artifacts[0]!.id);
  const proof=execFileSync(python!,['-c',"from PIL import Image; import io,sys,json,base64; a,b=[Image.open(io.BytesIO(base64.b64decode(v))).convert('RGBA') for v in json.load(sys.stdin)]; changed=0\nfor y in range(100):\n for x in range(100):\n  if not (40<=x<50 and 40<=y<50): assert a.getpixel((x,y))==b.getpixel((x,y))\n  else: changed+=a.getpixel((x,y))!=b.getpixel((x,y))\nassert changed==100\nprint('outside-mask identical')"],{input:JSON.stringify([f.bytes.toString('base64'),out.toString('base64')])});
  assert.match(proof.toString(),/identical/);assert.deepEqual(f.store.read({workspaceId:'w',accountId:'a'},f.source.snapshotArtifactId),f.bytes);
 }finally{f.close();}
});
test('opaque inputs: wrong root, namespace/hash and failed worker produce no artifacts; cancellation rejects',async()=>{
 const f=fixture();try {
  const other=f.store.put({workspaceId:'w',accountId:'a'},f.bytes,'image/png').artifact;
  assert.equal((await f.call('inspect',other.id)).status,'failed');
  f.ctx.accountId='wrong';assert.equal((await f.call('inspect',f.source.id)).status,'failed');f.ctx.accountId='a';
  f.ctx.scope.sources[0]={...f.source,sha256:'0'.repeat(64)};assert.equal((await f.call('inspect',f.source.id)).status,'failed');f.ctx.scope.sources[0]=f.source;
  const failed=await f.call('retouch',f.source.id,{mask:[0,0,100,100],cloneFrom:[0,0]});assert.equal(failed.status,'failed');assert.deepEqual(failed.artifacts,[]);
  const cancelled=new AbortController();cancelled.abort();f.ctx.signal=cancelled.signal;await assert.rejects(f.call('inspect',f.source.id));
 }finally{f.close();}
});

test('schemas reject vacuous verify and out-of-bound parameters before execution',()=>{
 const f=fixture();try {
  const tools=createImageTools(f.store);
  assert.throws(()=>tools.find(t=>t.name==='image.verify')!.inputSchema.parse({inputId:f.source.id,parameters:{}}));
  assert.throws(()=>tools.find(t=>t.name==='image.crop_resize')!.inputSchema.parse({inputId:f.source.id,parameters:{crop:[0,0,100,100],width:4097,height:200,backgroundRGB:[255,255,255],maxBytes:250000,quality:90}}));
 }finally{f.close();}
});

test('sidecar insert failure cannot hide an image; complete provenance survives runtime restart',{skip:pixelSkip},async()=>{
 const f=fixture(true);let tasks=new AgentStore(resolve(f.dir,'tasks.sqlite'));
 try {
  // Real production SQLite boundary: the old independently committed sidecar fails.
  f.store.db.exec(`CREATE TRIGGER reject_sidecar BEFORE INSERT ON artifacts
   WHEN json_extract(NEW.body,'$.mimeType') = 'application/vnd.spindle.image-operation+json'
   BEGIN SELECT RAISE(ABORT, 'injected second insert failure'); END;`);
  const before=Number((f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get() as any).n);
  const task=tasks.admit({workspaceId:'w',accountId:'a',messageId:'atomic',outcome:'retouch invented pixels'},10);
  const parameters={mask:[40,40,50,50],cloneFrom:[10,10]};
  await new AgentRuntime(tasks,createImageTools(f.store,{pythonExecutable:python})).run(task.id,{id:'script-not-live-model',async next(){return {kind:'tool',name:'image.retouch',args:{inputId:f.source.id,parameters}};}},1,{scope:f.ctx.scope});
  const observation=tasks.get(task.id).observations[0]!;
  const after=Number((f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get() as any).n);
  assert.equal(after-before,observation.artifacts.length,'every persisted output must be reported, even under second-insert failure');
  assert.equal(observation.status,'ok');assert.equal(observation.artifacts.length,1);
  const output=observation.artifacts[0]!;
  tasks.close();tasks=new AgentStore(resolve(f.dir,'tasks.sqlite'));
  const saved=tasks.get(task.id).observations[0]!;const data=saved.data as any;
  assert.equal(data.inputId,f.source.id);assert.equal(data.inputHash,f.source.sha256);
  assert.equal(data.outputId,output.id);assert.equal(data.outputHash,output.sha256);
  assert.deepEqual(data.parameters,parameters);assert.equal(data.metadata.width,100);
  assert.deepEqual(saved.artifacts,observation.artifacts);assert.deepEqual(saved.evidence,observation.evidence);
 }finally{tasks.close();f.close();}
});
