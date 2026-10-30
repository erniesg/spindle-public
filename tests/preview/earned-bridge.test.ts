import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';
import {EarnedControl} from '../../core/preview/earned-control.js';
import {redeemEarned,checkRequest,deliverLease,type EarnedDeps} from '../../browser-extension/blocking/earned.js';
import type {EarnedLease} from '../../core/blocking/earned-time.js';
// Actual account HTTP server, encrypted TrackingClient and the production earned
// controller; the Chrome side is the production blocking worker bytes in a
// SCRIPTED chrome/DNR fixture. Invented activity only. Not native, installed or
// a real Chrome profile.
const study=(deviceId:string,start:number):Operation=>{const visitId=randomUUID();return {id:randomUUID(),deviceId,recordingId:'invented-study',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-study',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:start,monotonicAnchor:0,observedAt:45000,expiresAt:start+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:45000,coverage:'observed'},visit:{id:visitId,key:'invented-editor',app:'invented-editor',title:'Invented study',start:0,end:45000,clock:'owned-clock',revision:1,browser:false,text:'Reading an invented explanation of fractions.',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:start+3600000}}};};

async function account(){
 const dir=await mkdtemp(join(tmpdir(),'earned-bridge-')),originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 const server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));
 await client.signin('invented-leisure','invented-password-123','Invented Mac',true);
 const reader=new AccountClient(server.origin);await reader.signin('invented-leisure','invented-password-123');
 await reader.request('/processing',{local:true});
 return {dir,server,client,reader,advance:(ms:number)=>{now+=ms;},now:()=>now,
  async earn(){const deviceId=(await client.inspect()).deviceId,op=study(deviceId,now);now+=45000;await client.enqueue(op);await client.sync();
   await reader.request('/corrections',{key:recordKey(op),evidenceRevision:1,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}});},
  async close(){Date.now=originalNow;await server.close();await rm(dir,{recursive:true,force:true});}};
}

test('paired-profile earned grant is explicit, ephemeral, account-bound and never leaks session material',async()=>{
 const a=await account();let profile:string|undefined='profile-a',current:TrackingClient|undefined=a.client;
 try{
  const control=new EarnedControl(()=>profile,()=>current);
  assert.deepEqual(await control.extension({action:'read'},'profile-a'),{ok:false,code:'EARNED_ACCESS_REQUIRED'},'pairing alone is not account read consent');
  assert.equal(control.accessEnabled,false);
  // Local owner opt-in and read use the existing authenticated client.
  const off=await control.local('read');assert.equal(off.enabled,false);
  assert.equal((await control.local('opt-in',{enabled:true})).enabled,true);
  await a.earn();
  assert.equal((await control.local('read')).balance!.availableSeconds,45);
  profile=undefined;await assert.rejects(control.setAccess(true),/PROFILE_REQUIRED/);profile='profile-a';
  assert.deepEqual(await control.setAccess(true),{enabled:true});assert.equal(control.accessEnabled,true);
  assert.equal((await control.extension({action:'read'},'profile-b')).code,'EARNED_ACCESS_REQUIRED');
  const read=await control.extension({action:'read'},'profile-a');assert.equal(read.ok,true);
  const text=JSON.stringify(read);for(const secret of ['spindle_session','csrf','cookie','secret','password'])assert.ok(!text.toLowerCase().includes(secret),`reply carries no ${secret}`);
  // Extension may not choose a device, path or arbitrary action.
  for(const bad of [{action:'redeem',requestId:'r',host:'leisure.test',policyVersion:1,seconds:30,deviceId:'other'},{action:'opt-in',enabled:true},{action:'../devices'},{action:'redeem',requestId:'r',host:'leisure.test',policyVersion:1,seconds:29}])
   assert.equal((await control.extension(bad,'profile-a')).ok,false,JSON.stringify(bad));
  const requestId=randomUUID();
  const redeemed=await control.extension({action:'redeem',requestId,host:'leisure.test',policyVersion:3,seconds:30},'profile-a') as {ok:boolean;value:{lease:EarnedLease;replayed:boolean;balance:{availableSeconds:number}}};
  assert.equal(redeemed.ok,true);assert.deepEqual(Object.keys(redeemed.value.lease).sort(),['requestId','host','policyVersion','seconds','issuedAt','expiresAt'].sort(),'browser receives only enforcement fields');assert.equal(redeemed.value.balance.availableSeconds,15);
  const replay=await control.extension({action:'redeem',requestId,host:'leisure.test',policyVersion:3,seconds:30},'profile-a') as typeof redeemed;
  assert.equal(replay.value.replayed,true);assert.equal(replay.value.balance.availableSeconds,15,'same request never debits twice');
  assert.deepEqual(((await control.extension({action:'status',requestId},'profile-a')).value as {lease:EarnedLease}).lease,redeemed.value.lease);
  assert.equal((await control.extension({action:'status',requestId:randomUUID()},'profile-a')).code,'EARNED_LEASE_NOT_FOUND');
  assert.equal((await control.extension({action:'redeem',requestId:randomUUID(),host:'leisure.test',policyVersion:3,seconds:30},'profile-a')).code,'EARNED_REDEEM_REFUSED','insufficient balance is a definitive refusal');
  // Busy: one bridge request at a time; a concurrent one is refused before network.
  const first=control.extension({action:'read'},'profile-a');assert.equal((await control.extension({action:'read'},'profile-a')).code,'EARNED_BUSY');assert.equal((await first).ok,true);
  // Late replies are retired with the grant and never resurrect it.
  const late=control.extension({action:'read'},'profile-a');control.revoke();assert.equal((await late).code,'EARNED_RESPONSE_RETIRED');assert.equal(control.accessEnabled,false);
  assert.equal((await control.extension({action:'read'},'profile-a')).code,'EARNED_ACCESS_REQUIRED');
  // Re-pair (new profile) and account client replacement both retire access.
  await control.setAccess(true);profile='profile-c';assert.equal(control.accessEnabled,false);assert.equal((await control.extension({action:'read'},'profile-a')).code,'EARNED_ACCESS_REQUIRED');
  profile='profile-a';await control.setAccess(true);current=new TrackingClient(a.server.origin,join(a.dir,'other'),randomBytes(32));
  assert.equal((await control.extension({action:'read'},'profile-a')).code,'EARNED_ACCESS_REQUIRED');current=a.client;
  await control.setAccess(true);control.close();assert.equal((await control.extension({action:'read'},'profile-a')).code,'EARNED_ACCESS_REQUIRED');
  await assert.rejects(control.local('read'),/SIGNIN_REQUIRED/);
 }finally{await a.close();}
});

// Production blocking worker bytes with a scripted chrome/DNR (as earned-time.test.ts).
const T0=1_000_000_000;
async function worker(){
 const source=(await readFile(new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8')).replace(/^(?:import|export) .*;\n/gm,'');
 const clock={now:T0},local:Record<string,any>={sitePolicy:{host:'leisure.test',subdomains:false,purpose:'',version:3},sitePolicyRevision:3};
 let dynamic='leisure.test';const armed=new Map<string,number>();let listeners:Record<string,Function>={};const session:any={};
 const event=(name:string)=>({addListener:(fn:Function)=>listeners[name]=fn});
 const chrome:any={runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},permissions:{contains:async()=>true},
  storage:{local:{get:async()=>structuredClone(local),set:async(v:any)=>{Object.assign(local,structuredClone(v));},remove:async(k:string)=>{delete local[k];}},
   session:{get:async()=>structuredClone(session),set:async(v:any)=>Object.assign(session,structuredClone(v)),remove:async(k:string)=>{delete session[k];}},onChanged:event('storage')},
  declarativeNetRequest:{RuleActionType:{BLOCK:'block'},ResourceType:{MAIN_FRAME:'main_frame'},getSessionRules:async()=>[],updateSessionRules:async()=>{},updateDynamicRules:async(v:any)=>{dynamic=v.addRules?.length?'leisure.test':'';}},
  scripting:{unregisterContentScripts:async()=>{},registerContentScripts:async()=>{}},
  tabs:{remove:async()=>{},query:async()=>[],get:async(id:number)=>({id,url:'https://leisure.test/',incognito:false}),reload:async()=>{},sendMessage:async()=>{},update:async()=>{},onRemoved:event('removed'),onUpdated:event('updated')},
  alarms:{create:async(name:string,info:{when:number})=>{armed.set(name,info.when);},clear:async(name:string)=>{armed.delete(name);},onAlarm:event('alarm')}};
 const settleAll=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
 await runInNewContext(source+'\nready;',{chrome,Map,Set,WeakSet,URL,console,Date:{now:()=>clock.now}});await settleAll();
 return {local,clock,armed,dynamic:()=>dynamic,send:(message:any)=>new Promise<any>(resolve=>listeners.message!(message,{id:'test',url:'blocking.html'},resolve))};
}

test('Chrome page redeems through the bridge and claims only worker readback; unknown replies read the same request back',async()=>{
 const a=await account();
 try{
  const control=new EarnedControl(()=>'profile-a',()=>a.client);await control.local('opt-in',{enabled:true});await a.earn();await control.setAccess(true);
  const w=await worker();let drop=false,natives=0;
  const deps:EarnedDeps={now:()=>w.clock.now,send:message=>w.send(message),native:async data=>{natives++;const reply=await control.extension(data,'profile-a');if(drop&&data.action==='redeem'){drop=false;return {ok:false,code:'EARNED_BRIDGE_UNAVAILABLE'};}return reply as {ok:boolean;value?:unknown;code?:string};}};
  const status=await w.send({type:'blocking-status'});assert.equal(status.state,'active');
  // A lost redeem reply is read back by the same request ID and applied once.
  drop=true;const requestId=randomUUID();
  const outcome=await redeemEarned(deps,{host:'leisure.test',version:3},30,requestId);
  assert.equal(outcome.state,'applied',JSON.stringify(outcome));assert.equal(natives,2,'redeem + one status readback, no second redeem');
  assert.equal(w.local.sitePolicy.earnedLease,requestId);assert.equal(w.dynamic(),'','existing DNR journal lifted the block');
  assert.equal(w.local.sitePolicy.pausedUntil,T0+30_000,'pause is the existing 30–1800 s pause');
  assert.equal(((await control.local('read')).balance!).availableSeconds,15,'debited exactly once');
  // Re-checking an applied lease is idempotent and sends no second pause.
  const again=await checkRequest(deps,requestId);assert.equal(again.state,'applied');
  // Expiry restores the block through the worker's own alarm.
  w.clock.now=T0+30_000;await w.send({type:'blocking-status'});assert.equal(w.local.sitePolicy.earnedLease,undefined);assert.equal(w.dynamic(),'leisure.test');
  // A request that never reached the account is definitive: not debited.
  assert.deepEqual(await checkRequest(deps,randomUUID()),{state:'refused',code:'EARNED_NOT_DEBITED'});
  // Policy changed after the debit: the lease is superseded, not applied or refunded.
  const stale=(((await control.extension({action:'status',requestId},'profile-a')).value) as {lease:EarnedLease}).lease;
  assert.equal((await deliverLease(deps,stale)).state,'superseded');
  // Refusal from the account (balance) is definitive and does not read back.
  natives=0;assert.equal((await redeemEarned(deps,{host:'leisure.test',version:w.local.sitePolicy.version},30,randomUUID())).state,'refused');assert.equal(natives,1);
  // Revoked grant: the page receives a definitive access refusal.
  control.revoke();assert.deepEqual(await redeemEarned(deps,{host:'leisure.test',version:w.local.sitePolicy.version},30,randomUUID()),{state:'refused',code:'EARNED_ACCESS_REQUIRED'});
 }finally{await a.close();}
});

test('client validates known WorkOS account and own device before projecting a lease',async()=>{
 const a=await account(),originalFetch=globalThis.fetch;
 try{
  const response=await originalFetch(a.server.origin+'/signin',{method:'POST',headers:{Origin:a.server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-leisure',password:'invented-password-123'})});
  assert.equal(response.status,200);const {csrf}=await response.json() as {csrf:string},cookie=response.headers.get('set-cookie')!.split(';')[0]!;
  const session=await originalFetch(a.server.origin+'/session',{headers:{Origin:a.server.origin,Cookie:cookie}});
  const {account:identity}=await session.json() as {account:{id:string;name:string}};
  const client=new TrackingClient(a.server.origin,join(a.dir,'workos'),randomBytes(32));
  await client.signinWorkOSSession({account:identity,cookie,csrf},'Invented WorkOS');
  await client.earnedLeisure('opt-in',{enabled:true});await a.earn();
  const requestId=randomUUID();
  const reply=await client.earnedLeisure('redeem',{requestId,host:'leisure.test',policyVersion:3,seconds:30});
  let corrupt:'accountId'|'deviceId'|undefined;
  globalThis.fetch=async(...args)=>{
   const response=await originalFetch(...args);
   if(String(args[0]).endsWith('/earned-leisure/status')&&corrupt){
    const body=await response.json() as {lease:Record<string,unknown>};body.lease[corrupt]='foreign-binding';
    return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
   }return response;
  };
  for(const key of ['accountId','deviceId'] as const){
   corrupt=key;await assert.rejects(client.earnedLeisure('status',{requestId}),/EARNED_RESULT_UNKNOWN/,key+' mismatch is rejected before projection');
  }
  assert.deepEqual(Object.keys(reply.lease!).sort(),['requestId','host','policyVersion','seconds','issuedAt','expiresAt'].sort());
  corrupt=undefined;assert.deepEqual((await client.earnedLeisure('status',{requestId})).lease,reply.lease);
 }finally{globalThis.fetch=originalFetch;await a.close();}
});
