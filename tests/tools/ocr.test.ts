import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EvidenceStore } from '../../core/evidence/store.js';
import { resolveOcr } from '../../core/evidence/ocr.js';
import { createOcrTool } from '../../core/tools/ocr.js';
import type { ToolContext } from '../../core/agent/contracts.js';
test('NIM HTTP boundary preserves changed strings/layout and rejects stale, namespace, geometry and bounded streams',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ocr-')); const store=new EvidenceStore(root); const ns={workspaceId:'invented',accountId:'sample'};
 // Real minimal PNG, unchanged original bytes enter the HTTP request.
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64');
 const source=store.put(ns,png,'image/png',[],{provider:'user'}).source!;
 let text='001234',x=0,mode='ok',requests=0,current=true,authorized=true;
 const server=createServer(async(req,res)=>{requests++;const parts:Buffer[]=[];for await(const b of req)parts.push(b);const body=JSON.parse(Buffer.concat(parts).toString());assert.equal(req.url,'/v1/ocr');assert.deepEqual(body.merge_levels,['word']);assert.equal(body.input[0].url,`data:image/png;base64,${png.toString('base64')}`);
 if(mode==='oversize'){res.end(' '.repeat(2*1024*1024+1));return;}
 if(mode==='stale')current=false;
 if(mode==='revoked')authorized=false;
 res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'test-nim-model',data:[{index:0,text_detections:[{text_prediction:{text,confidence:0.7},bounding_box:{points:[{x,y:0},{x:1,y:0},{x:1,y:1}]}}]}],usage:{}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
 const ctx:ToolContext={callId:'call',taskId:'task',runId:'run',...ns,budget:{limit:10,used:0},scope:{sources:[source],destinations:[],grants:['image.processing']},signal:new AbortController().signal,isCurrent:()=>current};
 const tool=createOcrTool({store,endpoint:`http://127.0.0.1:${address.port}/v1/ocr`,allowLoopback:true,authorize:()=>authorized});
 try {
 const first=await tool.invoke({sourceId:source.id},ctx);const a=first.data as any;assert.equal(a.spans[0].text,'001234');
 const regions=resolveOcr(store,ns,first.artifacts[0].id,source.id,source.sha256,[a.spans[0].id]);assert.equal(regions[0].polygon[1].x,1);
 text='00**99';x=0.2;const second=await tool.invoke({sourceId:source.id},ctx);const b=second.data as any;assert.equal(b.spans[0].text,text);assert.equal(b.spans[0].uncertainty,'unresolved');assert.notEqual(a.spans[0].id,b.spans[0].id);
 assert.throws(()=>resolveOcr(store,{...ns,accountId:'other'},first.artifacts[0].id,source.id,source.sha256,[a.spans[0].id]));assert.throws(()=>resolveOcr(store,ns,first.artifacts[0].id,source.id,'0'.repeat(64),[a.spans[0].id]));assert.throws(()=>resolveOcr(store,ns,first.artifacts[0].id,source.id,source.sha256,['invented']));
 const count=()=>Number(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);const before=count();
 x=1.1;assert.equal((await tool.invoke({sourceId:source.id},ctx)).status,'failed');assert.equal(count(),before);x=0;
 mode='stale';await assert.rejects(tool.invoke({sourceId:source.id},ctx),/Stale/);assert.equal(count(),before);current=true;
 mode='revoked';await assert.rejects(tool.invoke({sourceId:source.id},ctx),/not granted/);assert.equal(count(),before);authorized=true;
 mode='oversize';assert.equal((await tool.invoke({sourceId:source.id},ctx)).status,'failed');assert.equal(count(),before);
 const controller=new AbortController();controller.abort();const prior=requests;await assert.rejects(tool.invoke({sourceId:source.id},{...ctx,signal:controller.signal}),/Stale/);assert.equal(requests,prior);
 await assert.rejects(tool.invoke({sourceId:source.id},{...ctx,scope:{...ctx.scope,grants:[]}}),/not granted/);
 assert.throws(()=>createOcrTool({store,endpoint:'http://localhost/v1/ocr',authorize:()=>true}));
 } finally {await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));store.close();rmSync(root,{recursive:true,force:true});}
});
