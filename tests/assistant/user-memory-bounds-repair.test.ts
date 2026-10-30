import {test} from 'node:test';
import {startTaskReview} from '../../core/assistant/app.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import assert from 'node:assert/strict';
import {fixture,alice,scripted} from './user-memory-fixture.js';
import {UserMemoryStore,validEntry,validSource} from '../../core/memory/user-store.js';
import {USER_MEMORY_LIMITS as limits,type UserMemoryMutation,type UserMemorySource} from '../../core/memory/user-protocol.js';
const ns={workspaceId:'w',accountId:alice};
const source:UserMemorySource={id:'e'.repeat(limits.eventId),kind:'activity',sourceId:'s'.repeat(limits.sourceId),...ns,sha256:'a'.repeat(64),excerpt:'x'.repeat(limits.excerpt),observedAt:'2026-01-01T00:00:00.000Z',activityKey:'device/recording/visit',activityRevision:1};
test('wire source bounds and required activity metadata agree with the backend',()=>{
 assert.equal(validSource(source,'w'),true);
 for(const invalid of [{...source,id:source.id+'e'},{...source,sourceId:source.sourceId+'s'},{...source,activityKey:undefined},{...source,activityRevision:undefined},{...source,activityRevision:-1},{...source,kind:'conversation' as const}])assert.equal(validSource(invalid,'w'),false);
 const entry={workspaceId:'w',key:'k'.repeat(limits.key),revision:1,seq:1,deleted:false,updatedAt:'2026-01-01T00:00:00.000Z',kind:'fact',value:'v',origin:'inferred',sources:Array(limits.sources).fill(source)};
 assert.equal(validEntry(entry,'w'),true);assert.equal(validEntry({...entry,sources:[...entry.sources,source]},'w'),false);
});
test('accepted 513 and 8192 character keys advance the entire sync page and remain editable/pageable',async()=>{
 const entries=[513,limits.key].map((n,i)=>({workspaceId:'w',key:String(i)+'k'.repeat(n-1),revision:1,seq:i+1,deleted:false,updatedAt:'2026-01-01T00:00:00.000Z',kind:'fact',value:'Canonical',origin:'user',sources:[]}));
 const f=fixture(scripted(),()=>({entries,cursor:2,hasMore:false}));try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:false,processing:false,sync:true});await f.app.drain();const store=new UserMemoryStore(f.evidence.db);assert.equal(store.state(ns,'cursor'),'2');assert.equal(f.app.recall('Canonical').length,2);
 f.app.configure({conversation:false,activity:false,processing:false,sync:false});await f.app.drain();f.app.correct(entries[1].key,'fact','Edited',1);assert.equal(f.app.recall('Edited').length,1);assert.doesNotThrow(()=>f.app.status(entries[1].key));f.app.forget(entries[1].key);assert.deepEqual(f.app.recall('Edited'),[]);
 }finally{await f.close();}
});
test('assistant HTTP edit/forget and status cursor support worst-case encoded maximum keys',async()=>{
 const f=fixture(),tasks=new AgentStore(':memory:');const server=await startTaskReview(tasks,ns,f.evidence,f.app);
 try{await f.app.signin('Alice','invented');await f.app.drain();const key='鍵'.repeat(limits.key),value='\u0000'.repeat(limits.value-1)+'v';
 const post=async(data:unknown)=>fetch(server.origin+'/api/user-memory',{method:'POST',headers:{Authorization:`Bearer ${server.token}`,Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const response=await post({action:'correct',key,kind:'fact',value,revision:0});assert.equal(response.status,200);await response.body?.cancel();
 const page=await fetch(server.origin+'/api/user-memory?after='+encodeURIComponent(key),{headers:{Authorization:`Bearer ${server.token}`}});assert.equal(page.status,200);assert.deepEqual((await page.json() as {entries:unknown[]}).entries,[]);
 const forgotten=await post({action:'forget',key});assert.equal(forgotten.status,200);await forgotten.body?.cancel();assert.deepEqual(f.app.recall('v'),[]);
 }finally{await server.close();tasks.close();await f.close();}
});
test('encoded whole JSON bytes, including escaping, split batches and preserve IDs on retry',async()=>{
 const requests:UserMemoryMutation[][]=[];let fail=true,seq=0,reads=0;
 const f=fixture(scripted(),(url,data)=>{
  if(!url.pathname.endsWith('/sync')){reads++;return {entries:[],cursor:0,hasMore:false};}
  const operations=(data as {operations:UserMemoryMutation[]}).operations;requests.push(operations);
  assert.ok(Buffer.byteLength(JSON.stringify(data),'utf8')<=limits.requestBytes);
  if(fail){fail=false;return new Response('',{status:503});}
  return {acknowledged:operations.map(o=>o.id),entries:operations.map(o=>({workspaceId:o.workspaceId,key:o.key,revision:o.expectedRevision+1,seq:++seq,deleted:false,updatedAt:new Date().toISOString(),kind:o.kind,value:o.value,origin:o.origin,sources:o.sources}))};
 });
 try{await f.app.signin('Alice','invented');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);
  for(let i=0;i<16;i++)store.mutate(ns,{key:String(i).padStart(2,'0')+'\u0000'.repeat(limits.key-2),value:'\u0000'.repeat(limits.value-1)+'v',kind:'fact',origin:'user'});
  const queued=store.outbox(ns);assert.ok(queued.reduce((n,o)=>n+Buffer.byteLength(o.key+(o.value??'')),0)<limits.requestBytes);assert.ok(JSON.stringify({operations:queued}).length>limits.requestBytes);
  f.app.configure({conversation:false,activity:false,processing:false,sync:true});await f.app.drain();assert.equal(store.outbox(ns).length,16);
  await f.app.drain();assert.deepEqual(requests[0],requests[1]);assert.ok(store.outbox(ns).length>0);assert.ok(reads>0);
  for(let i=0;i<16&&store.outbox(ns).length;i++)await f.app.drain();assert.equal(store.outbox(ns).length,0);
  assert.deepEqual(requests.slice(1).flat().map(o=>o.id),queued.map(o=>o.id));
 }finally{await f.close();}
});
test('impossible corrupt oversized operation reports an error without blocking incoming reads or dropping it',async()=>{
 let reads=0;const f=fixture(scripted(),url=>{assert.ok(!url.pathname.endsWith('/sync'));reads++;return {entries:[],cursor:0,hasMore:false};});
 try{await f.app.signin('Alice','invented');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);const op=store.mutate(ns,{key:'corrupt',value:'valid',kind:'fact',origin:'user'})!;
  // A legacy/corrupt persisted row, not an operation admitted by the current field bounds.
  f.evidence.db.prepare('UPDATE user_memory_outbox SET body=? WHERE id=?').run(JSON.stringify({...op,value:'x'.repeat(limits.requestBytes)}),op.id);
  f.app.configure({conversation:false,activity:false,processing:false,sync:true});await f.app.drain();const status=f.app.status();assert.equal(status.authenticated&&status.error,'INVALID_MEMORY_OPERATION_BYTES');assert.equal(store.outbox(ns).length,1);assert.equal(reads,1);
 }finally{await f.close();}
});
test('learning tool accepts maximum wire key without truncation',async()=>{
 const key='k'.repeat(limits.key),f=fixture(scripted('I prefer tea',{key}));try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:true,activity:false,processing:true,sync:false});await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.equal(f.app.recall('tea')[0]?.key,key);}finally{await f.close();}
});
