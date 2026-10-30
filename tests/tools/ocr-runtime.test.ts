import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { createOcrTool } from '../../core/tools/ocr.js';
test('real HTTP OCR failure is observed and independent stored-source read reaches ready',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ocr-runtime-'));const evidence=new EvidenceStore(root);const state=new AgentStore(':memory:');
 const ns={workspaceId:'w',accountId:'a'};
 const source=evidence.put(ns,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64'),'image/png',[],{provider:'user'}).source!;
 const server=createServer((req,res)=>{req.resume();res.writeHead(503);res.end('unavailable');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const task=state.admit({...ns,messageId:'invented',outcome:'OCR or inspect source'},12);
 const before=Number(evidence.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
 const tool=createOcrTool({store:evidence,endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/ocr`,allowLoopback:true,authorize:()=>true});
 const runtime=new AgentRuntime(state,[tool,{name:'source.read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:v=>v},outputSchema:{jsonSchema:{type:'number'},parse:v=>v},async invoke(_args,ctx){return {callId:ctx.callId,status:'ok',data:evidence.read(ns,source.snapshotArtifactId).length,artifacts:[],evidence:[],observations:['Read original stored bytes']};}}]);
 try{
 await runtime.run(task.id,{id:'script-not-live-model',async next(t){
 if(!t.observations.length)return {kind:'tool',name:tool.name,args:{sourceId:source.id}};
 const failed=t.observations[0];assert.equal(failed.status,'failed');assert.equal(failed.error?.code,'ocr_unavailable');assert.match((failed.data as any).nextAction,/independent/);assert.deepEqual(failed.artifacts,[]);assert.equal(t.pending,undefined);assert.equal(t.recovery,'clean');
 if(t.observations.length===1)return {kind:'tool',name:'source.read',args:{}};
 assert.ok(Number(t.observations[1].data)>0);return {kind:'ready',result:'Original source remains available'};
 }},3,{scope:{sources:[source],destinations:[],grants:['image.processing']}});
 assert.equal(state.get(task.id).status,'ready');assert.equal(state.get(task.id).pending,undefined);assert.equal(Number(evidence.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n),before);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));state.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});
