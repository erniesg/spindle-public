import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,alice} from './user-memory-fixture.js';
import {UserMemoryStore,validEntry} from '../../core/memory/user-store.js';
import {syncUserMemory} from '../../core/memory/sync.js';
import type {UserMemoryEntry,UserMemoryMutation} from '../../core/memory/user-protocol.js';
const ns={workspaceId:'w',accountId:alice};
const tombstone:UserMemoryEntry={workspaceId:'w',key:'drink',revision:2,seq:2,deleted:true,updatedAt:new Date().toISOString(),deletionReason:'source_invalidated'};
test('automatic reason is strict, content-free/deleted-only; missing reason stays permanent',async()=>{
 assert.equal(validEntry(tombstone,'w'),true);
 for(const bad of [{...tombstone,deleted:false},{...tombstone,value:'private'},{...tombstone,sources:[]},{...tombstone,deletionReason:'other'}])assert.equal(validEntry(bad,'w'),false);
 const f=fixture();try{const store=new UserMemoryStore(f.evidence.db);const {deletionReason,...old}=tombstone;store.putCanonical(ns,old);assert.equal(store.mutate(ns,{key:'drink',kind:'fact',value:'new',origin:'inferred',sources:[]}),undefined);store.putCanonical(ns,{...tombstone,revision:3,seq:3});assert.equal(store.mutate(ns,{key:'drink',kind:'fact',value:'new',origin:'inferred',sources:[]})?.expectedRevision,3);}finally{await f.close();}
});
for(const fromAck of [false,true])test(`automatic ${fromAck?'ACK':'page'} does not forget dependencies or discard a queued fresh inference`,async()=>{
 let op:UserMemoryMutation|undefined;let deletes=0;
 const f=fixture(undefined,(url,data)=>{
  if(url.pathname==='/user-memory/sync')return {acknowledged:[(data as {operations:UserMemoryMutation[]}).operations[0].id],entries:[tombstone]};
  return {entries:fromAck?[]:[tombstone],cursor:2,hasMore:false};
 });
 try{await f.app.signin('Alice','invented');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);
 op=store.mutate(ns,{key:'drink',kind:'preference',value:'old',origin:'inferred',sources:[]});
 // A later independently queued op for the same key must not be cleared by an old deleted ACK/page.
 const fresh=store.mutate(ns,{key:'drink',kind:'preference',value:'fresh',origin:'inferred',sources:[]})!;
 await syncUserMemory(store,ns,f.account,new AbortController().signal,()=>true,()=>{deletes++;store.acknowledge(ns,store.outbox(ns).map(o=>o.id));},!fromAck);
 assert.equal(deletes,0);assert.ok(store.outbox(ns).some(o=>o.id===fresh.id));assert.equal(store.sourceOutbox(ns).length,0);if(fromAck)assert.ok(!store.outbox(ns).some(o=>o.id===op!.id));
 }finally{await f.close();}
});
