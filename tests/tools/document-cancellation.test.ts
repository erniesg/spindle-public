import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import type {ToolContext} from '../../core/agent/contracts.js';

for(const mode of ['abort','timeout'])test(`inflight direct renderer ${mode} kills owned process and publishes no artifact`,async()=>{
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','doc-cancel-'));const store=new EvidenceStore(join(dir,'store'));
 try{
 const marker=join(dir,'pid');const executable=join(dir,'renderer.cjs');
 // One directly-owned process, not a shell spawning an orphan helper. This is
 // process lifecycle machinery proof, not Poppler rendering acceptance.
 writeFileSync(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});
 const doc=await PDFDocument.create();doc.addPage();const ns={workspaceId:'w',accountId:'a'};const source=store.put(ns,Buffer.from(await doc.save()),'application/pdf',[],{provider:'user',providerId:'invented'}).source!;
 const controller=new AbortController();const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:controller.signal,budget:{used:0,limit:10},isCurrent:()=>true};
 const tool=createDocumentTools(store,{pdftoppmExecutable:executable}).find(t=>t.name==='document.export')!;
 const pending=tool.invoke({inputId:source.id,format:'png'},ctx);const settled=pending.then(x=>({result:x}),error=>({error}));
 const deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(marker),'renderer actually started');const pid=Number(readFileSync(marker,'utf8'));
 if(mode==='abort')controller.abort();const outcome=await settled;
 if(mode==='abort')assert.ok('error' in outcome);else {assert.ok('result' in outcome);if('result' in outcome){assert.equal(outcome.result.status,'failed');assert.deepEqual(outcome.result.artifacts,[]);}}
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
