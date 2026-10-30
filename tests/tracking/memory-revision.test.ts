import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {syncUserMemory,type UserMemoryState} from '../../core/tracking/user-memory.js';
import type {UserMemorySource,UserMemoryMutation,UserMemoryAck,UserMemoryPage} from '../../core/memory/user-protocol.js';

for(const mode of ['key','source'] as const)test(`automatic revision tombstones become permanent on explicit ${mode} forget`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-revision-')),key=randomBytes(32);let server=await startTrackingServer(directory,key);
 try{
  const a=new AccountClient(server.origin),identity=await a.signin(`invented-revision-${mode}`,'invented-password-123',true),device=await a.request('/devices',{name:'invented producer'}) as {deviceId:string};
  const b=new AccountClient(server.origin);await b.signin(`invented-revision-${mode}`,'invented-password-123');
  const sync=(operations:unknown[])=>a.request('/user-memory/sync',{operations}) as Promise<UserMemoryAck>;
  const page=(cursor=0)=>b.request(`/user-memory/changes?workspaceId=workspace&cursor=${cursor}`) as Promise<UserMemoryPage>;
  const now=Date.now(),record={schema:'spindle-tracking/v1',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'Prefers tea',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+600000}};
  const upload=()=>a.request('/sync',{operations:[{id:`history-${record.revision}`,deviceId:device.deviceId,recordingId:'recording',visitId:'visit',record}]});await upload();
  const source=():UserMemorySource=>({id:'snapshot',kind:'activity',sourceId:'snapshot',workspaceId:'workspace',accountId:identity.id,activityKey:`${device.deviceId}/recording/visit`,activityRevision:record.revision,sha256:createHash('sha256').update(`Invented\n${record.visit.text}`).digest('hex'),excerpt:record.visit.text,observedAt:new Date(now).toISOString()});
  const oldSource=source();
  const put=(id:string,key='drink',expectedRevision=0,s=source()):UserMemoryMutation=>({id,workspaceId:'workspace',key,expectedRevision,action:'put',kind:'preference',origin:'inferred',value:s.excerpt,sources:[s]});
  const original=put('original');await sync([original,put('dependent','dependent'),put('corrected','corrected')]);
  await sync([{...put('correction','corrected',1),origin:'user',value:'Independent cocoa'}]);
  const before=await page();
  record.revision=2;record.visit.revision=2;record.visit.text='Prefers coffee';await upload();
  // Memory-only peer has no learner/provider; history replacement alone publishes deletion.
  const changed=await page(before.cursor),automatic=changed.entries.find(e=>e.key==='drink')!;
  assert.equal(automatic.deletionReason,'source_invalidated');assert.equal(automatic.revision,2);assert.equal(automatic.value,undefined);assert.equal(automatic.sources,undefined);
  assert.equal((await page()).entries.find(e=>e.key==='corrected')!.value,'Independent cocoa');
  await assert.rejects(sync([put('old-source','drink',2,oldSource)]),/409/);
  await assert.rejects(sync([put('stale-cas','drink',1)]),/409/);
  await assert.rejects(sync([{...put('caller-reason'),deletionReason:'source_invalidated'}]),/400/);
  const recreate=put('recreate','drink',2),ack=await sync([recreate]);assert.equal(ack.entries[0]!.revision,3);assert.equal(ack.entries[0]!.value,'Prefers coffee');assert.equal(ack.entries[0]!.deletionReason,undefined);
  assert.deepEqual(await sync([recreate]),ack); // discarded/lost ACK replay
  assert.deepEqual((await sync([original])).entries,[automatic]); // old tombstone ACK cannot become recreation
  await sync([put('different-key','fresh')]);
  record.revision=3;record.visit.revision=3;record.visit.text='Prefers water';await upload();
  const preForget=await page(),target=preForget.entries.find(e=>e.key==='drink')!;assert.equal(target.deletionReason,'source_invalidated');
  const forgetKey={id:'explicit-key',workspaceId:'workspace',key:'drink',expectedRevision:target.revision,action:'forget'};
  const forgetSource={id:'explicit-source',workspaceId:'workspace',kind:'activity',sourceId:'peer-alias',activityKey:oldSource.activityKey};
  let keyAck:UserMemoryAck|undefined;
  if(mode==='key')keyAck=await sync([forgetKey]);else await a.request('/user-memory/forget-source',forgetSource);
  const permanent=await page(preForget.cursor);assert.equal(permanent.entries.length,4);
  assert.ok(permanent.entries.filter(e=>e.key!=='corrected').every(e=>e.deleted&&e.deletionReason===undefined));
  const correction=permanent.entries.find(e=>e.key==='corrected')!;assert.equal(correction.value,'Independent cocoa');assert.equal(correction.origin,'user');assert.deepEqual(correction.sources,[]);
  assert.ok(permanent.entries.every(e=>e.revision===preForget.entries.find(p=>p.key===e.key)!.revision+1));
  if(mode==='key')assert.deepEqual(await sync([forgetKey]),keyAck);else assert.deepEqual(await a.request('/user-memory/forget-source',forgetSource),{acknowledged:['explicit-source']});
  assert.deepEqual(await page(preForget.cursor),permanent);
  const tombstone=permanent.entries.find(e=>e.key==='drink')!;
  // Even an unrelated fresh valid source cannot revive the now permanently forgotten key.
  const conversation:UserMemorySource={id:'new',kind:'conversation',sourceId:'unrelated',workspaceId:'workspace',accountId:identity.id,sha256:'a'.repeat(64),excerpt:'New source',observedAt:new Date(now).toISOString()};
  await assert.rejects(sync([put('permanent-recreate','drink',tombstone.revision,conversation)]),/409/);
  record.revision=4;record.visit.revision=4;await upload();
  await assert.rejects(sync([put('new-history-new-key','new-key')]),/409/);
  await sync([{...put('explicit-recreate','drink',tombstone.revision),origin:'user',sources:[],value:'Independent recreation'}]);
  if(mode==='key')assert.deepEqual(await sync([forgetKey]),keyAck);
  const memory=await new EncryptedStore<{accounts:{memory:UserMemoryState}[]}>(directory,key,()=>({accounts:[]})).transaction(s=>s.accounts[0]!.memory,false);
  assert.equal(memory.invalidatedSources?.length,0);assert.equal(JSON.stringify(memory).includes('Prefers tea'),false);assert.equal(JSON.stringify(memory).includes('Prefers coffee'),false);
  assert.ok(memory.operationReceipts.filter(r=>['original','recreate'].includes(r.id)).every(r=>r.entry.deleted&&r.entry.deletionReason===undefined));
  const final=await page();await server.close();server=await startTrackingServer(directory,key);const restarted=new AccountClient(server.origin);await restarted.signin(`invented-revision-${mode}`,'invented-password-123');assert.deepEqual(await restarted.request('/user-memory/changes?workspaceId=workspace&cursor=0'),final);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('legacy tombstone without reason remains permanent, never guessed from history',()=>{
 const state:UserMemoryState={entries:[{workspaceId:'w',key:'k',deleted:true,revision:1,seq:1,updatedAt:new Date().toISOString()}],sequence:1,operationReceipts:[]};
 const source:UserMemorySource={id:'s',kind:'conversation',sourceId:'fresh',workspaceId:'w',accountId:'account',sha256:'a'.repeat(64),excerpt:'Fresh',observedAt:new Date().toISOString()};
 assert.throws(()=>syncUserMemory(state,'account',{operations:[{id:'new',workspaceId:'w',key:'k',expectedRevision:1,action:'put',kind:'fact',value:'Fresh',origin:'inferred',sources:[source]}]}),/MEMORY_FORGOTTEN/);
 assert.equal(state.sequence,1);assert.equal(state.entries[0]!.deletionReason,undefined);
});
