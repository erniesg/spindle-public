import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';

function observation(deviceId:string,index=0,revision=1):Operation{
 const now=Date.now(),visitId='invented-visit-'+index;
 return {id:randomUUID(),deviceId,recordingId:'invented-recording',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-recording',visitId,revision,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:100,expiresAt:now+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:100,coverage:'observed'},visit:{id:visitId,key:'invented-window',app:'invented-editor',title:'Invented',start:0,end:100,clock:'invented-clock',revision:1,browser:false,text:'Invented valid context',textSource:'native',url:'',image:'',imageAvailable:false,availability:'native-text',sampledAt:10,framePTS:null,expiresAt:now+900000}}};
}
function cutoff(op:Operation,end:number,revision=op.record!.revision+1){const copy=structuredClone(op);copy.id=randomUUID();const r=copy.record!;r.revision=revision;r.visit.end=end;r.observedAt=end;r.activity.heartbeatAt=end;r.visit.title='';r.visit.text='';r.visit.url='';r.visit.image='';r.visit.textSource='unavailable';r.visit.sampledAt=r.visit.start;r.visit.availability='coverage-gap';return copy;}
async function drain(c:TrackingClient){for(let i=0;i<30;i++){const r=await c.sync();if(!r.pending&&!r.hasMore)return;}throw Error('sync did not drain');}
async function setup(){await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/bounds-')),serverKey=randomBytes(32),clientKey=randomBytes(32),server=await startTrackingServer(join(dir,'server'),serverKey),client=new TrackingClient(server.origin,join(dir,'client'),clientKey);await client.signin('bounds-owner','invented-password-123','Invented',true);return {dir,serverKey,clientKey,server,client};}
async function ackOnly(c:TrackingClient,op:Operation){await c.enqueue(op);const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const r=await original(input,init);if(String(input).includes('/history?')){await r.body?.cancel();throw Error('INVENTED_HISTORY_FAILURE');}return r;};try{await assert.rejects(c.sync(),/INVENTED_HISTORY_FAILURE/);}finally{globalThis.fetch=original;}}

test('ACK-only bounds intent survives client/server restart, coalesces without extension and preserves exact correction',async()=>{
 const s=await setup();let server=s.server,client=s.client;
 try{
  const original=observation((await client.inspect()).deviceId);await ackOnly(client,original);await client.processing(true);await client.correct(recordKey(original),1,0,{categoryId:'learning',activityId:'reading',relatedIds:[]});
  await client.reconcileBounds([cutoff(original,50)]);assert.equal((await client.inspect()).reconciling,1);await client.settle();const origin=server.origin;await server.close();server=await startTrackingServer(join(s.dir,'server'),s.serverKey,Number(new URL(origin).port));client=new TrackingClient(origin,join(s.dir,'client'),s.clientKey);
  await client.reconcileBounds([cutoff(original,30,3)]);await client.reconcileBounds([cutoff(original,70,4)]);assert.equal((await client.inspect()).pending,1);await drain(client);
  const record=(await client.inspect()).entries.find(e=>e.record)!.record!;assert.equal(record.revision,4);assert.equal(record.visit.end,30);assert.equal(record.visit.text,'Invented valid context');assert.equal((await client.inspect()).reconciling,0);
  const peer=new TrackingClient(origin,join(s.dir,'peer'),randomBytes(32));await peer.signin('bounds-owner','invented-password-123','Peer');const report=await peer.sessions(original.record!.wallAnchor,original.record!.wallAnchor+200);assert.equal(report.personTime,30);assert.equal(report.visits[0]!.label?.source,'override');
 }finally{await server.close();await rm(s.dir,{recursive:true,force:true});}
});
for(const action of ['delete','expiry'] as const)test(`bounds ${action} dominates deferred reconciliation without content resurrection`,async()=>{
 const s=await setup();try{
  const original=observation((await s.client.inspect()).deviceId);await ackOnly(s.client,original);await s.client.reconcileBounds([cutoff(original,50)]);assert.equal((await s.client.inspect()).reconciling,1);
  if(action==='delete')await s.client.enqueue({id:randomUUID(),deviceId:original.deviceId,recordingId:original.recordingId,visitId:original.visitId,delete:true});
  else{const now=Date.now(),clock=mock.method(Date,'now',()=>now+2*3600000);try{await s.client.inspect();}finally{clock.mock.restore();}}
  assert.equal((await s.client.inspect()).reconciling,0);await drain(s.client);assert.equal((await s.client.inspect()).entries[0]!.deleted,true);
 }finally{await s.server.close();await rm(s.dir,{recursive:true,force:true});}
});
test('a persisted stale-base conflict holds sync, not account reauthentication or explicit erasure',async()=>{
 const s=await setup();try{
  const original=observation((await s.client.inspect()).deviceId);await ackOnly(s.client,original);await s.client.reconcileBounds([cutoff(original,50)]);
  const newer=structuredClone(original);newer.id=randomUUID();newer.record!.revision=3;newer.record!.visit.text='Newer invented context';await s.client.enqueue(newer);
  await assert.rejects(s.client.sync(),/RECONCILIATION_CONFLICT/);assert.equal((await s.client.inspect()).reconciling,1);
  await s.client.signin('bounds-owner','invented-password-123','Invented');await s.client.eraseDeviceHistory();assert.equal((await s.client.inspect()).reconciling,0);await drain(s.client);assert.equal((await s.client.inspect()).entries[0]!.deleted,true);
 }finally{await s.server.close();await rm(s.dir,{recursive:true,force:true});}
});
test('bounds intents are bounded and stale-base/permission conflicts cannot silently replace evidence',async()=>{
 const s=await setup();try{
  const id=(await s.client.inspect()).deviceId,original=observation(id,0,3);await s.client.enqueue(original);await drain(s.client);
  await assert.rejects(s.client.reconcileBounds([cutoff(original,50,2)]),/RECONCILIATION_CONFLICT/);assert.equal((await s.client.inspect()).reconciling,0);
  const changed=cutoff(original,50,4);changed.record!.consentRevision=2;await assert.rejects(s.client.reconcileBounds([changed]),/RECONCILIATION_CONFLICT/);assert.equal((await s.client.inspect()).entries[0]!.record!.visit.text,'Invented valid context');
  await s.client.reconcileBounds(Array.from({length:64},(_,i)=>cutoff(observation(id,i+1),50)));assert.equal((await s.client.inspect()).reconciling,64);assert.equal((await s.client.inspect()).pending,64);
  await assert.rejects(s.client.reconcileBounds([cutoff(observation(id,100),50)]),/BOUNDS_INTENT_BOUND/);assert.equal((await s.client.inspect()).reconciling,64);
 }finally{await s.server.close();await rm(s.dir,{recursive:true,force:true});}
});
