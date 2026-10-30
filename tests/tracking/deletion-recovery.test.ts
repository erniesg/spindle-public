import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {PreviewSettingsStore} from '../../core/preview/settings.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import type {HistoryRecord,Operation} from '../../core/tracking/types.js';

async function drain(c:TrackingClient){for(let i=0;i<30;i++){const r=await c.sync();if(!r.pending&&!r.hasMore)return;}throw Error('bounded sync did not drain');}
function observation(deviceId:string,index:number,browser=true):Operation{
 const visitId=randomUUID(),now=Date.now();
 const record:HistoryRecord={schema:'spindle-tracking/v1',deviceId,recordingId:'invented-recording',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:index+1,expiresAt:now+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:index+1,coverage:'observed'},visit:{id:visitId,key:'invented/window',app:'invented-app',title:'Invented deletion target',start:index,end:index+1,clock:'invented-clock',revision:1,browser,text:'INVENTED_DELETE_SENTINEL',textSource:browser?'dom:invented/window/doc':'native',url:browser?'https://invented.example':'',image:'',availability:browser?'browser-receipt-timed-partial':'native-text',sampledAt:index,framePTS:null,expiresAt:now+900000}};
 return {id:randomUUID(),deviceId,recordingId:record.recordingId,visitId,record};
}
test('profile revocation remains disabled and retryable across erase failure/restart; old retry cannot revoke a later enrollment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracker-revoke-')),key=randomBytes(32),token=randomBytes(32).toString('hex');
 try{
  let settings=new PreviewSettingsStore(dir);await settings.write({schema:'spindle-preview-settings/v1',profileToken:token,preferences:null},key);
  await assert.rejects(settings.finishBrowserRevocation(key,async()=>{throw Error('UNEXPECTED_ERASE');},randomBytes(32).toString('hex')),/REVOCATION_RECEIPT_REQUIRED_RETRY/);
  await settings.beginBrowserRevocation(key,token);
  await assert.rejects(settings.finishBrowserRevocation(key,async()=>{assert.equal((await settings.read(key)).revocation?.pending,true);throw Error('INVENTED_ERASE_FAILURE');}),/INVENTED_ERASE_FAILURE/);
  settings=new PreviewSettingsStore(dir);assert.equal((await settings.read(key)).profileToken,null);assert.equal((await settings.read(key)).revocation?.pending,true);
  await settings.beginBrowserRevocation(key,token);let erased=0;await settings.finishBrowserRevocation(key,async()=>{erased++;});assert.equal(erased,1);
  const later=randomBytes(32).toString('hex');await settings.write({...await settings.read(key),profileToken:later},key);
  await settings.beginBrowserRevocation(key,token);await settings.finishBrowserRevocation(key,async()=>{erased++;});
  assert.equal(erased,1);assert.equal((await settings.read(key)).profileToken,later);
  await assert.rejects(settings.beginBrowserRevocation(key,randomBytes(32).toString('hex')),/PROFILE_DENIED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('client-local expiry preserves browser purge identity until the server confirms deletion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracker-expiry-delete-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 try{
  const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));await client.signin('expiry-delete','invented-password-123','Invented',true);await client.enqueue(observation((await client.inspect()).deviceId,0));await drain(client);
  const now=Date.now(),clock=mock.method(Date,'now',()=>now+2*3600000);
  try{assert.equal((await client.inspect()).entries.filter(e=>e.record).length,0);}finally{clock.mock.restore();}
  await client.eraseDeviceHistory(true);await drain(client);
  const peer=new TrackingClient(server.origin,join(dir,'peer'),randomBytes(32));await peer.signin('expiry-delete','invented-password-123','Peer');await drain(peer);
  assert.equal((await peer.inspect()).entries[0]!.deleted,true,'local clock expiry is not server deletion proof and cannot erase provenance needed for revoke');
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
for(const failure of ['held-history','failed-history-restart'] as const)test(`post-ACK ${failure} retains deletion identity until history reconciliation`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracker-ack-delete-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),original=globalThis.fetch;
 let release=()=>{},reached=()=>{};const held=new Promise<void>(r=>{release=r;}),atHistory=new Promise<void>(r=>{reached=r;});let flight:Promise<unknown>|undefined;
 try{
  let client=new TrackingClient(server.origin,join(dir,'client'),key);await client.signin('ack-delete','invented-password-123','Invented',true);await client.enqueue(observation((await client.inspect()).deviceId,0));
  globalThis.fetch=async(input,init)=>{const r=await original(input,init);if(String(input).includes('/history?')){reached();if(failure==='held-history')await held;else{await r.body?.cancel();throw Error('INVENTED_HISTORY_FAILURE');}}return r;};
  flight=client.sync();if(failure==='failed-history-restart')await assert.rejects(flight,/INVENTED_HISTORY_FAILURE/);else await atHistory;
  assert.equal((await client.inspect()).pending,0,'producer ACK already removed raw pending put');assert.equal((await client.inspect()).entries.length,0,'history has not entered cache');
  if(failure==='failed-history-restart'){globalThis.fetch=original;client=new TrackingClient(server.origin,join(dir,'client'),key);}
  await client.eraseDeviceHistory(true);release();await flight.catch(()=>{});globalThis.fetch=original;
  await drain(client);assert.equal((await client.inspect()).entries.filter(e=>e.record).length,0,'late history cannot recover erased content');
  const peer=new TrackingClient(server.origin,join(dir,'peer'),randomBytes(32));await peer.signin('ack-delete','invented-password-123','Peer');await drain(peer);
  assert.equal((await peer.inspect()).entries.length,1);assert.equal((await peer.inspect()).entries[0]!.deleted,true,'durable server tombstone, not merely a hidden local row');
 }finally{release();await flight?.catch(()=>{});globalThis.fetch=original;await server.close();await rm(dir,{recursive:true,force:true});}
});
test('129 synced browser visits delete durably offline in bounded batches after restart and lost reply',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracker-delete-')),serverKey=randomBytes(32),clientKey=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),serverKey);const origin=server.origin;
 try{
  let client=new TrackingClient(origin,join(dir,'client'),clientKey);await client.signin('delete-owner','invented-password-123','Invented',true);
  const deviceId=(await client.inspect()).deviceId,old=observation(deviceId,0);
  for(let i=0;i<129;i++){await client.enqueue(i===0?old:observation(deviceId,i));if(i%16===15)await drain(client);}
  await client.enqueue(observation(deviceId,129,false));await drain(client);
  assert.equal((await client.inspect()).entries.length,130);
  await server.close();await client.eraseDeviceHistory(true);
  assert.equal((await client.inspect()).entries.filter(e=>e.record?.visit.browser).length,0);
  assert.equal((await client.inspect()).pending,129);
  client=new TrackingClient(origin,join(dir,'client'),clientKey);
  server=await startTrackingServer(join(dir,'server'),serverKey,Number(new URL(origin).port));
  const originalFetch=globalThis.fetch;let lost=false;
  globalThis.fetch=async(input,init)=>{const r=await originalFetch(input,init);if(String(input).endsWith('/sync')&&!lost){lost=true;await r.body?.cancel();throw Error('INVENTED_LOST_DELETE_REPLY');}return r;};
  try{await assert.rejects(client.sync(),/INVENTED_LOST_DELETE_REPLY/);}finally{globalThis.fetch=originalFetch;}
  await server.close();client=new TrackingClient(origin,join(dir,'client'),clientKey);server=await startTrackingServer(join(dir,'server'),serverKey,Number(new URL(origin).port));
  await drain(client);assert.equal((await client.inspect()).pending,0);
  const peer=new TrackingClient(origin,join(dir,'peer'),randomBytes(32));await peer.signin('delete-owner','invented-password-123','Peer');await drain(peer);
  assert.equal((await peer.inspect()).entries.filter(e=>e.deleted).length,129);
  assert.equal((await peer.inspect()).entries.filter(e=>e.record).length,1,'browser-only deletion preserves native history');
  await client.enqueue({...old,id:randomUUID()});await drain(client);await drain(peer);
  assert.equal((await peer.inspect()).entries.find(e=>e.visitId===old.visitId)!.record,undefined,'replay cannot resurrect deleted browser history');
 }finally{await server.close().catch(e=>{if(e.code!=='ERR_SERVER_NOT_RUNNING')throw e;});await rm(dir,{recursive:true,force:true});}
});
