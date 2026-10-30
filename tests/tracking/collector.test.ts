import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PreviewSession} from '../../core/preview/session.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';

// Production PreviewSession with invented native messages, NOT a native run.
test('collector mutations coalesce durably offline, sign-in alone records nothing, restart serves real account sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collector-')),key=randomBytes(32),serverKey=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),serverKey);
 const origin=server.origin;
 try{
  let client=new TrackingClient(origin,join(dir,'client'),key);
  await client.signin('collector-owner','invented-password-123','Invented Mac',true);
  const session=new PreviewSession();
  const sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  assert.equal(session.recording,false);assert.equal((await client.inspect()).pending,0);
  session.start({pixels:false,rich:false,retain:true});await sink.settle();
  session.focus({epoch:session.epoch,revision:1,at:100,key:'invented/editor',app:'Editor',title:'Invented',clock:'native-boot'});await sink.settle();
  for(let i=0;i<150;i++){
   session.sample({epoch:session.epoch,revision:1,at:101+i,text:`function invented${i}() {}`,textSource:'native',status:'native-text'});await sink.settle();
  }
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:1000,coverage:'observed'});await sink.settle();
  session.pause(1000);await sink.settle();await sink.dispose();
  assert.equal((await client.inspect()).pending,1);
  // Actual encrypted pending file survives loss of both live objects.
  client=new TrackingClient(origin,join(dir,'client'),key);
  await client.sync();let report=await client.sessions(Date.now()-60000,Date.now()+60000);
  assert.equal(report.visits.length,1);assert.equal(report.personTime,900);
  assert.equal(report.visits[0]!.context.text,'function invented149() {}');
  await server.close();server=await startTrackingServer(join(dir,'server'),serverKey,Number(new URL(origin).port));
  assert.equal((await client.sessions(Date.now()-60000,Date.now()+60000)).personTime,900);
  // A later recording never reassigns earlier visits to a new recording identity.
  const next=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:false,rich:false,retain:true});await next.settle();
  session.focus({epoch:session.epoch,revision:1,at:2000,key:'invented/document',app:'Document',title:'Invented',clock:'native-boot'});await next.settle();
  next.evidence({awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:2100,coverage:'observed'});await next.settle();
  session.pause(2100);await next.settle();await next.dispose();await client.sync();
  report=await client.sessions(Date.now()-60000,Date.now()+60000);assert.equal(report.visits.length,2);
  await client.processing(true);
  const first=report.visits[0]!;
  await client.correct(first.key,first.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  assert.equal((await client.sessions(Date.now()-60000,Date.now()+60000)).visits[0]!.label!.source,'override');
  await client.eraseDeviceHistory();await client.sync();
  assert.equal((await client.sessions(Date.now()-60000,Date.now()+60000)).visits.length,0);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('offline distinct-visit saturation pauses rather than evicting unsynced history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collector-bound-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 try{
  const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));await client.signin('bound-owner','invented-password-123','Invented Windows',true);
  const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,60000);
  session.start({pixels:false,rich:false,retain:true});await sink.settle();
  for(let i=1;i<=62;i++){session.focus({epoch:session.epoch,revision:i,at:i*100,key:`invented/${i}`,app:'Editor',title:'Invented',clock:'native-boot'});await sink.settle();}
  session.focus({epoch:session.epoch,revision:63,at:6300,key:'invented/63',app:'Editor',title:'Invented',clock:'native-boot'});
  await assert.rejects(sink.settle(),/HISTORY_PENDING_SYNC/);assert.equal(session.recording,false);assert.equal(session.visits.length,63);assert.equal((await client.inspect()).pending,63);
  await sink.dispose();
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
