import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import type {UserMemoryState} from '../../core/tracking/user-memory.js';
import type {UserMemorySource,UserMemoryMutation,UserMemoryAck,UserMemoryPage,UserMemorySourceForget} from '../../core/memory/user-protocol.js';

type Stored={accounts:{id:string;devices:unknown[];memory:UserMemoryState}[]};
const sync=(c:AccountClient,operations:UserMemoryMutation[])=>c.request('/user-memory/sync',{operations}) as Promise<UserMemoryAck>;
const page=(c:AccountClient,cursor=0)=>c.request(`/user-memory/changes?workspaceId=workspace&cursor=${cursor}`) as Promise<UserMemoryPage>;
const forget=(c:AccountClient,op:UserMemorySourceForget)=>c.request('/user-memory/forget-source',op);
function source(accountId:string,sourceId='conversation'):UserMemorySource {return {id:'source',kind:'conversation',sourceId,workspaceId:'workspace',accountId,sha256:'a'.repeat(64),excerpt:'INVENTED original tea excerpt',observedAt:new Date().toISOString()};}
function put(s:UserMemorySource,key='drink'):UserMemoryMutation {return {id:`learn-${key}`,workspaceId:s.workspaceId,key,expectedRevision:0,action:'put',kind:'preference',value:'INVENTED inferred tea fact',origin:'inferred',sources:[s]};}
function operation(s:UserMemorySource,id='source-forget'):UserMemorySourceForget {return {id,workspaceId:s.workspaceId,kind:s.kind,sourceId:s.sourceId,...(s.activityKey?{activityKey:s.activityKey}:{})};}

test('source forget after correction: durable exact ACK, scrubbed receipts, canonical provenance repair and new-key fence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-forget-')),key=randomBytes(32);let server=await startTrackingServer(directory,key);
 const store=new EncryptedStore<Stored>(directory,key,()=>({accounts:[]}));
 try{
  const a=new AccountClient(server.origin),b=new AccountClient(server.origin),identity=await a.signin('invented-source-forget','invented-password-123',true);await b.signin('invented-source-forget','invented-password-123');
  const s=source(identity.id),learn=put(s),op=operation(s);
  await sync(a,[learn,put(s,'dependent'),put(s,'with-provenance')]);
  await sync(b,[{...learn,id:'correct-coffee',expectedRevision:1,origin:'user',value:'INVENTED independent coffee',sources:[]},{...put(s,'with-provenance'),id:'correct-with-provenance',expectedRevision:1,origin:'user',value:'INVENTED coffee with provenance'}]);
  const before=await page(b);
  // First response is deliberately discarded: a lost-ACK retry must be exact.
  await forget(a,op);const after=await page(b,before.cursor);
  const corrected=(await page(b)).entries.find(e=>e.key==='drink')!;assert.equal(corrected.value,'INVENTED independent coffee');assert.equal(corrected.origin,'user');assert.equal(corrected.revision,2);
  assert.equal(after.entries.find(e=>e.key==='dependent')!.deleted,true);assert.equal(after.entries.find(e=>e.key==='dependent')!.revision,2);
  const repaired=after.entries.find(e=>e.key==='with-provenance')!;assert.equal(repaired.value,'INVENTED coffee with provenance');assert.equal(repaired.origin,'user');assert.deepEqual(repaired.sources,[]);assert.equal(repaired.revision,3);assert.ok(repaired.seq>before.cursor);
  assert.deepEqual(await forget(a,op),{acknowledged:[op.id]});assert.deepEqual(await page(b,before.cursor),after);
  await forget(a,{...op,id:'second-invalidation'});assert.deepEqual(await page(b,before.cursor),after);
  await assert.rejects(forget(a,{...op,sourceId:'payload-drift'}),/409/);
  assert.deepEqual((await sync(a,[learn])).entries,[corrected]);
  await assert.rejects(sync(a,[{...learn,id:'late-new-key',key:'new-key'}]),/409/);
  // A forgotten key's prior tombstone ACK must not become a later user recreation.
  const oldForget={id:'key-forget',workspaceId:'workspace',key:'dependent',expectedRevision:2,action:'forget' as const};
  const deleted=await sync(a,[oldForget]);await sync(a,[{...put(s,'dependent'),id:'recreate',expectedRevision:3,origin:'user',sources:[],value:'Explicit recreation'}]);
  assert.deepEqual(await sync(a,[oldForget]),deleted);
  const memory=(await store.transaction(s=>s,false)).accounts[0]!.memory;
  assert.equal(JSON.stringify(memory).includes('INVENTED inferred tea fact'),false);assert.equal(JSON.stringify(memory).includes(s.excerpt),false);
  assert.deepEqual(memory.sourceFences,[createHash('sha256').update(JSON.stringify(['workspace','conversation',s.sourceId])).digest('hex')]);
  assert.equal(memory.sourceOperationReceipts?.length,2);assert.ok(memory.sourceOperationReceipts?.every(r=>Object.keys(r).sort().join(',')==='digest,id'));
  assert.ok((await store.transaction(s=>s,false)).accounts.every(a=>a.devices.length===0));assert.equal((await readFile(join(directory,'tracking.enc'))).includes(Buffer.from('INVENTED')),false);
  const complete=await page(b);await server.close();server=await startTrackingServer(directory,key);
  const restarted=new AccountClient(server.origin);await restarted.signin('invented-source-forget','invented-password-123');
  assert.deepEqual(await page(restarted),complete);assert.deepEqual(await forget(restarted,op),{acknowledged:[op.id]});assert.deepEqual(await page(restarted),complete);
  await assert.rejects(sync(restarted,[{...learn,id:'restart-late',key:'restart-new'}]),/409/);assert.deepEqual((await sync(restarted,[learn])).entries,[corrected]);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('source forget without a current key, activity identity and workspace/account isolation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-empty-')),key=randomBytes(32),server=await startTrackingServer(directory,key);
 try{
  const a=new AccountClient(server.origin),identity=await a.signin('invented-source-empty','invented-password-123',true),s=source(identity.id),op=operation(s);
  assert.deepEqual(await forget(a,op),{acknowledged:[op.id]});assert.deepEqual(await page(a),{entries:[],cursor:0,hasMore:false});await assert.rejects(sync(a,[put(s)]),/409/);
  await sync(a,[put({...s,workspaceId:'other-workspace'})]);
  const foreign=new AccountClient(server.origin),other=await foreign.signin('invented-source-foreign','invented-password-123',true);await sync(foreign,[put({...s,accountId:other.id})]);
  const activity={...s,kind:'activity' as const,sourceId:'client-local-name',activityKey:'device/recording/visit',activityRevision:0};
  // Independent user provenance does not require a live collector row.
  await sync(a,[{...put(activity,'activity-user'),origin:'user',value:'Independent activity correction'}]);
  await forget(a,operation({...activity,sourceId:'different-local-name'},'activity-forget'));
  const repaired=(await page(a)).entries[0]!;assert.equal(repaired.value,'Independent activity correction');assert.deepEqual(repaired.sources,[]);assert.equal(repaired.revision,2);
  // Check the exact existing identity hash, not a new sourceId namespace.
  const memory=(await new EncryptedStore<Stored>(directory,key,()=>({accounts:[]})).transaction(s=>s,false)).accounts[0]!.memory;
  assert.ok(memory.sourceFences?.includes(createHash('sha256').update(JSON.stringify(['workspace','activity',activity.activityKey])).digest('hex')));
  // Fenced provenance cannot be restored even by a new explicit correction; its value survives.
  await sync(a,[{...put(activity,'activity-user'),id:'new-correction',expectedRevision:2,origin:'user',value:'New independent correction'}]);
  assert.deepEqual((await page(a)).entries[0]!.sources,[]);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('activity forget fences the existing history identity despite changed local source IDs and preserves unrelated activity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-activity-')),key=randomBytes(32),server=await startTrackingServer(directory,key);
 try{
  const producer=new AccountClient(server.origin),identity=await producer.signin('invented-source-activity','invented-password-123',true),device=await producer.request('/devices',{name:'invented producer'}) as {deviceId:string};
  const now=Date.now(),record={schema:'spindle-tracking/v1',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+60000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'Prefers tea',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+60000}};
  const upload={id:'upload',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',record};await producer.request('/sync',{operations:[upload]});
  const peer=new AccountClient(server.origin);await peer.signin('invented-source-activity','invented-password-123');
  const s:UserMemorySource={...source(identity.id),kind:'activity',sourceId:'producer-local-id',activityKey:`${device.deviceId}/recording/visit`,activityRevision:1,sha256:createHash('sha256').update('Invented\nPrefers tea').digest('hex'),excerpt:'Prefers tea'};
  const learn=put(s);await sync(peer,[learn]);
  await forget(peer,operation({...s,sourceId:'peer-local-id'}));assert.equal((await page(peer)).entries[0]!.deleted,true);
  await assert.rejects(sync(peer,[{...learn,id:'new-alias',key:'new-alias',sources:[{...s,id:'alias',sourceId:'another-local-id'}]}]),/409/);
  // A newer history revision and a different sourceId cannot evade a source fence.
  record.revision=2;await producer.request('/sync',{operations:[{...upload,id:'history-update'}]});
  await assert.rejects(sync(peer,[{...learn,id:'new-revision',key:'new-revision',sources:[{...s,activityRevision:2}]}]),/409/);
  record.visitId='independent';record.visit.id='independent';await producer.request('/sync',{operations:[{...upload,id:'other-history',visitId:'independent'}]});
  await sync(peer,[{...learn,id:'independent',key:'independent',sources:[{...s,activityKey:`${device.deviceId}/recording/independent`,activityRevision:2}]}]);
  const memory=(await new EncryptedStore<Stored>(directory,key,()=>({accounts:[]})).transaction(s=>s,false)).accounts[0]!.memory;assert.ok(memory.operationReceipts.filter(r=>r.entry.key==='drink').every(r=>r.entry.deleted));
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('source endpoint reuses strict Host/Origin/session/CSRF and direct bounded body validation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-guards-')),server=await startTrackingServer(directory,randomBytes(32));
 try{
  const auth=await fetch(server.origin+'/register',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-source-guards',password:'invented-password-123'})});
  const cookie=auth.headers.get('set-cookie')!.split(';')[0]!,{csrf}=await auth.json() as {csrf:string};
  const op={id:'forget',workspaceId:'workspace',kind:'conversation',sourceId:'conversation'},headers={Origin:server.origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
  const post=(body:unknown,overrides:Record<string,string>={},path='/user-memory/forget-source')=>fetch(server.origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
  assert.equal((await post(op,{Cookie:''})).status,401);assert.equal((await post(op,{'X-CSRF-Token':''})).status,403);assert.equal((await post(op,{Origin:'https://denied.invalid'})).status,403);
  const wrongHost=await new Promise<number>((resolve,reject)=>{const req=httpRequest(server.origin+'/user-memory/forget-source',{method:'POST',headers:{...headers,Host:'denied.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(JSON.stringify(op));});assert.equal(wrongHost,403);
  for(const bad of [{operations:[op]},{...op,accountId:'chosen-account'},{...op,excerpt:'raw'},{...op,value:'raw'},{...op,body:'raw'},{...op,activityKey:'a/b/c'},{...op,kind:'activity'},{...op,kind:'activity',activityKey:'bad'},{...op,id:''},{...op,workspaceId:'x'.repeat(257)}])assert.equal((await post(bad)).status,400);
  assert.equal((await post(op,{},'/user-memory/forget-source?extra=1')).status,400);assert.equal((await post({...op,padding:'x'.repeat(512000)})).status,413);
  assert.deepEqual(await (await post(op)).json(),{acknowledged:[op.id]});
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('source receipt/fence/sequence capacity failures roll back encrypted reconciliation and never evict fences',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-capacity-')),key=randomBytes(32);let server=await startTrackingServer(directory,key);
 const store=new EncryptedStore<Stored>(directory,key,()=>({accounts:[]}));
 try{
  const a=new AccountClient(server.origin),identity=await a.signin('invented-source-capacity','invented-password-123',true),s=source(identity.id),op=operation(s);await sync(a,[put(s)]);await server.close();
  const base=await store.transaction(s=>s,false);
  for(const bound of ['receipt','fence','sequence']){
   await store.transaction(state=>{Object.assign(state,structuredClone(base));const m=state.accounts[0]!.memory;if(bound==='receipt')m.sourceOperationReceipts=Array.from({length:10000},(_,i)=>({id:`receipt-${i}`,digest:'a'.repeat(64)}));if(bound==='fence')m.sourceFences=Array.from({length:10000},(_,i)=>String(i));if(bound==='sequence')m.sequence=Number.MAX_SAFE_INTEGER;});
   const before=await store.transaction(s=>s.accounts[0]!.memory,false);server=await startTrackingServer(directory,key);const c=new AccountClient(server.origin);await c.signin('invented-source-capacity','invented-password-123');
   await assert.rejects(forget(c,op),/507/);assert.deepEqual(await store.transaction(s=>s.accounts[0]!.memory,false),before);await server.close();
  }
  // Restore a valid server so the single finally owns an open handle.
  await store.transaction(state=>Object.assign(state,base));server=await startTrackingServer(directory,key);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('expiry strips only expired/fenced user provenance and scrubs superseded receipts on memory-only read',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-source-expiry-')),key=randomBytes(32);let server=await startTrackingServer(directory,key);
 const store=new EncryptedStore<Stored>(directory,key,()=>({accounts:[]}));
 try{
  const a=new AccountClient(server.origin),identity=await a.signin('invented-source-expiry','invented-password-123',true),s=source(identity.id),learn=put(s);
  await sync(a,[learn]);await sync(a,[{...learn,id:'correction',expectedRevision:1,origin:'user',value:'Independent coffee',sources:[s,{...s,id:'unknown',kind:'activity',sourceId:'unknown',excerpt:'Independent unrelated source',activityKey:'unknown/recording/visit',activityRevision:0}]}]);
  await server.close();await store.transaction(state=>{for(const e of [...state.accounts[0]!.memory.entries,...state.accounts[0]!.memory.operationReceipts.map(r=>r.entry)])for(const src of e.sources??[])if(src.kind==='conversation'){src.observedAt=new Date(Date.now()-60000).toISOString();src.expiresAt=new Date(Date.now()-1000).toISOString();}});
  server=await startTrackingServer(directory,key);const peer=new AccountClient(server.origin);await peer.signin('invented-source-expiry','invented-password-123');
  const repaired=(await page(peer,2)).entries[0]!;assert.equal(repaired.revision,3);assert.equal(repaired.value,'Independent coffee');assert.deepEqual(repaired.sources?.map(s=>s.id),['unknown']);
  const memory=await store.transaction(s=>s.accounts[0]!.memory,false);assert.equal(JSON.stringify(memory).includes('INVENTED original tea excerpt'),false);assert.equal(JSON.stringify(memory).includes(learn.value!),false);
  assert.deepEqual((await sync(peer,[learn])).entries,[repaired]);await assert.rejects(sync(peer,[{...learn,id:'late-expired-new',key:'new-key'}]),/409/);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
