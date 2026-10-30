import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,scripted,alice} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {existsSync,mkdirSync,renameSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
const ns={workspaceId:'w',accountId:alice};
function activity(seq=1){const now=Date.now();return {key:'device/recording/visit',deviceId:'device',recordingId:'recording',visitId:'visit',seq,deleted:false,record:{schema:'spindle-tracking/v1',deviceId:'device',recordingId:'recording',visitId:'visit',revision:1,consentRevision:2,policyRevision:3,wallAnchor:now,monotonicAnchor:0,observedAt:0,expiresAt:now+60000,scopes:{recording:true,retention:true,upload:true,pixels:false},visit:{id:'visit',title:'Invented activity',text:'I prefer tea',image:'NEVER_SEND_IMAGE_SENTINEL',url:'NEVER_SEND_URL_SENTINEL',expiresAt:now+60000}}};}
test('account/history opt-ins -> permitted text snapshot -> inferred memory; durable event identity and deletion preserve independent correction',async()=>{
 let calls=0,deleted=false,modelCalls=0;const record=activity();const base=scripted();
 const f=fixture({id:'activity-script',next(task,...args){modelCalls++;assert.doesNotMatch(task.requestedOutcome,/NEVER_SEND/);return base.next(task,...args);}},url=>{if(url.pathname==='/user-memory/activity'){calls++;assert.equal(url.searchParams.get('limit'),'16');const cursor=Number(url.searchParams.get('cursor'));const entry=deleted?{key:record.key,deviceId:record.deviceId,recordingId:record.recordingId,visitId:record.visitId,seq:2,deleted:true}:record;return {entries:entry.seq>cursor?[entry]:[],cursor:Math.max(cursor,entry.seq),hasMore:false};}return {};});
 try{
  await f.app.signin('Alice','invented');await f.app.drain();assert.equal(calls,0);
  f.app.configure({conversation:false,activity:true,processing:false,sync:false});await f.app.drain();assert.equal(calls,0);
  f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();assert.equal(f.app.recall('tea')[0].origin,'inferred');assert.equal(modelCalls,2);
  await f.app.drain();assert.equal(modelCalls,2);const store=new UserMemoryStore(f.evidence.db);const job=store.jobs(ns)[0];assert.equal(job.activityKey,'device/recording/visit');assert.equal(job.source.activityKey,'device/recording/visit');assert.equal(job.source.activityRevision,1);assert.equal(f.app.recall('tea')[0].sources?.[0].activityRevision,1);assert.match(f.evidence.source(ns,job.source.sourceId).providerId!,/device\/recording\/visit:1:2:3/);
  const entry=f.app.recall('tea')[0];f.app.correct('drink','preference','Prefers coffee',entry.revision);await f.app.drain();deleted=true;await f.app.drain();assert.equal(f.app.recall('coffee')[0].origin,'user');assert.equal(store.jobs(ns)[0].state,'cancelled');assert.throws(()=>f.evidence.read(ns,job.artifactId));
 }finally{await f.close();}
});
test('replacement commits cancellation before unlink and retries it on restart without a forget fence',async()=>{
 let record=activity();const f=fixture(scripted(),url=>{const cursor=Number(url.searchParams.get('cursor'));return {entries:record.seq>cursor?[record]:[],cursor:Math.max(cursor,record.seq),hasMore:false};});let app=f.app;
 try{await app.signin('Alice','invented');await app.drain();app.configure({conversation:false,activity:true,processing:true,sync:false});await app.drain();const store=new UserMemoryStore(f.evidence.db),old=store.jobs(ns)[0],path=join(f.root,'artifacts',old.artifactId);
 renameSync(path,path+'.saved');mkdirSync(path);record={...record,seq:2,record:{...record.record,revision:2,visit:{...record.record.visit,text:'New revision'}}};
 await app.drain();assert.equal(store.jobs(ns)[0].state,'cancelled');assert.equal(store.sourceForgotten(ns,old.source),false);assert.equal(store.sourceOutbox(ns).length,0);assert.equal(store.outbox(ns).length,0);assert.equal(store.sources(ns).length,0);
 rmdirSync(path);renameSync(path+'.saved',path);await app.stop();app=f.service();await app.signin('Alice','invented');await app.drain();assert.equal(existsSync(path),false);assert.equal(store.sourceOutbox(ns).length,0);assert.equal(store.jobs(ns).filter(j=>j.state!=='cancelled').length,1);
 }finally{await app.stop();await f.close();}
});
test('malformed activity page admits nothing and does not advance cursor',async()=>{
 const bad=activity();bad.record.visit.id='foreign-visit';const f=fixture(scripted(),()=>({entries:[bad],cursor:1,hasMore:false}));try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();const store=new UserMemoryStore(f.evidence.db);assert.equal(store.state(ns,'activityCursor'),undefined);assert.deepEqual(store.jobs(ns),[]);assert.deepEqual(f.app.recall('tea'),[]);}finally{await f.close();}
});
test('unavailable activity history does not block independent conversation learning',async()=>{
 const f=fixture(scripted(),()=>new Response('',{status:403}));try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:true,activity:true,processing:true,sync:false});await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.equal(f.app.recall('tea')[0].origin,'inferred');const status=f.app.status();assert.equal(status.authenticated&&status.activityError,'ACCOUNT_HTTP_403');}finally{await f.close();}
});
test('activity deletion queues a durable forget for dependent inference',async()=>{
 const record=activity();let deleted=false;const f=fixture(scripted(),url=>{const cursor=Number(url.searchParams.get('cursor'));const entry=deleted?{key:record.key,deviceId:record.deviceId,recordingId:record.recordingId,visitId:record.visitId,seq:2,deleted:true}:record;return {entries:entry.seq>cursor?[entry]:[],cursor:Math.max(cursor,entry.seq),hasMore:false};});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();assert.equal(f.app.recall('tea').length,1);deleted=true;await f.app.drain();assert.deepEqual(f.app.recall('tea'),[]);assert.equal(new UserMemoryStore(f.evidence.db).outbox(ns)[0].action,'forget');}finally{await f.close();}
});
