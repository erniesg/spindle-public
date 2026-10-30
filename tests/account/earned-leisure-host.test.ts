import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';

test('authenticated observed study earns once, survives restart and redeems idempotently',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'earned-account-')),key=randomBytes(32),originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin;
 try{
  const collector=new TrackingClient(origin,join(dir,'collector'),randomBytes(32));await collector.signin('invented-study','invented-password-123','Invented Mac',true);
  const reader=new AccountClient(origin);await reader.signin('invented-study','invented-password-123');
  await reader.request('/processing',{local:true});await reader.request('/earned-leisure/opt-in',{enabled:true});
  const deviceId=(await collector.inspect()).deviceId,visitId=randomUUID(),start=now;
  const op:Operation={id:randomUUID(),deviceId,recordingId:'invented-study',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-study',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:start,monotonicAnchor:0,observedAt:45000,expiresAt:start+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:45000,coverage:'observed'},visit:{id:visitId,key:'invented-editor',app:'invented-editor',title:'Invented study',start:0,end:45000,clock:'owned-clock',revision:1,browser:false,text:'Reading an invented explanation of fractions.',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:start+3600000}}};
  now+=45000;await collector.enqueue(op);await collector.sync();const keyId=recordKey(op);
  await reader.request('/corrections',{key:keyId,evidenceRevision:1,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}});
  type Balance={balance:{earnedSeconds:number;spentSeconds:number;availableSeconds:number};lease?:{requestId:string}};
  let value=await reader.request('/earned-leisure/read',{}) as Balance;assert.equal(value.balance.earnedSeconds,45);
  const request={requestId:randomUUID(),deviceId,host:'leisure.invalid',policyVersion:1,seconds:30};
  value=await reader.request('/earned-leisure/redeem',request) as Balance;assert.equal(value.balance.spentSeconds,30);assert.equal(value.balance.availableSeconds,15);
  const repeated=await reader.request('/earned-leisure/redeem',request) as Balance;assert.equal(repeated.balance.spentSeconds,30);assert.equal(repeated.lease!.requestId,request.requestId);
  await assert.rejects(reader.request('/earned-leisure/redeem',{...request,deviceId:'foreign'}),/403/);
  await assert.rejects(reader.request('/earned-leisure/redeem',{...request,seconds:31}),/409/);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  const restarted=new AccountClient(origin);await restarted.signin('invented-study','invented-password-123');
  value=await restarted.request('/earned-leisure/read',{}) as Balance;assert.equal(value.balance.availableSeconds,15);
  const other=new AccountClient(origin);await other.signin('invented-other-study','invented-password-123',true);
  const empty=await other.request('/earned-leisure/read',{}) as Balance;assert.equal(empty.balance.earnedSeconds,0);
  await assert.rejects(other.request('/earned-leisure/status',{requestId:request.requestId}),/404/);
  assert.equal((await fetch(origin+'/earned-leisure/read',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(origin+'/earned-leisure/read',{method:'POST',headers:{Origin:'https://wrong.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{Date.now=originalNow;await server.close();await rm(dir,{recursive:true,force:true});}
});
