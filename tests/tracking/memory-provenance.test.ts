import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {isUserMemorySource,type UserMemoryMutation,type UserMemoryAck,type UserMemoryPage} from '../../core/memory/user-protocol.js';

test('accepted 513/8192 character keys progress through bounded HTTP pages and tombstones',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-wire-')),server=await startTrackingServer(directory,randomBytes(32));
 try{
  const a=new AccountClient(server.origin),b=new AccountClient(server.origin);await a.signin('invented-bounds','invented-password-123',true);await b.signin('invented-bounds','invented-password-123');
  const keys=['x'.repeat(513),'y'.repeat(8192)];
  const operations:UserMemoryMutation[]=keys.map((key,i)=>({id:`put-${i}`,workspaceId:'workspace',key,expectedRevision:0,action:'put',kind:'fact',value:'invented',origin:'user'}));
  await a.request('/user-memory/sync',{operations});let cursor=0;
  for(const key of keys){const page=await b.request(`/user-memory/changes?workspaceId=workspace&cursor=${cursor}&limit=1`) as UserMemoryPage;assert.equal(page.entries[0]!.key,key);assert.ok(page.cursor>cursor);cursor=page.cursor;}
  await a.request('/user-memory/sync',{operations:keys.map((key,i)=>({id:`forget-${i}`,workspaceId:'workspace',key,expectedRevision:1,action:'forget'}))});
  const page=await b.request(`/user-memory/changes?workspaceId=workspace&cursor=${cursor}`) as UserMemoryPage;assert.deepEqual(page.entries.map(e=>e.key),keys);assert.ok(page.entries.every(e=>e.deleted));
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('user corrections accept structurally valid independent provenance and reject incompatible source shapes over HTTP',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-user-source-')),server=await startTrackingServer(directory,randomBytes(32));
 try{
  const c=new AccountClient(server.origin),identity=await c.signin('invented-user-source','invented-password-123',true);
  const source={id:'source',kind:'activity' as const,sourceId:'source',workspaceId:'workspace',accountId:identity.id,sha256:'a'.repeat(64),excerpt:'Invented',observedAt:new Date().toISOString(),activityKey:'device/recording/visit',activityRevision:0};
  const put:UserMemoryMutation={id:'valid',workspaceId:'workspace',key:'correction',expectedRevision:0,action:'put',kind:'fact',value:'Independent correction',origin:'user',sources:[source]};
  for(const [i,patch] of [{activityKey:'not-a-history-key'},{activityKey:'a/b/c/d'},{activityKey:`${'a'.repeat(129)}/b/c`},{activityRevision:'0'},{kind:'conversation'}].entries())await assert.rejects(c.request('/user-memory/sync',{operations:[{...put,id:`invalid-${i}`,sources:[{...source,...patch}]}]}),/400/);
  await c.request('/user-memory/sync',{operations:[put]});
  const peer=new AccountClient(server.origin);await peer.signin('invented-user-source','invented-password-123');
  const page=await peer.request('/user-memory/changes?workspaceId=workspace&cursor=0') as UserMemoryPage;
  assert.equal(page.entries.length,1);assert.equal(page.entries[0]!.value,put.value);assert.equal(page.entries[0]!.origin,'user');
  assert.ok(page.entries[0]!.sources!.every(s=>isUserMemorySource(s,'workspace',identity.id)));assert.ok(page.cursor>0);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test('activity provenance binds account history revision/hash/quote and invalidates on actual revision replacement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'memory-provenance-')),server=await startTrackingServer(directory,randomBytes(32));
 try{
  const c=new AccountClient(server.origin),identity=await c.signin('invented-provenance','invented-password-123',true),device=await c.request('/devices',{name:'invented producer'}) as {deviceId:string};
  const now=Date.now(),r={schema:'spindle-tracking/v1',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+60000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'Prefers tea',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+60000}};
  const history={id:'upload',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',record:r};await c.request('/sync',{operations:[history]});
  const source={id:'source',kind:'activity' as const,sourceId:'source',workspaceId:'not-account-uuid',accountId:identity.id,sha256:createHash('sha256').update('Invented\nPrefers tea').digest('hex'),excerpt:'Prefers tea',observedAt:new Date(now).toISOString(),activityKey:`${device.deviceId}/recording/visit`,activityRevision:1};
  const put:UserMemoryMutation={id:'put',workspaceId:source.workspaceId,key:'drink',expectedRevision:0,action:'put',kind:'preference',origin:'inferred',value:'Prefers tea',sources:[source]};
  for(const [i,patch] of [{activityKey:undefined},{activityRevision:undefined},{activityRevision:'1'},{activityKey:'other/recording/visit'},{activityRevision:2},{sha256:'b'.repeat(64)},{excerpt:'Not in source'}].entries())await assert.rejects(c.request('/user-memory/sync',{operations:[{...put,id:`invalid-${i}`,sources:[{...source,...patch}]}]}),/400|409/);
  await c.request('/user-memory/sync',{operations:[put]});r.revision=2;r.visit.text='Prefers coffee';await c.request('/sync',{operations:[{...history,id:'changed'}]});
  const page=await c.request('/user-memory/changes?workspaceId=not-account-uuid&cursor=0') as UserMemoryPage;assert.equal(page.entries[0]!.deleted,true);assert.equal(page.entries[0]!.revision,2);assert.equal(page.entries[0]!.deletionReason,'source_invalidated');
  assert.deepEqual((await c.request('/user-memory/sync',{operations:[put]}) as UserMemoryAck).entries,page.entries);
  await assert.rejects(c.request('/user-memory/sync',{operations:[{...put,id:'late-stale',key:'new-key'}]}),/409/);
  const fresh={...source,activityRevision:2,sha256:createHash('sha256').update('Invented\nPrefers coffee').digest('hex'),excerpt:'Prefers coffee'};
  await c.request('/user-memory/sync',{operations:[{...put,id:'fresh',key:'fresh',sources:[fresh],value:'Prefers coffee'}]});
  await assert.rejects(c.request('/user-memory/sync',{operations:[{...put,id:'stale-cas',sources:[fresh]}]}),/409/);
  const recreated=await c.request('/user-memory/sync',{operations:[{...put,id:'same-key-fresh',expectedRevision:2,sources:[fresh],value:'Prefers coffee'}]}) as UserMemoryAck;
  assert.equal(recreated.entries[0]!.revision,3);assert.equal(recreated.entries[0]!.value,'Prefers coffee');assert.equal(recreated.entries[0]!.deletionReason,undefined);
  assert.deepEqual((await c.request('/user-memory/sync',{operations:[put]}) as UserMemoryAck).entries,page.entries);
  for(const query of ['limit=17','limit=0','cursor=999','cursor=-1','cursor=0&cursor=0','extra=1'])await assert.rejects(c.request('/user-memory/activity?'+query),/400/);
  const foreign=new AccountClient(server.origin);await foreign.signin('invented-no-history','invented-password-123',true);assert.deepEqual((await foreign.request('/user-memory/activity') as {entries:unknown[]}).entries,[]);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
