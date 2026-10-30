import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import type {HistoryRecord,Entry} from '../../core/tracking/types.js';
import type {UserMemoryState} from '../../core/tracking/user-memory.js';
import {isUserMemorySource,type UserMemoryMutation,type UserMemoryAck,type UserMemoryPage} from '../../core/memory/user-protocol.js';
function record(deviceId:string):HistoryRecord {
 const now=Date.now();return {schema:'spindle-tracking/v1',deviceId,recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+60000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented preference',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'Prefers tea',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+60000}};
}
test('offline learner: memory-only peer receives durable source deletion, restart and new-key late-write fences',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memory-lifecycle-')),key=randomBytes(32),directory=join(dir,'server');let server=await startTrackingServer(directory,key);
 try {
  const producer=new TrackingClient(server.origin,join(dir,'producer'),randomBytes(32));await producer.signin('invented-lifecycle','invented-password-123','Producer',true);
  const r=record((await producer.inspect()).deviceId),op={id:'history',deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,record:r};await producer.enqueue(op);await producer.sync();
  const learner=new AccountClient(server.origin),peer=new AccountClient(server.origin),identity=await learner.signin('invented-lifecycle','invented-password-123');await peer.signin('invented-lifecycle','invented-password-123');
  const source={id:'source',kind:'activity' as const,sourceId:'local-source',workspaceId:'independent-workspace',accountId:identity.id,sha256:createHash('sha256').update([r.visit.title,r.visit.text].filter(Boolean).join('\n')).digest('hex'),excerpt:'Prefers tea',observedAt:new Date(r.wallAnchor+r.observedAt-r.monotonicAnchor).toISOString(),expiresAt:new Date(r.visit.expiresAt).toISOString(),activityKey:`${r.deviceId}/recording/visit`,activityRevision:1};
  const put:UserMemoryMutation={id:'learn',workspaceId:source.workspaceId,key:'drink',expectedRevision:0,action:'put',kind:'preference',value:'Prefers tea',origin:'inferred',sources:[source]};
  const sync=(c:AccountClient,operations:UserMemoryMutation[])=>c.request('/user-memory/sync',{operations}) as Promise<UserMemoryAck>;
  const page=(c:AccountClient)=>c.request('/user-memory/changes?workspaceId=independent-workspace&cursor=0') as Promise<UserMemoryPage>;
  await sync(learner,[put,{...put,id:'learn-corrected',key:'corrected'}]);await sync(learner,[{...put,id:'correction',key:'corrected',expectedRevision:1,origin:'user',value:'Prefers coffee',sources:[]}]);
  assert.equal((await page(peer)).entries[0]!.value,'Prefers tea');await learner.signout();
  await producer.enqueue({id:'delete',deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,delete:true});await producer.sync();
  const after=await page(peer),tombstone=after.entries.find(e=>e.key==='drink')!;assert.equal(tombstone.deleted,true);assert.equal(tombstone.revision,2);assert.equal(tombstone.value,undefined);assert.equal(after.entries.find(e=>e.key==='corrected')!.value,'Prefers coffee');
  assert.deepEqual((await sync(peer,[put])).entries,[tombstone]);await assert.rejects(sync(peer,[{...put,id:'late-new-id',key:'new-key'}]),/409/);
  await server.close();server=await startTrackingServer(directory,key);const restarted=new AccountClient(server.origin);await restarted.signin('invented-lifecycle','invented-password-123');assert.deepEqual(await page(restarted),after);await assert.rejects(sync(restarted,[{...put,id:'restart-late',key:'another-key'}]),/409/);
  const stored=await new EncryptedStore<{accounts:{memory:UserMemoryState}[]}>(directory,key,()=>({accounts:[]})).transaction(s=>s,false);assert.equal(JSON.stringify(stored.accounts[0]!.memory).includes('Prefers tea'),false);
 } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
test('encrypted legacy user provenance repairs advance cursors, retain corrections and cannot replay forgotten content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memory-legacy-source-')),key=randomBytes(32),directory=join(dir,'server');let server=await startTrackingServer(directory,key);
 try{
  const c=new AccountClient(server.origin),identity=await c.signin('invented-legacy-source','invented-password-123',true);
  const valid={id:'valid-source',kind:'activity' as const,sourceId:'valid-source',workspaceId:'workspace',accountId:identity.id,sha256:'a'.repeat(64),excerpt:'Invented',observedAt:new Date().toISOString(),activityKey:'device/recording/visit',activityRevision:0};
  const malformed={...valid,id:'legacy-source',activityKey:'not-a-history-key'};
  const oldPut:UserMemoryMutation={id:'legacy-put',workspaceId:'workspace',key:'correction',expectedRevision:0,action:'put',kind:'fact',value:'Independent correction',origin:'user',sources:[malformed,valid]};
  await server.close();
  const store=new EncryptedStore<{accounts:{memory:UserMemoryState}[]}>(directory,key,()=>({accounts:[]}));
  // Simulate a prior API-accepted row and its actual payload digest in the real
  // encrypted store, not a forged HTTP page. The former API accepted this source.
  const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
  const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
  await store.transaction(s=>{
   const entry={workspaceId:'workspace',key:'correction',revision:1,seq:1,deleted:false,updatedAt:valid.observedAt,kind:'fact' as const,value:oldPut.value,origin:'user' as const,sources:oldPut.sources};
   const forgotten={...entry,key:'forgotten',revision:2,seq:2,deleted:true,value:undefined,origin:undefined,kind:undefined,sources:undefined};
   const inferred={...entry,key:'inferred',origin:'inferred' as const,seq:3,sources:[malformed]};
   s.accounts[0]!.memory={entries:[entry,forgotten,inferred],sequence:3,operationReceipts:[{id:oldPut.id,digest:digest(oldPut),entry},{id:'old-forgotten-put',digest:'old',entry:{...entry,key:'forgotten',value:'FORGOTTEN SENTINEL'}},{id:'old-forget',digest:'old',entry:forgotten},{id:'inferred',digest:'old',entry:inferred}]};
  });
  server=await startTrackingServer(directory,key);const peer=new AccountClient(server.origin);await peer.signin('invented-legacy-source','invented-password-123');
  const page=await peer.request('/user-memory/changes?workspaceId=workspace&cursor=3') as UserMemoryPage;
  const repaired=page.entries.find(e=>e.key==='correction')!;
  assert.equal(repaired.value,oldPut.value);assert.equal(repaired.origin,'user');assert.equal(repaired.revision,2);assert.ok(repaired.seq>3);assert.ok(Number.isFinite(Date.parse(repaired.updatedAt)));assert.deepEqual(repaired.sources,[valid]);
  assert.ok(page.entries.find(e=>e.key==='inferred')!.deleted);assert.ok(page.entries.every(e=>(e.sources??[]).every(s=>isUserMemorySource(s,e.workspaceId,identity.id))));
  assert.deepEqual((await peer.request('/user-memory/sync',{operations:[oldPut]}) as UserMemoryAck).entries,[repaired]);
  await assert.rejects(peer.request('/user-memory/sync',{operations:[{...oldPut,value:'payload drift'}]}),/400|409/);
  const stored=await store.transaction(s=>s.accounts[0]!.memory,false);assert.equal(JSON.stringify(stored).includes('not-a-history-key'),false);assert.equal(JSON.stringify(stored).includes('FORGOTTEN SENTINEL'),false);assert.ok(stored.operationReceipts.filter(r=>r.entry.key==='forgotten').every(r=>r.entry.deleted));
  await peer.request('/user-memory/sync',{operations:[{id:'forget-correction',workspaceId:'workspace',key:'correction',expectedRevision:2,action:'forget'}]});
  const replay=await peer.request('/user-memory/sync',{operations:[oldPut]}) as UserMemoryAck;assert.ok(replay.entries[0]!.deleted);assert.equal(replay.entries[0]!.value,undefined);
  await server.close();server=await startTrackingServer(directory,key);const fresh=new AccountClient(server.origin);await fresh.signin('invented-legacy-source','invented-password-123');
  const final=await fresh.request('/user-memory/changes?workspaceId=workspace&cursor=0') as UserMemoryPage;assert.equal(final.entries.length,3);assert.ok(final.entries.every(e=>e.deleted));
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('expiry, changed history, unverifiable legacy sources and forgotten conversations scrub receipts without a learner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memory-expiry-')),key=randomBytes(32),directory=join(dir,'server');let server=await startTrackingServer(directory,key);
 try {
  const c=new AccountClient(server.origin),identity=await c.signin('invented-expiry','invented-password-123',true);
  const sync=(operations:UserMemoryMutation[])=>c.request('/user-memory/sync',{operations}) as Promise<UserMemoryAck>;
  const put:UserMemoryMutation={id:'chat',workspaceId:'workspace',key:'chat',expectedRevision:0,action:'put',kind:'fact',origin:'inferred',value:'INVENTED expired fact',sources:[{id:'chat-source',kind:'conversation',sourceId:'conversation',workspaceId:'workspace',accountId:identity.id,sha256:'a'.repeat(64),excerpt:'INVENTED expired fact',observedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}]};
  await sync([put,{...put,id:'independent',key:'independent',origin:'user',sources:[],value:'Independent correction'}]);
  await sync([{id:'forget-chat',workspaceId:'workspace',key:'chat',expectedRevision:1,action:'forget'}]);await assert.rejects(sync([{...put,id:'resurrect',key:'fresh'}]),/409/);
  const expiring={...put,id:'expires',key:'expires',sources:[{...put.sources![0]!,sourceId:'expires'}]};await sync([expiring]);
  await server.close();
  // Persisted fixtures model an old server and elapsed time without wall-clock sleeps.
  const store=new EncryptedStore<{accounts:{memory:UserMemoryState;entries:Entry[]}[]}>(directory,key,()=>({accounts:[]}));
  await store.transaction(s=>{const a=s.accounts[0]!,m=a.memory;for(const e of [...m.entries,...m.operationReceipts.map(r=>r.entry)])if(e.key==='expires'&&e.sources)e.sources[0]!.expiresAt=new Date(Date.now()-1000).toISOString();
   const r=record('device'),base=m.entries.find(e=>e.key==='expires')!;
   a.entries.push({key:'device/recording/visit',deviceId:'device',recordingId:'recording',visitId:'visit',seq:1,deleted:false,record:r});
   for(const variant of ['legacy','changed','context-expired']){const sources=[{...put.sources![0]!,kind:'activity' as const,sourceId:variant,sha256:createHash('sha256').update([r.visit.title,r.visit.text].filter(Boolean).join('\n')).digest('hex'),excerpt:'Prefers tea',...(variant==='legacy'?{}:{activityKey:'device/recording/visit',activityRevision:variant==='changed'?0:1})}];const e={...base,key:variant,deleted:false,sources,seq:++m.sequence};m.entries.push(e);m.operationReceipts.push({id:variant,digest:'old',entry:e});}r.visit.expiresAt=Date.now()-1;
  });
  server=await startTrackingServer(directory,key);const restarted=new AccountClient(server.origin);await restarted.signin('invented-expiry','invented-password-123');
  const page=await restarted.request('/user-memory/changes?workspaceId=workspace&cursor=0') as UserMemoryPage;assert.ok(page.entries.filter(e=>e.key!=='independent').every(e=>e.deleted));assert.equal(page.entries.find(e=>e.key==='independent')!.value,'Independent correction');
  await assert.rejects(restarted.request('/user-memory/sync',{operations:[{...expiring,id:'late-expiry',key:'late',sources:[{...expiring.sources[0]!,expiresAt:new Date(Date.now()-1000).toISOString()}]}]}),/409/);
  await assert.rejects(restarted.request('/user-memory/sync',{operations:[{...expiring,id:'fabricated-expiry',key:'late-future',sources:[{...expiring.sources[0]!,expiresAt:new Date(Date.now()+60000).toISOString()}]}]}),/409/);
  const state=await store.transaction(s=>s,false);assert.equal(JSON.stringify(state.accounts[0]!.memory).includes('INVENTED expired fact'),false);
  const expired=page.entries.find(e=>e.key==='expires')!;assert.equal(expired.deletionReason,'source_invalidated');
  await assert.rejects(restarted.request('/user-memory/sync',{operations:[{...expiring,id:'renew-old-source',expectedRevision:expired.revision,sources:[{...expiring.sources[0]!,expiresAt:new Date(Date.now()+60000).toISOString()}]}]}),/409/);
  const fresh={...put.sources![0]!,sourceId:'genuinely-new',excerpt:'New valid source',expiresAt:new Date(Date.now()+60000).toISOString()};
  const recreated=await restarted.request('/user-memory/sync',{operations:[{...expiring,id:'fresh-after-expiry',expectedRevision:expired.revision,sources:[fresh],value:'New fact'}]}) as UserMemoryAck;
  assert.equal(recreated.entries[0]!.value,'New fact');assert.equal(recreated.entries[0]!.deletionReason,undefined);
  assert.deepEqual((await restarted.request('/user-memory/sync',{operations:[expiring]}) as UserMemoryAck).entries,[expired]);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
