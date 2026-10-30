import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleEarnedLeisure} from '../../core/account/earned-leisure-host.js';
import {emptyEarnedLeisure,setEarnedOptIn} from '../../core/blocking/earned-time.js';
import {projectSession,type LabelState} from '../../core/tracking/session.js';
import {recordKey,validateOperation,type Entry,type Operation} from '../../core/tracking/types.js';

// Invented, validator-admitted history through the real host/projection/labels.
// These source-only checks do not acquire activity or invoke a provider.
const NOW=Date.now(),WALL=NOW-2_000_000,OWNER='invented-owner';
const learning={categoryId:'learning',activityId:'reading',relatedIds:[]};
const leisure={categoryId:'leisure',activityId:'watching',relatedIds:[]};
function entry(i:number,start=i*2000,end=start+1000,deviceId='mac',wall=WALL):Entry{
 const visitId=`visit-${i}`,recordingId='invented-recording';
 const op:Operation={id:`operation-${i}`,deviceId,recordingId,visitId,record:{
  schema:'spindle-tracking/v1',deviceId,recordingId,visitId,revision:1,consentRevision:1,policyRevision:1,
  wallAnchor:wall,monotonicAnchor:0,observedAt:end,expiresAt:NOW+600000,
  scopes:{recording:true,retention:true,upload:true,pixels:false},labelRevision:0,correctionRevision:0,
  activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:end,coverage:'observed'},
  visit:{id:visitId,key:`invented-window-${i}`,app:'Reader',title:'Invented reading',start,end,
   clock:'invented-clock',revision:1,browser:false,text:'Invented sample',textSource:'native',url:'',image:'',
   availability:'native-text',sampledAt:start,framePTS:null,expiresAt:NOW+600000}}};
 validateOperation(op,NOW);
 return {key:recordKey(op),deviceId,recordingId,visitId,seq:i+1,deleted:false,record:op.record};
}
function account(entries:Entry[],labelled:number[]){
 const labels:LabelState={local:true,corrections:Object.fromEntries(labelled.map(i=>[entries[i]!.key,{evidenceRevision:1,revision:1,history:[learning]}]))};
 return {id:OWNER,entries,devices:[{id:'mac'},{id:'win'}],labels,earnedLeisure:setEarnedOptIn(emptyEarnedLeisure(OWNER),true,WALL)};
}
type Account=ReturnType<typeof account>;
type Reply={balance:{earnedSeconds:number;spentSeconds:number;availableSeconds:number};lease?:unknown;replayed?:boolean};
const read=(a:Account)=>handleEarnedLeisure(a,undefined,'/earned-leisure/read',{},NOW) as Reply;
const request={requestId:'invented-lease',deviceId:'mac',host:'leisure.invalid',policyVersion:1,seconds:30};
const redeem=(a:Account,data=request)=>handleEarnedLeisure(a,undefined,'/earned-leisure/redeem',data,NOW) as Reply;
function admit(e:Entry){
 validateOperation({id:'updated-operation',deviceId:e.deviceId,recordingId:e.recordingId,visitId:e.visitId,...(e.deleted?{delete:true}:{record:e.record})},NOW);
}

test('513 admitted visits: an unlabelled extra visit cannot disable balance or idempotent redemption',()=>{
 const entries=Array.from({length:513},(_,i)=>entry(i));entries[0]=entry(0,0,60000);
 const a=account(entries.slice(0,512),[0]);
 assert.equal(read(a).balance.earnedSeconds,60);
 a.entries=entries;
 assert.throws(()=>projectSession(a.id,a.entries,a.labels,WALL,NOW),/RANGE_BOUND/,'the default session visit safety bound remains');
 assert.equal(read(a).balance.earnedSeconds,60,'visit 513 is unlabelled, not a reason to refuse earned time');
 const first=redeem(a),again=redeem(a);
 assert.deepEqual([first.balance.earnedSeconds,first.balance.spentSeconds,first.balance.availableSeconds],[60,30,30]);
 assert.deepEqual(again.lease,first.lease);assert.equal(again.replayed,true);assert.equal(again.balance.spentSeconds,30);
 assert.equal(a.earnedLeisure.credits.length,1);assert.equal(a.earnedLeisure.leases.length,1);
});

test('staggered dense overlaps below 512 visits: bounded pages keep cross-device union, not summed page totals',()=>{
 const entries=Array.from({length:256},(_,i)=>entry(i,i*1000,(i+256)*1000,i===64?'win':'mac'));
 const a=account(entries,[0,64]);
 assert.throws(()=>projectSession(a.id,a.entries,a.labels,WALL,NOW),/RANGE_BOUND/,'the default block-reference safety bound remains');
 const value=read(a);
 assert.equal(value.balance.earnedSeconds,320,'mac 0–256s overlaps win 64–320s across a page boundary');
 assert.equal(a.earnedLeisure.credits.length,2);
 assert.equal(read(a).balance.earnedSeconds,320,'repeated settlement does not duplicate either interval');
});

test('a clock conflict on a later page, even outside the settlement range, revokes old credit without refunding a lease',()=>{
 const entries=Array.from({length:130},(_,i)=>entry(i));entries[0]=entry(0,0,60000);
 const a=account(entries,[0]);
 assert.equal(read(a).balance.earnedSeconds,60);const first=redeem(a);
 // Same device/recording/clock, different mapping; individually valid, two days old.
 a.entries[128]=entry(128,0,1000,'mac',WALL-2*86400000);
 const value=read(a);
 assert.deepEqual([value.balance.earnedSeconds,value.balance.spentSeconds,value.balance.availableSeconds],[0,30,0]);
 assert.equal(a.earnedLeisure.credits.length,0,'previously settled credit is not grandfathered through a clock conflict');
 assert.deepEqual(redeem(a).lease,first.lease,'already spent lease still replays without refund or another debit');
 const before=structuredClone(a.earnedLeisure);
 assert.throws(()=>redeem(a,{...request,requestId:'new-lease'}),/EARNED_TIME_INSUFFICIENT/);
 assert.deepEqual(a.earnedLeisure,before,'failed redemption cannot publish a partial settlement');
});

test('dense corrections, tombstones, expired context and opt-in preserve prior spends, including zero-live settlement',()=>{
 const entries=Array.from({length:513},(_,i)=>entry(i));
 entries[0]=entry(0,0,60000);entries[64]=entry(64,128000,158000);entries[128]=entry(128,256000,296000);
 const a=account(entries,[0,64,128]);
 assert.equal(read(a).balance.earnedSeconds,130);const first=redeem(a);
 const prior=structuredClone(a.earnedLeisure.credits.find(c=>c.key===entries[0]!.key)!);
 // Expiry keeps its existing credit but cannot grow it from a later heartbeat.
 const expired=entries[0]!.record!;expired.visit.expiresAt=NOW-1;expired.visit.end=90000;
 expired.observedAt=90000;expired.activity.heartbeatAt=90000;admit(entries[0]!);
 a.labels.corrections[entries[64]!.key]={evidenceRevision:1,revision:2,history:[learning,leisure]};
 a.entries[128]={...entries[128]!,deleted:true,record:undefined};admit(a.entries[128]!);
 let value=read(a);
 assert.deepEqual([value.balance.earnedSeconds,value.balance.spentSeconds,value.balance.availableSeconds],[60,30,30]);
 assert.deepEqual(a.earnedLeisure.credits,[prior],'correction and tombstone revoke; expired context neither loses nor gains credit');
 assert.deepEqual(redeem(a).lease,first.lease);assert.equal(a.earnedLeisure.leases.length,1);
 // Every live row is now a tombstone: settlement must still remove the old credit.
 const leases=structuredClone(a.earnedLeisure.leases);
 a.entries=a.entries.map(e=>({...e,deleted:true,record:undefined}));a.entries.forEach(admit);
 value=read(a);assert.deepEqual([value.balance.earnedSeconds,value.balance.spentSeconds,value.balance.availableSeconds],[0,30,0]);
 assert.deepEqual(a.earnedLeisure.leases,leases);
 assert.deepEqual(redeem(a).lease,first.lease);
 handleEarnedLeisure(a,undefined,'/earned-leisure/opt-in',{enabled:false},NOW);
 assert.equal(a.earnedLeisure.optIn,null);assert.equal(read(a).balance.spentSeconds,30);
 const old=entry(999,0,60000);a.entries=[old];
 a.labels.corrections[old.key]={evidenceRevision:1,revision:1,history:[learning]};
 assert.equal(read(a).balance.earnedSeconds,0,'opt-out cannot reaccrue from eligible history');
 handleEarnedLeisure(a,undefined,'/earned-leisure/opt-in',{enabled:true},NOW);
 value=handleEarnedLeisure(a,undefined,'/earned-leisure/read',{},NOW+1000) as Reply;
 assert.equal(value.balance.earnedSeconds,0,'a new opt-in cannot credit earlier learning');assert.equal(value.balance.spentSeconds,30);
});

test('full-credit settlement is atomic and reconciles old credits before admitting new keys at the existing cap',()=>{
 const entries=Array.from({length:2048},(_,i)=>entry(i,i*500,i*500+1000));
 const a=account(entries,entries.map((_,i)=>i));
 assert.equal(read(a).balance.earnedSeconds,1024);assert.equal(a.earnedLeisure.credits.length,2048);redeem(a);
 const before=structuredClone(a.earnedLeisure),old=entries[0]!,last=entries[2047]!,fault=entries[2046]!;
 old.record!.visit.expiresAt=NOW-1;admit(old);
 // A timing-only revision changes an early page without changing its label.
 const revised=entries[1]!.record!;revised.revision=2;revised.evidenceRevision=1;
 revised.visit.end=1750;revised.observedAt=1750;revised.activity.heartbeatAt=1750;admit(entries[1]!);
 // New credit arrives first in history, while an old credit is revoked on the
 // last page. Transient capacity pressure must not evict expired-context credit.
 const added=entry(3000,1500000,1501000);a.entries=[added,...entries];
 a.labels.corrections[added.key]={evidenceRevision:1,revision:1,history:[learning]};
 a.labels.corrections[last.key]={evidenceRevision:1,revision:2,history:[learning,leisure]};
 // Fault injection in saved label state, not a fake projection or capture record.
 a.labels.corrections[fault.key]!.history=[{...learning,categoryId:'unknown-concept'}];
 assert.throws(()=>read(a),/UNKNOWN_CONCEPT/);
 assert.deepEqual(a.earnedLeisure,before,'neither early timing revisions nor spends are partially published');
 a.labels.corrections[fault.key]!.history=[learning];
 const value=read(a);
 assert.equal(a.earnedLeisure.credits.length,2048,'the existing cap is unchanged, without extra page-order loss');
 assert.deepEqual(a.earnedLeisure.credits.find(c=>c.key===old.key),before.credits.find(c=>c.key===old.key),'expired context retains its old credit');
 assert.equal(a.earnedLeisure.credits.find(c=>c.key===entries[1]!.key)!.end,WALL+1750);
 assert.ok(a.earnedLeisure.credits.some(c=>c.key===added.key));
 assert.ok(!a.earnedLeisure.credits.some(c=>c.key===last.key));
 assert.deepEqual([value.balance.earnedSeconds,value.balance.spentSeconds,value.balance.availableSeconds],[1025,30,995]);
});
