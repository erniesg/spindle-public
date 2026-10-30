// Deterministic replay of the actual invented Nemotron decisions, NOT live-model quality evidence.
// Production dispatcher, SQLite, authenticated encrypted backend and recall; no manual inferred insert or ready.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore,digest} from '../../core/evidence/store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {ModelError} from '../../core/models/provider.js';
import type {AgentProvider,ToolResult} from '../../core/agent/contracts.js';
const quote='For fictional community grant applications, I prefer concise plain-language answers.';
const observedAction={key:'pref_fictional_grant_conciseness',kind:'preference',quote};
const off={conversation:false,activity:false,processing:false,sync:false};
for(const [label,values,selectedKey] of [
 ['canonical',['Prefers concise plain-language answers for fictional community grant applications.','Prefers concise plain-language answers for fictional community grant applications.','Prefers concise plain-language answers for fictional community grant applications.'],'pref_fictional_grant_conciseness'],
 ['actual ID22 verbatim',[quote],'preference_grant_style'],
 ['actual ID23 object',['concise plain-language answers'],'style_preference'],
 ['mixed representations',[quote,'concise plain-language answers','Prefers concise plain-language answers for fictional community grant applications.'],'style_preference'],
] as const)test('real dispatcher normalizes '+label+' to full qualified memory before no-ready timeout; cold restart, peer recall and correction',async()=>{
 const repeats=values.length;const args={...observedAction,key:selectedKey,value:values[0]};
 const root=mkdtempSync(join(tmpdir(),'spindle-tool-save-')),key=randomBytes(32);let server=await startTrackingServer(join(root,'server'),key);
 let ea=new EvidenceStore(join(root,'a')),eb=new EvidenceStore(join(root,'b'));let calls=0,loseAck=true;const observations:ToolResult[][]=[],pendingIds:string[][]=[],visibleBeforeNext:number[]=[],sentIds:string[][]=[];
 const provider:AgentProvider={id:'recorded-invented-nemotron-actions-no-live-call',async next(task){
  calls++;observations.push(structuredClone(task.observations));const ns={workspaceId:'w',accountId:task.sourceEvent.accountId};const store=new UserMemoryStore(ea.db);pendingIds.push(store.outbox(ns).map(o=>o.id));visibleBeforeNext.push(store.entries(ns).filter(e=>!e.deleted).length);
  if(calls<=repeats)return {kind:'tool',name:'memory.learn',args:{...args,value:values[calls-1]}};throw new ModelError('TIMEOUT_OR_CANCELLED');
 }};
 const make=(evidence:EvidenceStore,label:string,learning=false)=>createUserMemoryApplication({evidence,evidenceRoot:join(root,label),workspaceId:'w',account:new AccountClient(server.origin,async(input,init)=>{
  if(label==='a'&&new URL(String(input)).pathname==='/user-memory/sync'){sentIds.push((JSON.parse(String(init?.body)) as {operations:{id:string}[]}).operations.map(o=>o.id));const response=await fetch(input,init);if(loseAck){loseAck=false;await response.body?.cancel();throw Error('INVENTED_LOST_BACKEND_ACK');}return response;}return fetch(input,init);
 }),...(learning?{provider}:{})});
 let a=make(ea,'a',true),b=make(eb,'b');
 try{
  await a.signin('tool-save-sample','Invented-only-password-98!',true);await a.drain();await b.signin('tool-save-sample','Invented-only-password-98!');await b.drain();b.configure({...off,sync:true});await b.drain();a.configure({conversation:true,activity:false,processing:true,sync:true});await a.drain();a.conversation(quote);await a.drain();await b.drain();
  assert.equal(a.recall('concise')[0]?.value,quote,'qualified source meaning must survive a later planner timeout without ready');
  assert.equal(calls,repeats+1);const status=a.status();assert.equal(status.authenticated&&status.turns[0].state,'uncertain');
  assert.deepEqual(visibleBeforeNext,[0,...Array(repeats).fill(1)]);assert.equal(pendingIds[1].length,1);for(const ids of pendingIds.slice(1))assert.deepEqual(ids,pendingIds[1]);
  assert.equal(observations[1][0].status,'ok');for(const [index,observed] of observations.slice(1).entries())assert.deepEqual(observed.at(-1)!.data,{saved:true,durability:'local',sync:'pending',value:quote,outcome:index===0?'saved':'already_saved'});
  assert.equal(a.recall('concise')[0].pending,true,'lost backend ACK must not claim canonical sync');assert.equal(b.recall('concise')[0]?.value,quote);await a.drain();assert.equal(calls,repeats+1);assert.deepEqual(sentIds[0],sentIds[1],'retry only durable sync intent, never replay uncertain model dispatch');
  const fact=a.recall('concise')[0];assert.equal(fact.revision,1);assert.equal(fact.pending,false);assert.equal(fact.origin,'inferred');assert.equal(b.recall('concise')[0]?.value,quote);assert.equal(b.recall('concise')[0].pending,false);assert.equal(a.recall('concise').length,1);
  const source=fact.sources![0],ns={workspaceId:'w',accountId:source.accountId};assert.equal(source.sha256,digest(Buffer.from(quote)));assert.equal(source.excerpt,quote);assert.equal(source.workspaceId,'w');assert.equal(digest(ea.read(ns,new UserMemoryStore(ea.db).jobs(ns)[0].artifactId)),source.sha256);
  await a.stop();await b.stop();ea.close();eb.close();await server.close();
  // Cold Node process, no inherited objects/provider, actual encrypted backend + authenticated recall.
  // Ephemeral invented-data encryption key crosses stdin only, never argv/logs or a credential file.
  const cold=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`
   import {readFileSync} from 'node:fs';import {join} from 'node:path';
   const input=JSON.parse(readFileSync(0,'utf8'));
   const {startTrackingServer}=await import(input.serverModule),{EvidenceStore}=await import(input.evidenceModule),{AccountClient}=await import(input.accountModule),{createUserMemoryApplication}=await import(input.memoryModule);
   const server=await startTrackingServer(join(input.root,'server'),Buffer.from(input.key,'base64'));
   const ea=new EvidenceStore(join(input.root,'a')),eb=new EvidenceStore(join(input.root,'b'));
   const make=(evidence,label)=>createUserMemoryApplication({evidence,evidenceRoot:join(input.root,label),workspaceId:'w',account:new AccountClient(server.origin)});
   const a=make(ea,'a'),b=make(eb,'b');
   try{await a.signin('tool-save-sample','Invented-only-password-98!');await a.drain();await b.signin('tool-save-sample','Invented-only-password-98!');await b.drain();console.log(JSON.stringify({pid:process.pid,a:a.recall('concise'),b:b.recall('concise')}));}
   finally{await a.stop();await b.stop();ea.close();eb.close();await server.close();}
  `],{input:JSON.stringify({root,key:key.toString('base64'),serverModule:new URL('../../core/tracking/server.js',import.meta.url).href,evidenceModule:new URL('../../core/evidence/store.js',import.meta.url).href,accountModule:new URL('../../core/account/client.js',import.meta.url).href,memoryModule:new URL('../../core/memory/application.js',import.meta.url).href}),encoding:'utf8',stdio:['pipe','pipe','pipe']}) as string) as {pid:number;a:typeof fact[];b:typeof fact[]};
  assert.notEqual(cold.pid,process.pid);assert.equal(cold.a[0]?.value,quote);assert.equal(cold.b[0]?.value,quote);assert.equal(cold.a[0].pending,false);assert.equal(cold.b[0].sources![0].accountId,source.accountId);
  server=await startTrackingServer(join(root,'server'),key);ea=new EvidenceStore(join(root,'a'));eb=new EvidenceStore(join(root,'b'));a=make(ea,'a');b=make(eb,'b');
  await a.signin('tool-save-sample','Invented-only-password-98!');await a.drain();await b.signin('tool-save-sample','Invented-only-password-98!');await b.drain();
  assert.equal(a.recall('concise')[0]?.value,quote);assert.equal(b.recall('concise')[0]?.value,quote);assert.equal(b.recall('concise')[0].sources![0].accountId,source.accountId);assert.equal(new UserMemoryStore(ea.db).jobs(ns)[0].state,'uncertain');assert.equal(calls,repeats+1,'uncertain planner is never replayed after restart');
  const current=b.recall('concise')[0];b.correct(current.key,'preference','Use numbered outlines for fictional community grant applications.',current.revision);await b.drain();await a.drain();assert.equal(a.recall('numbered')[0]?.origin,'user');assert.equal(b.recall('numbered')[0]?.value,a.recall('numbered')[0].value);assert.equal(calls,repeats+1);
  const ec=new EvidenceStore(join(root,'other')),other=make(ec,'other');try{await other.signin('other-tool-save-user','Invented-other-password-98!',true);await other.drain();other.configure({...off,sync:true});await other.drain();assert.deepEqual(other.recall('concise'),[]);assert.deepEqual(other.recall('numbered'),[]);}finally{await other.stop();ec.close();}
 }finally{await a.stop();await b.stop();ea.close();eb.close();await server.close();rmSync(root,{recursive:true,force:true});}
});
