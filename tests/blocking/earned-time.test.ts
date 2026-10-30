import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PreviewSession} from '../../core/preview/session.js';
import {projectSession,type LabelState} from '../../core/tracking/session.js';
import {recordKey,type Entry} from '../../core/tracking/types.js';
import {emptyEarnedLeisure,setEarnedOptIn,settleEarnedCredits,settlementRange,earnedBalance,redeemEarnedLeisure,
 leasePauseMessage,leaseStatus,validateEarnedLeisure,eligibility,type EarnedLeisureState} from '../../core/blocking/earned-time.js';
// Invented activity through the production visit owner, history projection and
// label correction path. Pure fixture: NOT native capture, Chrome or account wiring.
const OWNER='account-a',learning={categoryId:'learning',activityId:'reading',relatedIds:[]},leisure={categoryId:'leisure',activityId:'watching',relatedIds:[]};
const NOW=Date.now(),WALL=NOW-600_000;
function entry(deviceId:string,start:number,end:number,{visitId,coverage='observed',revision=1}:{visitId?:string;coverage?:'observed'|'unknown';revision?:number}={}):Entry{
 const s=new PreviewSession();s.start({pixels:false,rich:false,retain:true});
 assert.equal(s.focus({epoch:s.epoch,at:start,revision:1,key:'invented/window',app:'Reader',title:'Invented lesson',clock:'source-boot-1'}),true);
 assert.equal(s.sample({epoch:s.epoch,revision:1,at:start,text:'Invented reading',textSource:'native',status:'native-text'}),true);
 s.pause(end);const visit=s.visits[0]!;if(visitId)visit.id=visitId;
 const r={schema:'spindle-tracking/v1' as const,deviceId,recordingId:'recording',visitId:visit.id,revision,consentRevision:1,policyRevision:1,wallAnchor:WALL,monotonicAnchor:0,observedAt:end,expiresAt:NOW+600000,labelRevision:0,correctionRevision:0,
  scopes:{recording:true as const,retention:true as const,upload:true as const,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m' as const,heartbeatAt:end,coverage},visit};
 return {key:recordKey(r),deviceId,recordingId:'recording',visitId:visit.id,seq:1,deleted:false,record:r};
}
const labelled=(entries:Entry[],labels=learning):LabelState=>({local:true,corrections:Object.fromEntries(entries.map(e=>[e.key,{evidenceRevision:e.record!.revision,revision:1,history:[labels]}]))});
function settle(state:EarnedLeisureState,entries:Entry[],labels:LabelState,owner=OWNER,now=NOW){
 const range=settlementRange(state,now)!;
 const visits=projectSession(owner,entries.filter(e=>!e.deleted),labels,range.from,range.to).visits;
 return settleEarnedCredits(state,{visits,deletedKeys:entries.filter(e=>e.deleted).map(e=>e.key),now});
}
const optedIn=()=>setEarnedOptIn(emptyEarnedLeisure(OWNER),true,WALL);

test('24 s of owned, user-labelled, observed learning earns exactly 24 s; no record earns 0',()=>{
 const none=optedIn();
 assert.equal(earnedBalance(settle(none,[],labelled([])),NOW).availableSeconds,0,'no eligible record never invents study');
 const e=entry('mac',10_000,34_000),state=settle(optedIn(),[e],labelled([e]));
 assert.deepEqual(earnedBalance(state,NOW),{earnedSeconds:24,spentSeconds:0,availableSeconds:24,basis:'self-labelled observed learning time; not verified learning or attention'});
 assert.equal(validateEarnedLeisure(JSON.parse(JSON.stringify(state)),OWNER).credits.length,1,'state round-trips as one JSON account field');
 // Opt-in at server now is not retroactive.
 const late=setEarnedOptIn(emptyEarnedLeisure(OWNER),true,WALL+20_000);
 assert.equal(earnedBalance(settle(late,[e],labelled([e])),NOW).earnedSeconds,14);
});

test('overlapping devices, replayed pages and new record revisions never double-credit',()=>{
 const mac=entry('mac',10_000,34_000),win=entry('win',20_000,40_000);
 let state=settle(optedIn(),[mac,win],labelled([mac,win]));
 assert.equal(earnedBalance(state,NOW).earnedSeconds,30,'union 10–40 s, not 24+20');
 state=settle(settle(state,[mac,win],labelled([mac,win])),[mac],labelled([mac]));
 assert.equal(earnedBalance(state,NOW).earnedSeconds,30,'replayed pages replace by key');
 const revised=entry('mac',10_000,44_000,{visitId:mac.visitId,revision:2});
 state=settle(state,[revised],labelled([revised]));
 assert.equal(earnedBalance(state,NOW).earnedSeconds,34,'a revision replaces its own interval');
 assert.equal(earnedBalance(settle(state,[mac],labelled([mac])),NOW).earnedSeconds,34,'an older revision replay is ignored');
});

test('unknown coverage, leisure, model inference, foreign owner and opt-out are not eligible; deletion/correction reconcile',()=>{
 const unknown=entry('mac',0,30_000,{coverage:'unknown'}),fun=entry('mac',40_000,70_000),plain=entry('mac',80_000,110_000);
 const visits=(e:Entry,l:LabelState,owner=OWNER)=>projectSession(owner,[e],l,WALL,NOW).visits[0]!;
 assert.equal(eligibility(visits(unknown,labelled([unknown])),OWNER),'unknown-coverage');
 assert.equal(eligibility(visits(fun,labelled([fun],leisure)),OWNER),'not-learning');
 assert.equal(eligibility(visits(plain,{local:true,corrections:{}}),OWNER),'not-user-labelled','abstention/inference cannot mint credit');
 assert.equal(eligibility(visits(plain,labelled([plain]),'account-b'),OWNER),'foreign-owner');
 assert.equal(earnedBalance(settle(optedIn(),[unknown,fun,plain],{...labelled([unknown]),corrections:{...labelled([unknown]).corrections,...labelled([fun],leisure).corrections}}),NOW).earnedSeconds,0);
 assert.throws(()=>validateEarnedLeisure({...optedIn(),accountId:'account-b'},OWNER),/EARNED_STATE_INVALID/,'a ledger for another account is refused, not reset');
 // A correction away from learning, or a deletion tombstone, removes future credit only.
 const e=entry('mac',10_000,70_000);let state=settle(optedIn(),[e],labelled([e]));
 const spent=redeemEarnedLeisure(state,{requestId:'r1',deviceId:'mac',host:'a.test',policyVersion:1,seconds:30},NOW).state;
 assert.equal(earnedBalance(spent,NOW).availableSeconds,30);
 state=settle(spent,[e],labelled([e],leisure));
 assert.deepEqual([earnedBalance(state,NOW).spentSeconds,earnedBalance(state,NOW).availableSeconds],[30,0],'no refund, no negative, no free credit');
 assert.equal(earnedBalance(settle(spent,[{...e,deleted:true,record:undefined}],labelled([])),NOW).availableSeconds,0);
 // Opt-out drops unspent credit and refuses redemption.
 const off=setEarnedOptIn(settle(optedIn(),[e],labelled([e])),false,NOW);
 assert.equal(earnedBalance(off,NOW).availableSeconds,0);
 assert.throws(()=>redeemEarnedLeisure(off,{requestId:'r2',deviceId:'mac',host:'a.test',policyVersion:1,seconds:30},NOW),/EARNED_OPT_IN_REQUIRED/);
});

test('redeem is atomic and idempotent, bounded to the existing pause range, with readback instead of retry',()=>{
 const e=entry('mac',0,100_000),state=settle(optedIn(),[e],labelled([e]));
 const request={requestId:'req-1',deviceId:'mac',host:'a.test',policyVersion:4,seconds:60};
 for(const seconds of [29,1801,1.5])assert.throws(()=>redeemEarnedLeisure(state,{...request,seconds},NOW),/EARNED_REQUEST_INVALID/);
 assert.throws(()=>redeemEarnedLeisure(state,{...request,seconds:120},NOW),/EARNED_TIME_INSUFFICIENT/);
 const first=redeemEarnedLeisure(state,request,NOW);
 assert.equal(earnedBalance(state,NOW).availableSeconds,100,'input state is not mutated');
 assert.equal(earnedBalance(first.state,NOW).availableSeconds,40);
 const again=redeemEarnedLeisure(first.state,request,NOW+5000);
 assert.equal(again.replayed,true);assert.deepEqual(again.lease,first.lease);assert.equal(earnedBalance(again.state,NOW).availableSeconds,40,'replay never debits twice');
 assert.throws(()=>redeemEarnedLeisure(first.state,{...request,seconds:30},NOW),/EARNED_REQUEST_CONFLICT/);
 assert.deepEqual(leasePauseMessage(first.lease),{type:'site-pause',version:4,seconds:60,lease:{id:'req-1',host:'a.test',until:NOW+60000}});
 assert.equal(leaseStatus(first.lease,{host:'a.test',version:4,subdomains:false,purpose:''},NOW),'unapplied');
 assert.equal(leaseStatus(first.lease,{host:'a.test',version:5,subdomains:false,purpose:'',pausedUntil:NOW+60000,earnedLease:'req-1'},NOW),'applied');
 assert.equal(leaseStatus(first.lease,{host:'a.test',version:5,subdomains:false,purpose:''},NOW),'superseded');
 assert.equal(leaseStatus(first.lease,undefined,NOW+60000),'expired');
});

// Production worker bytes with a fake browser and controllable clock, as in portal-pause.test.ts.
const T0=1_000_000_000;
async function worker(){
 const source=(await readFile(new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8')).replace(/^(?:import|export) .*;\n/gm,'');
 const clock={now:T0},local:Record<string,any>={sitePolicy:{host:'a.test',subdomains:false,purpose:'study',version:1},sitePolicyRevision:1};
 let dynamic='a.test',fault='',persistent=false;const armed=new Map<string,number>();let listeners:Record<string,Function>={};const session:any={};
 const event=(name:string)=>({addListener:(fn:Function)=>listeners[name]=fn});
 const chrome:any={runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},permissions:{contains:async()=>true},
  storage:{local:{get:async()=>structuredClone(local),set:async(v:any)=>{if(!v.sitePolicy?.pending&&fault){if(!persistent)fault='';throw Error('commit');}Object.assign(local,structuredClone(v));},remove:async(k:string)=>{delete local[k];}},
   session:{get:async()=>structuredClone(session),set:async(v:any)=>Object.assign(session,structuredClone(v)),remove:async(k:string)=>{delete session[k];}},onChanged:event('storage')},
  declarativeNetRequest:{RuleActionType:{BLOCK:'block'},ResourceType:{MAIN_FRAME:'main_frame'},getSessionRules:async()=>[],updateSessionRules:async()=>{},
   updateDynamicRules:async(v:any)=>{dynamic=v.addRules?.length?'a.test':'';}},
  scripting:{unregisterContentScripts:async()=>{},registerContentScripts:async()=>{}},
  tabs:{remove:async()=>{},query:async()=>[],get:async(id:number)=>({id,url:'https://a.test/',incognito:false}),reload:async()=>{},sendMessage:async()=>{},update:async()=>{},onRemoved:event('removed'),onUpdated:event('updated')},
  alarms:{create:async(name:string,info:{when:number})=>{armed.set(name,info.when);},clear:async(name:string)=>{armed.delete(name);},onAlarm:event('alarm')}};
 const settleAll=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
 const boot=async()=>{listeners={};await runInNewContext(source+'\nready;',{chrome,Map,Set,WeakSet,URL,console,Date:{now:()=>clock.now}});await settleAll();};
 await boot();
 return {local,clock,armed,dynamic:()=>dynamic,fail:(keep=false)=>{fault='commit';persistent=keep;},restart:boot,
  fire:async()=>{listeners.alarm({name:'blocking-pause'});await settleAll();},
  send:(message:any)=>new Promise<any>(resolve=>listeners.message(message,{id:'test',url:'blocking.html'},resolve))};
}
const lease=(over:Record<string,unknown>={})=>({type:'site-pause',version:1,seconds:60,lease:{id:'req-1',host:'a.test',until:T0+45_000,...over}});

test('worker: a lease uses the existing pause, clamps to lease expiry, journals its ID and fails closed',async()=>{
 const w=await worker();
 for(const bad of [{until:T0},{host:'b.test'},{id:'bad id'},{until:'later'}]){
  const reply=await w.send(lease(bad));assert.equal(reply.ok,false,JSON.stringify(bad));assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.dynamic(),'a.test');
 }
 const reply=await w.send(lease());assert.equal(reply.ok,true,reply.error);
 assert.deepEqual(w.local.sitePolicy,{host:'a.test',subdomains:false,purpose:'study',version:2,pausedUntil:T0+45_000,earnedLease:'req-1'},'pause never outlives the lease');
 assert.equal(w.dynamic(),'');assert.equal(w.armed.get('blocking-pause'),T0+45_000);
 assert.equal((await w.send(lease())).ok,false,'replayed lease message is refused by version compare-and-set');
 w.armed.clear();await w.restart();assert.equal(w.armed.get('blocking-pause'),T0+45_000,'restart keeps the original deadline');
 w.clock.now=T0+45_000;await w.fire();
 assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.local.sitePolicy.earnedLease,undefined);assert.equal(w.dynamic(),'a.test');
 // Restart after the deadline with the browser closed re-blocks without an alarm.
 assert.equal((await w.send({...lease({id:'req-2',until:T0+100_000}),version:3})).ok,true);
 w.clock.now=T0+200_000;await w.restart();assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.dynamic(),'a.test');
 // A failed final save stays pending and the same deadline still binds.
 w.fail();const failed=await w.send({...lease({id:'req-3',until:T0+260_000}),version:w.local.sitePolicy.version});
 assert.equal(failed.ok,false);assert.equal((w.local.sitePolicy as any).pending.policy.pausedUntil,T0+260_000);
 w.clock.now=T0+260_000;await w.restart();assert.equal((w.local.sitePolicy as any).pending,undefined);assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.dynamic(),'a.test');
});


test('lease readback refuses pending journals and non-live or unbounded pauses',()=>{
 const l={requestId:'req-1',accountId:OWNER,deviceId:'mac',host:'a.test',policyVersion:1,seconds:60,issuedAt:T0,expiresAt:T0+60000};
 const p={host:'a.test',version:2,earnedLease:'req-1',pausedUntil:T0+60000};
 assert.notEqual(leaseStatus(l,{...p,pending:{policy:{host:'a.test',version:3},revision:3}},T0),'applied');
 for(const pausedUntil of [undefined,T0,T0+60001,Infinity,T0+0.5])assert.notEqual(leaseStatus(l,{...p,pausedUntil},T0),'applied');
 assert.equal(leaseStatus(l,p,T0+60000),'expired');
});
for(const operation of ['resume','expiry'])test(`worker failed ${operation} never reads an earned pause as applied`,async()=>{
 const w=await worker();await w.send(lease());w.fail(true);
 if(operation==='resume')await w.send({type:'site-resume',version:2});else {w.clock.now=T0+45000;await w.fire();}
 const status=await w.send({type:'blocking-status'});assert.equal(status.state,'pending');
 assert.equal(status.sitePolicy.earnedLease,'req-1');assert.equal(status.sitePolicy.pending.policy.pausedUntil,undefined);
 const l={requestId:'req-1',accountId:OWNER,deviceId:'mac',host:'a.test',policyVersion:1,seconds:60,issuedAt:T0,expiresAt:T0+60000};
 assert.notEqual(leaseStatus(l,status.sitePolicy,w.clock.now),'applied');
 const {deliverLease}=await import('../../browser-extension/blocking/earned.js');
 const outcome=await deliverLease({now:()=>w.clock.now,send:w.send,native:async()=>{throw Error('must not debit');}},l);
 assert.notEqual(outcome.state,'applied');
});
