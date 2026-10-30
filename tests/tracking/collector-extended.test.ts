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
// Invented source messages, real account/HTTP/disk. Not native acceptance.
test('connected extended collector survives the 100-visit preview ring without resetting identities or losing history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collector-extended-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 try{
  const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));await client.signin('extended-owner','invented-password-123','Invented Mac',true);
  const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:false,rich:false,retain:true});await sink.settle();
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:0,coverage:'observed'});await sink.settle();
  for(let i=1;i<=110;i++){
   session.focus({epoch:session.epoch,revision:i,at:i*100,key:`invented/${i}`,app:'Editor',title:`Invented ${i}`,clock:'native-boot'});await sink.settle();
   await client.sync();
  }
  session.pause(11100);await sink.settle();await sink.dispose();await client.sync();
  assert.equal(session.visits.length,100);
  const report=await client.sessions(Date.now()-60000,Date.now()+60000);
  assert.equal(report.visits.length,110);assert.equal(report.personTime,11000);assert.equal(new Set(report.visits.map(v=>v.recordingId)).size,1);
  assert.equal(report.visits[0]!.context.title,'Invented 1');
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
