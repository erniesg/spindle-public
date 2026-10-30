// Invented producer events through production owner/sink/HTTP/store. No native OS claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PreviewSession} from '../../core/preview/session.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {validateOperation} from '../../core/tracking/types.js';
import {startTrackingServer} from '../../core/tracking/server.js';

async function drain(client:TrackingClient){for(let i=0;i<30;i++){const r=await client.sync();if(!r.pending&&!r.hasMore)return;}throw Error('sync did not drain');}
for(const browser of [false,true])test(`retroactive ${browser?'browser':'native'} gap revises/deletes persisted identities through restart`,async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/gap-history-')),key=randomBytes(32);let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin;
 const client=new TrackingClient(origin,join(dir,'client'),randomBytes(32)),session=new PreviewSession();let sink:CollectorHistory|undefined;
 try{
  await client.signin('invented-gap','invented-password-123','Invented',true);sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:false,rich:false,retain:true});sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:0,coverage:'observed'});await sink.settle();
  for(const at of [0,100]){
   session.focus({epoch:session.epoch,revision:at+1,at,key:'invented-'+at,app:browser?'chrome':'invented-editor',title:browser?'':'Invented',clock:'invented-clock',browser});await sink.settle();
   if(browser)session.browser({challenge:session.challenge(),private:false,focused:true,document:'doc-'+at,url:'https://invented.example/'+at,title:'Invented',text:'function invented() {}'},at+75);
   else session.sample({epoch:session.epoch,revision:at+1,at:at+75,text:'function invented() {}',textSource:'native',status:'native-text'});
   await sink.settle();
  }
  session.pause(200);await sink.settle();await drain(client);
  const a=(await client.inspect()).entries.find(e=>e.record?.visit.start===0)!,from=a.record!.wallAnchor,to=from+300;
  assert.equal((await client.sessions(from,to)).personTime,200);
  await client.processing(true);const first=(await client.sessions(from,to)).visits.find(v=>v.key===a.key)!;await client.correct(first.key,first.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  session.gap(50);await sink.settle();await drain(client);await sink.dispose();sink=undefined;
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  const peer=new TrackingClient(origin,join(dir,'peer'),randomBytes(32));await peer.signin('invented-gap','invented-password-123','Peer');await drain(peer);
  const report=await peer.sessions(from,to);assert.equal(report.personTime,50);assert.equal(report.visits.length,1);assert.equal(report.visits[0]!.duration,50);assert.notEqual(report.visits[0]!.label?.source,'override');
  const entries=(await peer.inspect()).entries;assert.equal(entries.filter(e=>e.deleted).length,1);const retained=entries.find(e=>e.record)!.record!.visit;
  assert.equal(retained.end,50);assert.equal(retained.text,'');assert.equal(retained.url,'');assert.equal(retained.image,'');assert.equal(retained.availability,'coverage-gap');
  const live=entries.find(e=>e.record)!;assert.throws(()=>validateOperation({id:'invented-unsafe-gap',deviceId:live.deviceId,recordingId:live.recordingId,visitId:live.visitId,record:{...live.record!,visit:{...retained,text:'STALE_CONTEXT'}}}),/INVALID_GAP_CONTEXT/);
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
for(const newNative of [false,true])test(`delayed native focus reconciles browser receipt visits without deleting new authority (${newNative})`,async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/focus-reconcile-')),key=randomBytes(32);let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin,client=new TrackingClient(origin,join(dir,'client'),randomBytes(32)),session=new PreviewSession();let sink:CollectorHistory|undefined;
 try{
  await client.signin('focus-reconcile','invented-password-123','Invented',true);sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);session.start({pixels:false,rich:false,retain:true});sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:0,coverage:'observed'});await sink.settle();
  session.focus({epoch:session.epoch,revision:1,at:0,key:'browser-window',app:'chrome',title:'',clock:'invented-clock',browser:true});await sink.settle();
  for(const at of [0,100,200]){session.browser({challenge:session.challenge(),private:false,focused:true,document:'doc-'+at,url:'https://invented.example/'+at,title:'Invented '+at,text:'function invented() {}'},at);await sink.settle();await drain(client);}
  const a=(await client.inspect()).entries.find(e=>e.record?.visit.start===0)!,from=a.record!.wallAnchor,to=from+300;assert.equal((await client.sessions(from,to)).personTime,200);
  await client.processing(true);const before=(await client.sessions(from,to)).visits.find(v=>v.key===a.key)!;await client.correct(before.key,before.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  const generation=session.generation;
  assert.equal(session.focus({epoch:session.epoch,revision:2,at:50,key:newNative?'authoritative-native':null,app:'invented-editor',title:'Invented new authority',clock:'invented-clock',browser:false}),true);assert.ok(session.generation>generation,'retroactive invalidation fences old Saved/restore copies');await sink.settle();
  if(newNative){session.sample({epoch:session.epoch,revision:2,at:60,text:'Invented new authority',status:'native-text'});await sink.settle();}
  session.pause(80);await sink.settle();await drain(client);await sink.dispose();sink=undefined;await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  const peer=new TrackingClient(origin,join(dir,'peer'),randomBytes(32));await peer.signin('focus-reconcile','invented-password-123','Peer');await drain(peer);const report=await peer.sessions(from,to);
  assert.equal(report.personTime,newNative?80:50);assert.equal(report.visits.find(v=>v.key===a.key)!.label?.source,'override','valid pre-boundary context/correction survives timing-only reconciliation');
  const entries=(await peer.inspect()).entries;assert.equal(entries.filter(e=>e.deleted).length,2);assert.equal(entries.some(e=>e.record?.visit.key==='authoritative-native'),newNative);
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
for(const late of ['text','image'] as const)test(`native focus clears ${late} acquired after the authoritative boundary`,async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/focus-context-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32)),session=new PreviewSession();let sink:CollectorHistory|undefined;
 try{
  await client.signin('focus-context','invented-password-123','Invented',true);sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);session.start({pixels:true,rich:true,retain:true});sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:100,coverage:'observed'});await sink.settle();session.focus({epoch:session.epoch,revision:1,at:0,key:'browser-window',app:'chrome',title:'',clock:'invented-clock',browser:true});await sink.settle();
  const context=()=>({challenge:session.challenge(),private:false,focused:true,document:'doc',url:'https://invented.example',title:'Invented',text:'Invented permitted text'});session.browser(context(),0);await sink.settle();
  if(late==='text')session.browser({...context(),text:'Invented late content'},100);
  else assert.equal(session.browserImage({...context(),gesture:true,image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII='},100),true);
  await sink.settle();await drain(client);const from=(await client.inspect()).entries.find(e=>e.record)!.record!.wallAnchor;
  session.focus({epoch:session.epoch,revision:2,at:50,key:null,app:'',title:'',clock:'invented-clock',browser:false});await sink.settle();await drain(client);
  const report=await client.sessions(from,from+200);assert.equal(report.personTime,50);assert.equal(report.visits[0]!.context.text,'');assert.equal(report.visits[0]!.context.imageAvailable,false);assert.equal(report.visits[0]!.context.availability,'coverage-gap');
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
for(const mode of ['gap-observed','gap-no-heartbeat','gap-valid','pause','document'] as const)test(`independent image association across active ${mode} cutoff`,async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/active-gap-')),key=randomBytes(32);let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin,client=new TrackingClient(origin,join(dir,'client'),randomBytes(32)),session=new PreviewSession();let sink:CollectorHistory|undefined;
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII=';
 try{
  await client.signin('active-gap','invented-password-123','Invented',true);sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);session.start({pixels:true,rich:true,retain:true});sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:mode==='gap-no-heartbeat'?0:100,coverage:'observed'});await sink.settle();
  session.focus({epoch:session.epoch,revision:1,at:0,key:'browser-window',app:'chrome',title:'',clock:'invented-clock',browser:true});await sink.settle();
  const context=()=>({challenge:session.challenge(),private:false,focused:true,document:'doc',url:'https://invented.example',title:'Invented',text:'Invented body'});assert.equal(session.browser(context(),0),true);await sink.settle();assert.equal(session.browserImage({...context(),gesture:true,image:png},mode==='gap-valid'?25:100),true);await sink.settle();await drain(client);
  const original=(await client.inspect()).entries.find(e=>e.record)!;assert.equal(original.record!.visit.image,png);const from=original.record!.wallAnchor;
  await client.processing(true);await client.correct(original.key,original.record!.evidenceRevision??original.record!.revision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  if(mode.startsWith('gap-'))session.gap(50);else if(mode==='pause')session.pause(50);else{assert.equal(session.browser({...context(),document:'next',url:'https://invented.example/next'},50),true);await sink.settle();session.pause(80);}
  await sink.settle();await drain(client);await sink.dispose();sink=undefined;await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  const peer=new TrackingClient(origin,join(dir,'peer'),randomBytes(32));await peer.signin('active-gap','invented-password-123','Peer');await drain(peer);const stored=(await peer.inspect()).entries.find(e=>e.visitId===original.visitId)!.record!;
  assert.equal(stored.visit.end,50);const report=await peer.sessions(from,from+200);assert.equal(report.personTime,mode==='document'?80:50);
  if(mode==='gap-valid'){assert.equal(stored.visit.image,png,'valid pre-cutoff image remains supporting evidence');assert.equal(stored.visit.imageSampledAt,25);assert.equal(report.visits.find(v=>v.key===original.key)!.label?.source,'override','timing-only cutoff preserves exact correction');}
  else{assert.equal(stored.visit.image,'','no image acquired at 100 may survive on an interval ending at 50');assert.equal(stored.visit.imageAvailable,false);assert.equal(stored.visit.imageSampledAt,undefined);assert.notEqual(report.visits.find(v=>v.key===original.key)!.label?.source,'override');}
  assert.throws(()=>validateOperation({id:'invented-late-image',deviceId:stored.deviceId,recordingId:stored.recordingId,visitId:stored.visitId,record:{...stored,visit:{...stored.visit,availability:'browser-manual-rich-partial',textSource:'dom:browser-window/doc',image:png,imageAvailable:true,imageSampledAt:100}}}),/IMAGE_TIME_DENIED/);
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
for(const readback of ['cached','ack-only'] as const)test(`evicted valid evidence/correction survives a gap (${readback}); ordinary eviction never deletes`,async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/gap-eviction-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32)),session=new PreviewSession(),originalFetch=globalThis.fetch;let sink:CollectorHistory|undefined,permitHistory=readback==='cached';
 try{
  await client.signin('evicted-gap','invented-password-123','Invented',true);sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);session.start({pixels:false,rich:false,retain:true});sink.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:0,coverage:'observed'});await sink.settle();
  globalThis.fetch=async(input,init)=>{const r=await originalFetch(input,init);if(!permitHistory&&String(input).includes('/history?')){await r.body?.cancel();throw Error('INVENTED_ACK_HISTORY_FAILURE');}return r;};
  const sync=()=>permitHistory?drain(client):assert.rejects(client.sync(),/INVENTED_ACK_HISTORY_FAILURE/);
  for(let i=0;i<110;i++){session.focus({epoch:session.epoch,revision:i+1,at:i*10,key:'invented-'+i,app:'invented-editor',title:'Invented',clock:'invented-clock',browser:false});await sink.settle();session.sample({epoch:session.epoch,revision:i+1,at:i*10+1,text:'Invented',status:'native-text'});await sink.settle();if(i%10===9)await sync();}
  session.pause(1100);await sink.settle();await sync();assert.equal(session.visits.length,100);assert.equal((await client.inspect()).entries.filter(e=>e.record).length,readback==='cached'?110:0);
  const from=Date.now()-60000,to=Date.now()+60000;assert.equal((await client.sessions(from,to)).personTime,1100);await client.processing(true);const target=(await client.sessions(from,to)).visits.find(v=>v.clock.start===50)!;await client.correct(target.key,target.evidenceRevision,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  session.gap(55);await sink.settle();permitHistory=true;await drain(client);assert.equal((await client.sessions(from,to)).personTime,55);
  const peer=new TrackingClient(server.origin,join(dir,'peer'),randomBytes(32));await peer.signin('evicted-gap','invented-password-123','Peer');await drain(peer);assert.equal((await peer.inspect()).entries.filter(e=>e.deleted).length,104);assert.equal((await peer.inspect()).entries.filter(e=>e.record).length,6);
  const preserved=(await peer.sessions(from,to)).visits.find(v=>v.key===target.key)!;assert.equal(preserved.duration,5);assert.equal(preserved.context.text,'Invented','valid acquired-at-51 content must survive the cutoff at 55, even after eviction or ACK-only sync');assert.equal(preserved.label?.source,'override');
 }finally{globalThis.fetch=originalFetch;await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
