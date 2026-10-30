import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {PreviewSession} from '../../core/preview/session.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';

// Invented provider messages through production capture, encrypted files and HTTP.
// PNG header fixture with bounded padding; not a captured screenshot/native proof.
async function syncAll(c:TrackingClient){for(let i=0;i<20;i++){const s=await c.sync();if(!s.pending&&!s.hasMore)return;}throw Error('sync bound');}
const image=()=>{const b=Buffer.alloc(1_800_000,17);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.write('IHDR',12);b.writeUInt32BE(1,16);b.writeUInt32BE(1,20);return b.toString('base64');};
test('browser unchanged context/image phases preserve correction; denied changed context cannot retain a frame',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-correction-')),sk=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),sk);const origin=server.origin;
 try{
  const client=new TrackingClient(origin,join(dir,'client'),randomBytes(32));await client.signin('browser-owner','invented-password-123','Invented',true);
  const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:true,rich:true,retain:true});session.focus({epoch:session.epoch,revision:1,at:100,key:'chrome',app:'Chrome',title:'',clock:'native',browser:true});
  const context=(text='Invented reading')=>({challenge:session.challenge(),private:false,focused:true,document:'doc',url:'https://example.test/read',title:'Invented',text});
  const frame=(bytes=image())=>({...context(),automatic:true,image:bytes});
  const flush=async()=>{await sink.settle();await syncAll(client);};
  const report=()=>client.sessions(Date.now()-60000,Date.now()+60000);
  assert.ok(session.browser(context(),101));assert.ok(session.browserImage(frame(),101));sink.evidence({awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:200,coverage:'observed'});await flush();await client.processing(true);
  const first=(await report()).visits[0]!;await client.correct(first.key,first.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  for(let i=0;i<2;i++){
   assert.ok(session.browser(context(),102+i));await flush();
   assert.equal((await report()).visits[0]!.label?.source,'override','context phase preserves exact correction');
   assert.ok(session.browserImage(frame(),104+i));await flush();assert.equal((await report()).visits[0]!.label?.source,'override');
  }
  await server.close();server=await startTrackingServer(join(dir,'server'),sk,Number(new URL(origin).port));
  const other=new TrackingClient(origin,join(dir,'other'),randomBytes(32));await other.signin('browser-owner','invented-password-123','Other');
  assert.equal((await other.sessions(Date.now()-60000,Date.now()+60000)).visits[0]!.label?.source,'override');
  const different=Buffer.from(image(),'base64');different[40]=18;
  const oldTime=session.active!.sampledAt;
  assert.ok(session.browserImage(frame(different.toString('base64')),150));await flush();
  const stored=(await client.inspect()).entries[0]!.record!.visit;
  assert.equal(stored.sampledAt,oldTime,'text acquisition time is independent');
  assert.equal(stored.imageSampledAt,150,'changed pixels use native-derived receipt time');
  assert.ok(stored.imageExpiresAt!>=Date.now());
  assert.ok(session.browserImage(frame(different.toString('base64')),160));await flush();
  assert.equal((await client.inspect()).entries[0]!.record!.visit.imageSampledAt,150,'identical retained pixels keep their acquisition time');
  assert.notEqual((await report()).visits[0]!.label?.source,'override','new image invalidates correction');
  assert.ok(session.browser(context('Changed DOM'),110));assert.equal(session.browserImage({...frame(),focused:false},161),false);await flush();
  const v=(await client.inspect()).entries[0]!.record!.visit;assert.equal(v.text,'Changed DOM');assert.equal(v.image,'','denied acquisition must not reuse old image');assert.equal(v.imageAvailable,false);
  await sink.dispose();await server.close();server=await startTrackingServer(join(dir,'server'),sk,Number(new URL(origin).port));await syncAll(other);
  assert.equal((await other.inspect()).entries[0]!.record!.visit.image,'');
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('same-document content changes fence delayed frames and native partial refreshes cannot mix acquisitions',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});s.focus({epoch:s.epoch,revision:1,at:100,key:'chrome',app:'Chrome',title:'',clock:'native',browser:true});
 const c=()=>({challenge:s.challenge(),private:false,focused:true,document:'doc',url:'https://example.test',title:'A',text:'A'});
 s.browser(c(),101);const old={...c(),automatic:true,image:image()};s.browser({...c(),text:'B'},102);
 assert.equal(s.browserImage(old,103),false,'frame from prior DOM revision must be rejected');
 s.focus({epoch:s.epoch,revision:2,at:200,key:'editor',app:'Editor',title:'A',clock:'native'});
 s.sample({epoch:s.epoch,revision:2,at:201,text:'A',image:image(),status:'native-text'});
 s.sample({epoch:s.epoch,revision:2,at:202,text:'B',status:'image-denied'});assert.equal(s.active!.image,'');
 s.sample({epoch:s.epoch,revision:2,at:203,image:image(),status:'image-only'});assert.equal(s.active!.text,'');
});

test('same-document content change invalidates even an evicted frame and unchanged poll cannot renew its lifetime',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});s.focus({epoch:s.epoch,revision:1,at:100,key:'chrome',app:'Chrome',title:'',clock:'native',browser:true});
 const c=()=>({challenge:s.challenge(),private:false,focused:true,document:'doc',url:'https://example.test',title:'A',text:'A'});
 assert.ok(s.browser(c(),101));assert.ok(s.browserImage({...c(),url:s.active!.url,automatic:true,image:image()},101));
 s.active!.expiresAt=Date.now()-1;assert.ok(s.browser(c(),102));assert.equal(s.active!.image,'','poll cannot refresh an expired frame');
 assert.ok(s.browserImage({...c(),url:s.active!.url,automatic:true,image:image()},102));s.active!.image='';s.active!.imageAvailable=true;
 assert.ok(s.browser({...c(),text:'B'},103));assert.equal(s.active!.imageAvailable,false,'invalidation is not memory eviction');
});

for(const offline of [false,true])test(`preview image eviction preserves exact durable bytes (${offline?'pending':'synced'})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collector-image-')),key=randomBytes(32),sk=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),sk);const origin=server.origin;
 try{
  let client=new TrackingClient(origin,join(dir,'client'),key);await client.signin('image-owner','invented-password-123','Invented',true);
  const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:true,rich:true,retain:true});await sink.settle();const bytes=image();
  for(let i=1;i<=3;i++){
   session.focus({epoch:session.epoch,revision:i,at:i*100,key:`editor/${i}`,app:'Editor',title:`Invented ${i}`,clock:'native'});await sink.settle();
   session.sample({epoch:session.epoch,revision:i,at:i*100+1,text:`Invented ${i}`,textSource:'native',status:'native-text',image:bytes,framePTS:i*100+1});await sink.settle();
   if(!offline)await client.sync();
  }
  assert.equal(session.visits[0]!.image,'');assert.ok(session.visits.reduce((n,v)=>n+v.image.length,0)<=6_000_000);
  await sink.dispose();client=new TrackingClient(origin,join(dir,'client'),key);await syncAll(client);
  const entries=(await client.inspect()).entries;assert.equal(entries.length,3);
  const first=entries.find(e=>e.record?.visit.key==='editor/1')!.record!;assert.equal(first.visit.image,bytes);
  assert.equal(first.visit.framePTS,101);
  await server.close();server=await startTrackingServer(join(dir,'server'),sk,Number(new URL(origin).port));
  const other=new TrackingClient(origin,join(dir,'other'),randomBytes(32));await other.signin('image-owner','invented-password-123','Other');await syncAll(other);
  assert.equal((await other.inspect()).entries.find(e=>e.visitId===first.visitId)!.record!.visit.image,bytes);
  // A claimed eviction in a different context cannot fetch an arbitrary old frame.
  const mismatch=structuredClone(first);mismatch.revision++;mismatch.visit.key='different-window';mismatch.visit.image='';mismatch.visit.imageAvailable=true;
  await client.enqueue({id:randomUUID(),deviceId:mismatch.deviceId,recordingId:mismatch.recordingId,visitId:mismatch.visitId,record:mismatch});await syncAll(client);
  assert.equal((await client.inspect()).entries.find(e=>e.visitId===first.visitId)!.record!.visit.image,'');
  // Explicit expiry/removal is not memory eviction, even if a newer envelope arrives.
  const r=structuredClone(mismatch);r.revision++;r.visit.imageAvailable=false;r.visit.expiresAt=Date.now()-1;
  await client.enqueue({id:randomUUID(),deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,record:r});await client.sync();
  assert.equal((await client.inspect()).entries.find(e=>e.visitId===r.visitId)!.record!.visit.image,'');
  await client.eraseDeviceHistory();await syncAll(client);await syncAll(other);assert.ok((await other.inspect()).entries.every(e=>e.deleted));
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('active heartbeat and timing retain correction across server restart and another signed-in client; changed evidence invalidates CAS',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collector-correction-')),sk=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),sk);const origin=server.origin;
 try{
  const client=new TrackingClient(origin,join(dir,'client'),randomBytes(32));await client.signin('label-owner','invented-password-123','Invented',true);
  const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:false,rich:false,retain:true});await sink.settle();
  session.focus({epoch:session.epoch,revision:1,at:100,key:'editor',app:'Editor',title:'Invented',clock:'native'});await sink.settle();
  session.sample({epoch:session.epoch,revision:1,at:101,text:'Invented reading',textSource:'native',status:'native-text'});await sink.settle();
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:200,coverage:'observed'});await sink.settle();await client.sync();await client.processing(true);
  const report=()=>client.sessions(Date.now()-60000,Date.now()+60000),first=(await report()).visits[0]!;
  await client.correct(first.key,first.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:300,coverage:'observed'});await sink.settle();await client.sync();
  assert.equal((await report()).visits[0]!.label!.source,'override');assert.equal((await report()).visits[0]!.evidenceRevision,first.evidenceRevision);
  session.pause(300);await sink.settle();await sink.dispose();await client.sync();
  await server.close();server=await startTrackingServer(join(dir,'server'),sk,Number(new URL(origin).port));
  const other=new TrackingClient(origin,join(dir,'other'),randomBytes(32));await other.signin('label-owner','invented-password-123','Other');
  const visit=(await other.sessions(Date.now()-60000,Date.now()+60000)).visits[0]!;assert.equal(visit.label!.source,'override');
  await other.correct(first.key,first.evidenceRevision,1,{categoryId:'work',activityId:'coding',relatedIds:[]});
  const r=structuredClone((await client.inspect()).entries[0]!.record!);r.revision++;r.visit.text='Different source content';
  await client.enqueue({id:randomUUID(),deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,record:r});await client.sync();
  assert.notEqual((await report()).visits[0]!.label!.source,'override');
  await assert.rejects(other.correct(first.key,first.evidenceRevision,2,{categoryId:'learning',activityId:'reading',relatedIds:[]}),/409/);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
