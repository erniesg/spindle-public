import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PreviewSession} from '../../core/preview/session.js';
import {PreviewControlOwner,signinPausedCollector} from '../../core/preview/app.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';

async function setup(){
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/reauth-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));
 const credentials={name:'invented-reauth',password:'invented-password-123',deviceName:'Invented'};
 await client.signin(credentials.name,credentials.password,credentials.deviceName,true);
 const session=new PreviewSession(),sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,30*86400000);
 session.start({pixels:false,rich:false,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'invented-window',app:'invented-editor',title:'Invented',clock:'invented-clock',browser:false});session.sample({epoch:session.epoch,revision:1,at:1,text:'Invented text',status:'native-text'});await sink.settle();
 return {dir,server,client,credentials,session,sink};
}
test('production exclusive control owner holds asynchronous Start against signin and another Start, then releases on cancellation',async()=>{
 const controls=new PreviewControlOwner();let release=()=>{},entered=()=>{},started=0;
 const held=new Promise<void>(r=>{release=r;}),atSettings=new Promise<void>(r=>{entered=r;});
 const first=controls.run(async()=>{entered();await held;started++;});
 try{await atSettings;assert.equal(controls.pending,true);await assert.rejects(controls.run(async()=>{started+=10;}),/CONTROL_BUSY/);await assert.rejects(controls.run(async()=>{started+=100;}),/CONTROL_BUSY/);assert.equal(started,0);}
 finally{release();await first;}
 assert.equal(started,1);assert.equal(controls.pending,false);
 await assert.rejects(controls.run(async()=>{throw Error('INVENTED_CANCEL');}),/INVENTED_CANCEL/);assert.equal(controls.pending,false);
 await controls.run(async()=>{started++;});assert.equal(started,2);
});
test('paused production signin drains/detaches sink, rebinds expired session and preserves durable pending history',async()=>{
 const s=await setup();let shifted:ReturnType<typeof mock.method>|undefined;
 try{
  await assert.rejects(signinPausedCollector(s.session,()=>s.sink.dispose(),s.client,s.credentials),/PAUSE_REQUIRED/);
  s.session.pause(10);await s.sink.settle();const id=(await s.client.inspect()).deviceId;
  const now=Date.now();shifted=mock.method(Date,'now',()=>now+13*3600000);
  await assert.rejects(s.client.sync(),/TRACKING_HTTP_401/);assert.ok((await s.client.inspect()).pending>0);
  let detached=false;await signinPausedCollector(s.session,async()=>{await s.sink.dispose();detached=true;},s.client,s.credentials);
  assert.equal(detached,true);assert.equal(s.session.recording,false);assert.equal((await s.client.inspect()).deviceId,id);assert.ok((await s.client.inspect()).pending>0);
  await s.client.sync();assert.equal((await s.client.inspect()).pending,0);assert.ok((await s.client.inspect()).entries.some(e=>e.record),'expired context does not erase valid retained activity');
 }finally{shifted?.mock.restore();await s.sink.dispose();await s.server.close();await rm(s.dir,{recursive:true,force:true});}
});
test('reauth waits for the same client owner’s real in-flight sync, rather than racing another encrypted-store owner',async()=>{
 const s=await setup(),original=globalThis.fetch;let release=()=>{},reached=()=>{},detached=()=>{},finished=false,signinCalls=0;
 const held=new Promise<void>(r=>{release=r;}),atSync=new Promise<void>(r=>{reached=r;}),atDetach=new Promise<void>(r=>{detached=r;});let flight:Promise<unknown>|undefined,reauth:Promise<void>|undefined;
 try{
  s.session.pause(10);await s.sink.settle();
  globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/signin'))signinCalls++;const r=await original(input,init);if(String(input).endsWith('/sync')){reached();await held;}return r;};
  flight=s.client.sync();await atSync;
  reauth=signinPausedCollector(s.session,async()=>{await s.sink.dispose();detached();},s.client,s.credentials).finally(()=>{finished=true;});
  await atDetach;await new Promise<void>(r=>setImmediate(r));assert.equal(finished,false);assert.equal(signinCalls,0);
  release();await flight;await reauth;assert.equal(signinCalls,1);assert.equal((await s.client.inspect()).pending,0);
 }finally{release();await flight?.catch(()=>{});await reauth?.catch(()=>{});globalThis.fetch=original;await s.sink.dispose();await s.server.close();await rm(s.dir,{recursive:true,force:true});}
});
