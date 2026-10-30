import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startTrackingServer } from '../../core/tracking/server.js';
import { TrackingClient } from '../../core/tracking/client.js';
import { EncryptedStore } from '../../core/tracking/store.js';
import { PreviewSession } from '../../core/preview/session.js';
import { projectSession, range } from '../../core/tracking/session.js';
import { recordKey, type Operation, type Entry } from '../../core/tracking/types.js';
// Invented provider input through the production visit owner: NOT native capture.
function observation(deviceId:string,wall:number,start:number,end:number,app='Editor'):Operation {
 const session=new PreviewSession();session.start({pixels:false,rich:false,retain:true});
 assert.equal(session.focus({epoch:session.epoch,at:start,revision:1,key:'invented/window',app,title:'Invented session',clock:'source-boot-1'}),true);
 assert.equal(session.sample({epoch:session.epoch,revision:1,at:start,text:app==='Editor'?'function invented() {}':'Invented reading',textSource:'native',status:'native-text'}),true);
 session.pause(end);const visit=session.visits[0]!;
 return {id:randomUUID(),deviceId,recordingId:'recording',visitId:visit.id,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'recording',visitId:visit.id,revision:1,consentRevision:1,policyRevision:1,wallAnchor:wall,monotonicAnchor:0,observedAt:end,expiresAt:Date.now()+600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:end,coverage:'observed'},visit}};
}
function browserObservation(deviceId:string,wall:number):Operation{
 const op=observation(deviceId,wall,20000,40000,'Browser');
 const session=new PreviewSession();session.start({pixels:false,rich:false,retain:true});
 assert.equal(session.focus({epoch:session.epoch,at:20000,revision:1,key:'invented/browser',app:'Browser',title:'',clock:'source-boot-1',browser:true}),true);
 assert.equal(session.browser({challenge:session.challenge(),private:false,focused:true,document:'invented-document',url:'https://example.com',title:'Invented documentation',text:'Invented permitted DOM reading'},20000),true);session.pause(40000);
 op.record!.visit=session.visits[0]!;op.visitId=op.record!.visit.id;op.record!.visitId=op.visitId;return op;
}
function entry(op:Operation):Entry{return {key:recordKey(op),deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,seq:1,deleted:false,record:op.record};}
const selected={categoryId:'learning',activityId:'reading',relatedIds:[]};
test('session HTTP: signin/device-bound source history, overlap/handoff, local scope and durable exact correction',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-session-')),key=randomBytes(32),localKey=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin,wall=Date.now()-100000;
 try{
  let mac=new TrackingClient(origin,join(dir,'mac'),localKey);const win=new TrackingClient(origin,join(dir,'win'),randomBytes(32));
  await mac.signin('session-owner','invented-password-123','Mac invented',true);await win.signin('session-owner','invented-password-123','Windows invented');
  const device=(await mac.inspect()).deviceId,m=observation(device,wall,0,20000),browser=browserObservation(device,wall),document=observation(device,wall,40000,60000,'Document'),w=observation((await win.inspect()).deviceId,wall,30000,90000,'Document');
  for(const op of [m,browser,document])await mac.enqueue(op);await mac.sync();await win.enqueue(w);await win.sync();
  const query=async(client:TrackingClient)=>await client.sessions(wall,wall+100000) as unknown as ReturnType<typeof projectSession>;
  let report=await query(mac);assert.equal(report.personTime,90000);assert.deepEqual(Object.values(report.perDevice).sort(),[60000,60000]);assert.equal(report.visits[0]!.label,null);assert.equal(report.blocks.filter(b=>b.ambiguous).reduce((n,b)=>n+b.duration,0),30000);
  assert.equal(report.blocks.at(-1)!.state,'gap');assert.equal(report.visits[0]!.recentInputHint,false);assert.equal(report.visits[0]!.duration,20000);
  await assert.rejects(mac.correct(recordKey(m),1,0,selected),/403/);
  await mac.processing(true);report=await query(win);assert.equal(report.visits[0]!.label!.labels.activityId,'coding');assert.equal(report.visits[1]!.label!.labels.categoryId,'uncategorized');
  const k=recordKey(m);await assert.rejects(mac.correct(k,1,0,{...selected,categoryId:'invented-unknown-category'}),/400/);await mac.correct(k,1,0,selected);assert.equal((await query(win)).visits[0]!.label!.source,'override');
  await assert.rejects(win.correct(k,1,0,selected),/409/);await assert.rejects(mac.correct(k,2,1,selected),/409/);
  // Late duplicate delivery and automatic re-query never overwrite a correction.
  await mac.enqueue({...m,id:randomUUID()});await mac.sync();assert.deepEqual((await query(win)).visits[0]!.label!.labels,selected);
  await win.processing(false);assert.equal((await query(mac)).visits[0]!.label,null);await mac.processing(true);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  mac=new TrackingClient(origin,join(dir,'mac'),localKey);await mac.signin('session-owner','invented-password-123','Mac invented');
  assert.deepEqual((await query(mac)).visits[0]!.label!.labels,selected);assert.deepEqual((await query(win)).visits[0]!.label!.labels,selected);
  await win.undo(k,1,1);assert.equal((await query(mac)).visits[0]!.label!.labels.activityId,'coding');
  await mac.correct(k,1,2,selected);
  const other=new TrackingClient(origin,join(dir,'other'),randomBytes(32));await other.signin('different-owner','invented-password-456','Other',true);await other.processing(true);
  assert.equal((await query(other)).visits.length,0);await assert.rejects(other.correct(k,1,0,selected),/404/);
  await other.enqueue({id:randomUUID(),deviceId:m.deviceId,recordingId:m.recordingId,visitId:m.visitId,delete:true});await assert.rejects(other.sync(),/403/);
  assert.deepEqual((await query(mac)).visits[0]!.label!.labels,selected);
  await assert.rejects(mac.sessions(wall+1,wall),/400/);await assert.rejects(mac.sessions(NaN,wall),/400/);await assert.rejects(mac.sessions(0,32*86400000),/400/);
  await win.enqueue({id:randomUUID(),deviceId:m.deviceId,recordingId:m.recordingId,visitId:m.visitId,delete:true});await win.sync();
  assert.equal((await query(mac)).personTime,70000);await assert.rejects(mac.correct(k,1,3,selected),/404/);
  const disk=new EncryptedStore<{accounts:{labels?:{corrections:Record<string,unknown>}}[]}>(join(dir,'server'),key,()=>({accounts:[]}));
  assert.equal(await disk.transaction(s=>s.accounts.some(a=>a.labels?.corrections[k]!==undefined),false),false);
  await mac.enqueue({...m,id:randomUUID()});await mac.sync();assert.equal((await query(win)).visits.length,3);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));assert.equal((await query(win)).visits.length,3);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('session HTTP preserves time and valid label evidence when an accepted URL hostname exceeds the classifier bound',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-domain-')),key=randomBytes(32);
 const server=await startTrackingServer(join(dir,'server'),key),wall=Date.now()-100000;
 try{
  const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));
  await client.signin('domain-owner','invented-password-123','Invented device',true);
  const op=observation((await client.inspect()).deviceId,wall,0,20000,'A'.repeat(128));
  const host=Array.from({length:5},()=> 'a'.repeat(63)).join('.');assert.ok(host.length>253);
  const visit=op.record!.visit;visit.url=`https://${host}`;visit.title='T'.repeat(256);visit.text='function invented() {}'+ 'x'.repeat(4074);assert.equal(visit.text.length,4096);
  await client.enqueue(op);await client.sync();await client.processing(true);
  const report=await client.sessions(wall,wall+30000),v=report.visits[0]!;
  assert.equal(report.personTime,20000);assert.equal(report.processing,'local');
  assert.equal(v.context.url,visit.url);assert.equal(v.context.title,visit.title);assert.equal(v.context.text,visit.text);assert.equal(v.context.app,visit.app);
  assert.equal(v.label!.labels.activityId,'coding');
  await client.correct(recordKey(op),1,0,selected);assert.equal((await client.sessions(wall,wall+30000)).visits[0]!.label!.source,'override');
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('optional context expiry clears HTTP history, caches and corrections without erasing time',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-expiry-')),key=randomBytes(32),localKey=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin,wall=Date.now()-10000;
 const realNow=Date.now;let now=realNow();
 try{
  Date.now=()=>now;
  let a=new TrackingClient(origin,join(dir,'a'),localKey);const b=new TrackingClient(origin,join(dir,'b'),randomBytes(32));
  await a.signin('expiry-owner','invented-password-123','Mac',true);await b.signin('expiry-owner','invented-password-123','Windows');
  const op=browserObservation((await a.inspect()).deviceId,wall);op.record!.visit.expiresAt=now+1000;
  op.record!.scopes.pixels=true;const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);op.record!.visit.image=png.toString('base64');
  await a.enqueue(op);await a.sync();await b.sync();await a.processing(true);await a.correct(recordKey(op),1,0,selected);
  assert.equal((await b.sessions(wall,wall+50000)).visits[0]!.label!.source,'override');
  now+=1001;
  const verify=async(c:TrackingClient)=>{
   const report=await c.sessions(wall,wall+50000),v=report.visits[0]!;
   assert.equal(report.personTime,20000);assert.equal(v.context.title,'');assert.equal(v.context.url,'');assert.equal(v.context.text,'');assert.equal(v.context.imageAvailable,false);assert.equal(v.label,null);assert.equal(v.correctionRevision,0);
   await c.sync();const visit=(await c.inspect()).entries[0]!.record!.visit;
   for(const field of ['title','url','text','image'] as const)assert.equal(visit[field],'');
   await assert.rejects(c.correct(recordKey(op),1,0,selected),/410/);
  };
  await verify(a);await verify(b);
  // Expired duplicate delivery must not restore context or conflict with cleanup.
  await a.enqueue({...op,id:randomUUID()});await a.sync();await verify(b);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  a=new TrackingClient(origin,join(dir,'a'),localKey);await verify(a);await verify(b);
  const disk=new EncryptedStore<{accounts:{labels?:{corrections:Record<string,unknown>}}[]}>(join(dir,'server'),key,()=>({accounts:[]}));
  assert.equal(await disk.transaction(s=>s.accounts.some(x=>Object.keys(x.labels?.corrections??{}).length),false),false);
 }finally{Date.now=realNow;await server.close();await rm(dir,{recursive:true,force:true});}
});
test('source clocks: open heartbeat cap, gaps, lock, quiet reading, restart, rollback and expired optional evidence',()=>{
 const wall=Date.now()-10000,base=observation('mac',wall,0,1000),open=structuredClone(base);open.record!.visit.end=null;open.record!.observedAt=500;open.record!.activity.heartbeatAt=400;
 const run=(ops:Operation[])=>projectSession('owner',ops.map(entry),{local:true,corrections:{}},wall,wall+10000);
 assert.equal(run([open]).personTime,400);
 for(const coverage of ['gap','unknown'] as const){const op=structuredClone(base);op.record!.activity.coverage=coverage;assert.equal(run([op]).personTime,0);assert.equal(run([op]).visits[0]!.coverage,'unknown');}
 for(const key of ['awake','unlocked'] as const){const op=structuredClone(base);op.record!.activity[key]=false;assert.equal(run([op]).personTime,0);}
 const restart=observation('mac',wall+5000,0,1000);restart.recordingId='restart';restart.record!.recordingId='restart';restart.record!.visit.clock='source-boot-2';
 const duplicate=observation('mac',wall,0,1000);const sameDevice=run([base,duplicate]);assert.equal(sameDevice.personTime,1000);assert.equal(sameDevice.perDevice.mac,1000);assert.equal(sameDevice.visits.reduce((n,v)=>n+v.duration,0),2000);
 const report=run([base,restart]);assert.equal(report.personTime,2000);assert.equal(report.blocks.find(b=>b.start===wall+1000)!.state,'gap');
 const rollback=observation('mac',wall-500,1000,2000);assert.equal(run([base,rollback]).personTime,0);assert.ok(run([base,rollback]).anomalies.every(a=>a.reason==='inconsistent-clock-anchor'));
 const bad=structuredClone(base);bad.record!.observedAt=0;bad.record!.activity.heartbeatAt=100;assert.equal(run([bad]).anomalies[0]!.reason,'invalid-source-clock');
 const ipv6=structuredClone(base);ipv6.record!.visit.url='http://[::1]/';assert.equal(run([ipv6]).visits[0]!.label!.labels.activityId,'coding');
 const unavailable=structuredClone(base);unavailable.record!.visit.textSource='unavailable';assert.equal(run([unavailable]).visits[0]!.label!.source,'abstention');
 const expired=structuredClone(base);expired.record!.visit.expiresAt=Date.now()-1;const old=run([expired]);assert.equal(old.personTime,1000);assert.equal(old.visits[0]!.context.textState,'expired');assert.equal(old.visits[0]!.label,null);
 assert.throws(()=>run(Array.from({length:513},()=>observation('mac',wall,0,1000))),/RANGE_BOUND/);
 for(const args of [[null,'1'],['0','0'],['-1','5'],['1.1','5'],['0','2764800000']] as const)assert.throws(()=>range(args[0],args[1]),/INVALID_RANGE/);
});
