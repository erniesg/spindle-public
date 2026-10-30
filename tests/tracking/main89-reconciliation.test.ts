import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';

test('combined memory, timer and collector server preserves UUID, viewer privileges, filtered history and encrypted restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tracking-memory-reconciliation-')),key=randomBytes(32);let server=await startTrackingServer(directory,key);
 try{
  const producer=new AccountClient(server.origin),identity=await producer.signin('invented-combined','invented-password-123',true);
  const viewer=new AccountClient(server.origin);assert.deepEqual(await viewer.signin('invented-combined','invented-password-123'),identity);
  assert.match(identity.id,/^[a-f0-9-]{36}$/);
  assert.equal((await viewer.request('/session') as {deviceId:null}).deviceId,null);
  const device=await producer.request('/devices',{name:'invented collector'}) as {deviceId:string};
  assert.equal((await producer.request('/session') as {deviceId:string}).deviceId,device.deviceId);
  await viewer.request('/user-memory/sync',{operations:[{id:'preference-put',workspaceId:'workspace',key:'style',expectedRevision:0,action:'put',kind:'preference',value:'Invented concise answers',origin:'user'}]});
  assert.deepEqual(await viewer.request('/processing',{local:true}),{local:true});
  const timer=await viewer.request('/pomodoro/command',{id:'combined-start',expectedRevision:0,action:'start',durations:{focusMs:60000,breakMs:30000}}) as Snapshot&{accountId:string};
  assert.equal(timer.accountId,identity.id);assert.equal(timer.timer.status,'running');assert.equal(timer.timer.revision,1);
  const now=Date.now(),record={schema:'spindle-tracking/v1',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+60000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'Invented context',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+60000}};
  const upload={id:'upload',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',record};
  await assert.rejects(viewer.request('/sync',{operations:[upload]}),/403/);
  await producer.request('/sync',{operations:[upload]});
  const history=await viewer.request('/history?deviceId='+device.deviceId) as {entries:{key:string;deleted:boolean}[]};assert.equal(history.entries.length,1);
  const devices=await viewer.request('/devices') as {devices:{lastUploadAt:number}[]};assert.ok(devices.devices[0]!.lastUploadAt>=now);
  await viewer.request(`/sessions?from=${now}&to=${now+1000}&deviceId=${device.deviceId}`);
  await assert.rejects(viewer.request('/history?deviceId=not-enrolled'),/404/);
  await assert.rejects(viewer.request('/session?unexpected=true'),/400/);
  const foreign=new AccountClient(server.origin);await foreign.signin('invented-foreign','invented-password-123',true);
  assert.deepEqual((await foreign.request('/history') as {entries:unknown[]}).entries,[]);
  assert.equal((await foreign.request('/pomodoro') as Snapshot).timer.revision,0);
  const afterHistory=await viewer.request('/pomodoro/read',{}) as Snapshot;assert.equal(afterHistory.timer.deadlineAt,timer.timer.deadlineAt);
  assert.deepEqual((await foreign.request('/user-memory/changes?workspaceId=workspace') as {entries:unknown[]}).entries,[]);
  await viewer.request('/sync',{operations:[{id:'viewer-delete',deviceId:device.deviceId,recordingId:'recording',visitId:'visit',delete:true}]});
  assert.equal((await viewer.request('/history') as {entries:{deleted:boolean}[]}).entries[0]!.deleted,true);
  await server.close();server=await startTrackingServer(directory,key);
  const reopened=new AccountClient(server.origin);assert.deepEqual(await reopened.signin('invented-combined','invented-password-123'),identity);
  assert.equal((await reopened.request('/session') as {deviceId:null}).deviceId,null);
  const resumed=await reopened.request('/pomodoro') as Snapshot;assert.equal(resumed.timer.revision,1);assert.equal(resumed.timer.deadlineAt,timer.timer.deadlineAt);
  assert.equal((await reopened.request('/user-memory/changes?workspaceId=workspace') as {entries:{value:string}[]}).entries[0]!.value,'Invented concise answers');
  assert.equal((await reopened.request('/history') as {entries:{deleted:boolean}[]}).entries[0]!.deleted,true);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
