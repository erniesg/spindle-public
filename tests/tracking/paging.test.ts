import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes,randomUUID } from 'node:crypto';
import { startTrackingServer } from '../../core/tracking/server.js';
import { TrackingClient } from '../../core/tracking/client.js';
import type { Operation } from '../../core/tracking/types.js';
test('bounded cursor pages persist delete-before-put fences and independent clients resume',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-paging-')),serverKey=randomBytes(32),server=await startTrackingServer(join(dir,'server'),serverKey);
 try{
  await assert.rejects(startTrackingServer(join(dir,'server'),serverKey),/EEXIST/);
  assert.throws(()=>new TrackingClient('http://example.invalid',join(dir,'unsafe'),randomBytes(32)),/TLS_REQUIRED/);
  const a=new TrackingClient(server.origin,join(dir,'a'),randomBytes(32)),bKey=randomBytes(32);
  let b=new TrackingClient(server.origin,join(dir,'b'),bKey);
  await a.signin('sample','invented-password-123','Mac',true);await b.signin('sample','invented-password-123','Windows');
  const deviceId=(await a.inspect()).deviceId;
  // These are invented tombstones, not injected capture or authentication.
  for(let n=0;n<17;n++)await a.enqueue({id:randomUUID(),deviceId,recordingId:'sample-recording',visitId:`visit-${n}`,delete:true});
  assert.equal((await a.sync()).pending,1);await a.sync();
  assert.equal((await b.sync()).hasMore,true);assert.equal((await b.inspect()).entries.length,16);
  b=new TrackingClient(server.origin,join(dir,'b'),bKey);await b.sync();assert.equal((await b.inspect()).entries.length,17);
  const now=Date.now(),op:Operation={id:randomUUID(),deviceId,recordingId:'sample-recording',visitId:'visit-0',record:{schema:'spindle-tracking/v1',deviceId,recordingId:'sample-recording',visitId:'visit-0',revision:999,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:0,expiresAt:now+60000,scopes:{recording:true,retention:true,upload:true,pixels:false},labelRevision:0,correctionRevision:0,activity:{awake:null,unlocked:null,inputAgeBucket:'unknown',heartbeatAt:0,coverage:'unknown'},visit:{id:'visit-0',key:'window',app:'sample',title:'invented',start:0,end:1,clock:'source-clock',revision:1,browser:false,text:'Must not resurrect',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:0,framePTS:null,expiresAt:now+60000}}};
  await a.enqueue(op);await a.sync();await b.sync();assert.equal((await b.inspect()).entries.find(e=>e.visitId==='visit-0')!.record,undefined);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
