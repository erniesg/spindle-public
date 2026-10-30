import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../../core/storage/agent-store.js';
import { startTaskReview } from '../../core/assistant/app.js';

test('persisted source payload stays in Task while read-only projections omit raw history',()=>{
 const dir=mkdtempSync(join(tmpdir(),'spindle-task-view-'));const path=join(dir,'agent.sqlite');
 const ns={workspaceId:'sample',accountId:'invented'};let store=new AgentStore(path);
 try {
 const task=store.admit({...ns,messageId:'large-source',outcome:'Full requested outcome '.repeat(100)},4);
 const source='PERSISTED_RAW_SOURCE_SENTINEL'+'x'.repeat(2*1024*1024);
 store.update(task.id,t=>{t.observations.push({callId:'files.read',status:'ok',data:{text:source},artifacts:[],evidence:[],observations:[]});t.decisions.push({kind:'ready',result:'RAW_DECISION_SENTINEL'});});
 store.close();store=new AgentStore(path);
 assert.equal((store.get(task.id).observations[0]!.data as {text:string}).text,source);
 const summaries=store.taskSummaries(ns);assert.equal(summaries[0]!.requestedOutcome.length,160);
 const view=store.taskView(ns,task.id)!;assert.equal(view.requestedOutcome,task.requestedOutcome);assert.deepEqual(view.checklist,task.checklist);
 for(const projected of [summaries,view]){const json=JSON.stringify(projected);assert.ok(json.length<16384);assert.ok(!json.includes('RAW_SOURCE_SENTINEL'));assert.ok(!json.includes('RAW_DECISION_SENTINEL'));assert.ok(!json.includes('observations'));assert.ok(!json.includes('checklistHistory'));}
 assert.deepEqual(store.taskSummaries({...ns,accountId:'foreign'}),[]);assert.equal(store.taskView({...ns,accountId:'foreign'},task.id),undefined);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('review boundary denies host/origin/auth, foreign IDs and oversized ACK; CSP and current Task readback',async()=>{
 const store=new AgentStore(':memory:');const ns={workspaceId:'invented',accountId:'sample'};
 const task=store.admit({...ns,messageId:'one',outcome:'<img src=x onerror=alert(1)>'},4);
 const foreign=store.admit({...ns,accountId:'other',messageId:'two',outcome:'Other'},4);
 const sentinel='INVENTED_RAW_SOURCE_SENTINEL';
 store.update(task.id,t=>{t.observations.push({callId:'sample',status:'ok',data:{text:sentinel+'x'.repeat(2*1024*1024)},artifacts:[],evidence:[],observations:[]});t.decisions.push({kind:'ready',result:'PRIVATE_DECISION_SENTINEL'});});
 const app=await startTaskReview(store,ns);const headers={Authorization:`Bearer ${app.token}`};
 try {
 assert.equal((await fetch(app.origin+'/api/tasks')).status,403);
 assert.equal(await new Promise<number|undefined>((resolve,reject)=>{const req=request(app.origin+'/api/tasks',{headers:{...headers,Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),403);
 assert.equal((await fetch(app.origin+'/api/tasks',{headers:{...headers,Origin:'https://evil.test'}})).status,403);
 const page=await fetch(app.origin);assert.match(page.headers.get('content-security-policy')!,/default-src 'none'/);assert.equal(page.headers.get('access-control-allow-origin'),null);
 const unknown=await fetch(app.origin+'/api/tasks/unknown',{headers});const denied=await fetch(app.origin+'/api/tasks/'+foreign.id,{headers});assert.equal(denied.status,404);assert.equal(await denied.text(),await unknown.text());
 store.update(task.id,t=>{t.status='blocked';t.nextAction='Choose another permitted input';});
 const current=await (await fetch(app.origin+'/api/tasks/'+task.id,{headers})).json();assert.equal(current.status,'blocked');
 for(const path of ['/api/tasks','/api/tasks/'+task.id]){const response=await (await fetch(app.origin+path,{headers})).text();assert.ok(response.length<16384);assert.ok(!response.includes(sentinel));assert.ok(!response.includes('PRIVATE_DECISION_SENTINEL'));assert.ok(!response.includes('observations'));assert.ok(!response.includes('checklistHistory'));}
 assert.equal((store.get(task.id).observations[0]!.data as {text:string}).text.length,sentinel.length+2*1024*1024);
 const ackHeaders={...headers,Origin:app.origin,'Content-Type':'application/json'};
 assert.equal((await fetch(app.origin+'/api/ack',{method:'POST',headers:ackHeaders,body:'x'.repeat(257)})).status,413);
 const notice=store.notifications(ns)[0]!;
 assert.equal((await fetch(app.origin+'/api/ack',{method:'POST',headers,body:JSON.stringify({id:notice.id})})).status,403);
 assert.equal((await fetch(app.origin+'/api/ack',{method:'POST',headers:ackHeaders,body:JSON.stringify({id:notice.id})})).status,200);
 assert.equal(store.notifications(ns).length,1);
 } finally {await app.close();store.close();}
});
