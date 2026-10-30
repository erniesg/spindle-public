import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {PreviewWorkOSControl} from '../../core/preview/workos-control.js';
import {PreviewSettingsStore,type PreviewSettings,type WorkOSCleanupLease,validateWorkOSCleanupLeases} from '../../core/preview/settings.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import type {DesktopWorkOSCallback} from '../../core/account/workos-desktop.js';
const callbackValue={code:'invented-code',codeVerifier:'invented-verifier',redirectUri:'http://127.0.0.1:43168/auth/callback'};
for(const stage of ['after-exchange','after-tracking-promotion','success'] as const)test(`encrypted native cleanup survives restart ${stage}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-preview-cleanup-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const store=new PreviewSettingsStore(join(dir,'settings'));let saved:PreviewSettings={schema:'spindle-preview-settings/v1',profileToken:null,preferences:null};
 const issue=async(register=false)=>{const response=await fetch(server.origin+(register?'/register':'/signin'),{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-durable',password:'invented-durable-password'})});assert.equal(response.status,200);const {csrf}=await response.json(),cookie=response.headers.get('set-cookie')!.split(';')[0];const current=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});const {account}=await current.json();return {account,cookie,csrf};};
 const status=async(cookie:string)=>{const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});await response.body?.cancel();return response.status;};
 let accept!:(value:DesktopWorkOSCallback)=>void;const callback=new Promise<DesktopWorkOSCallback>(r=>accept=r);
 let control:PreviewWorkOSControl|undefined;
 try{
  await store.write(saved,key);const tracking=await issue(true),timer=await issue(),credentials={account:tracking.account,tracking,timer};
  const persistCleanup=async(leases:readonly WorkOSCleanupLease[])=>{saved={...saved,workosCleanup:structuredClone([...leases])};await store.write(saved,key);};
  control=new PreviewWorkOSControl({persistCleanup,transport:async input=>String(input).endsWith('/config')?Response.json({configured:true,clientId:'client_invented',backendOrigin:server.origin}):Response.json(credentials),start:async()=>({authorizationUrl:'https://api.workos.com/user_management/authorize',callback,cancel:async()=>{}}),revoke:async()=>{throw Error('OFFLINE');},adopt:async()=>{
   const durable=await new PreviewSettingsStore(join(dir,'settings')).read(key);assert.equal(durable.workosCleanup?.length,2,'both credentials must be encrypted before adoption starts');
   if(stage==='after-exchange')throw Error('CRASH_AFTER_EXCHANGE');
   const client=new TrackingClient(server.origin,join(dir,'tracking'),key);await client.signinWorkOSSession(tracking,'Invented device');await client.settle();
   if(stage==='after-tracking-promotion')throw Error('PARENT_SETTINGS_COMMIT_FAILED');
   saved={...saved,tracking:{origin:server.origin,name:tracking.account.name,deviceName:'Invented device'},timerOrigin:server.origin};await store.write(saved,key);
  }});
  await control.begin({origin:server.origin,deviceName:'Invented device',syncConsent:true},()=>{});accept(callbackValue);
  for(let i=0;i<100&&control.status().state==='waiting';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(await status(tracking.cookie),200);assert.equal(await status(timer.cookie),200);
  const restored=await new PreviewSettingsStore(join(dir,'settings')).read(key),ciphertext=await readFile(join(dir,'settings','context.enc'));
  assert.ok(!ciphertext.includes(Buffer.from(timer.cookie)));assert.ok(!ciphertext.includes(Buffer.from(tracking.cookie)));
  if(stage==='success'){
   assert.equal(control.status().state,'connected');assert.equal(restored.workosCleanup?.length,1,'timer revocation authority remains encrypted while owned in memory');assert.equal(restored.workosCleanup?.[0].owned,true);
   const restarted=new PreviewWorkOSControl({persistCleanup,adopt:async()=>assert.fail('restart must not adopt'),revoke:async(origin,session)=>new AccountClient(origin).revokeWorkOSSession(session)});restarted.restoreCleanup(restored.workosCleanup!);await restarted.retryCleanup();assert.equal(await status(tracking.cookie),200,'durably owned tracking remains valid');assert.equal(await status(timer.cookie),401,'memory-only timer is revoked after restart');await restarted.close();
  }else{
   assert.equal(control.status().code,'WORKOS_REVOCATION_PENDING');assert.equal(restored.workosCleanup?.length,2);
   const restarted=new PreviewWorkOSControl({persistCleanup,adopt:async()=>assert.fail('recovery must not adopt'),revoke:async(origin,session)=>new AccountClient(origin).revokeWorkOSSession(session)});
   restarted.restoreCleanup(restored.workosCleanup!);assert.equal(restarted.status().code,'WORKOS_REVOCATION_PENDING');
   assert.ok(!JSON.stringify(restarted.status()).includes('spindle_session'));await restarted.retryCleanup();
   assert.equal(await status(tracking.cookie),401);assert.equal(await status(timer.cookie),401);assert.equal((await store.read(key)).workosCleanup?.length,0);await restarted.close();
  }
 }finally{await server.close();await store.settle();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

test('encrypted cleanup schema bounds origins, client, session and ownership metadata',()=>{
 const lease={origin:'https://invented.example',clientId:'client_invented',role:'timer' as const,session:{account:{id:'12345678-1234-1234-1234-123456789abc',name:'invented'},cookie:'spindle_session='+'a'.repeat(64),csrf:'b'.repeat(64)}};
 validateWorkOSCleanupLeases([lease]);
 for(const bad of [[...Array(9)].map(()=>lease),[lease,lease],[{...lease,origin:'http://evil.example'}],[{...lease,clientId:'invalid'}],[{...lease,owned:false}],[{...lease,role:'tracking',owned:true}],[{...lease,extra:true}],[{...lease,session:{...lease.session,cookie:'bad'}}]])assert.throws(()=>validateWorkOSCleanupLeases(bad));
});

for(const direction of ['backward','forward'] as const)test(`settings clock ${direction} preserves encrypted cleanup authority across restart`,async()=>{
 const {mock}=await import('node:test');const dir=await mkdtemp(join(tmpdir(),'spindle-cleanup-clock-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),settingsPath=join(dir,'settings');
 const realNow=Date.now,at=realNow();let shifted:ReturnType<typeof mock.method>|undefined;
 const issue=async(register=false)=>{const response=await fetch(server.origin+(register?'/register':'/signin'),{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-clock',password:'invented-clock-password'})});assert.equal(response.status,200);const {csrf}=await response.json(),cookie=response.headers.get('set-cookie')!.split(';')[0],current=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}}),{account}=await current.json();return {account,cookie,csrf};};
 const status=async(cookie:string)=>{const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});await response.body?.cancel();return response.status;};
 try{
  const tracking=await issue(true),timer=await issue(),leases:WorkOSCleanupLease[]=[{origin:server.origin,clientId:'client_invented',role:'tracking',session:tracking},{origin:server.origin,clientId:'client_invented',role:'timer',session:timer}];
  shifted=mock.method(Date,'now',()=>at);await new PreviewSettingsStore(settingsPath).write({schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,workosCleanup:leases},key);shifted.mock.restore();
  const before=await readFile(join(settingsPath,'context.enc'));
  shifted=mock.method(Date,'now',()=>direction==='backward'?at-1:at+11*365*86400000);
  await assert.rejects(new PreviewSettingsStore(settingsPath).read(key),/STORE_CLOCK_ANOMALY/);await assert.rejects(new PreviewSettingsStore(settingsPath).write({schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,workosCleanup:[]},key),/STORE_CLOCK_ANOMALY/);assert.deepEqual(await readFile(join(settingsPath,'context.enc')),before,'a local clock anomaly must never erase the only cleanup journal');shifted.mock.restore();
  assert.equal(await status(tracking.cookie),200);assert.equal(await status(timer.cookie),200);
  const wrongKey=randomBytes(32);await assert.rejects(new PreviewSettingsStore(settingsPath).read(wrongKey),/STORE_UNREADABLE/);await assert.rejects(new PreviewSettingsStore(settingsPath).write({schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,workosCleanup:[]},wrongKey),/STORE_UNREADABLE/);wrongKey.fill(0);assert.deepEqual(await readFile(join(settingsPath,'context.enc')),before);
  let restored=await new PreviewSettingsStore(settingsPath).read(key),offline=true;
  const restarted=new PreviewWorkOSControl({persistCleanup:async pending=>{restored={...restored,workosCleanup:structuredClone([...pending])};await new PreviewSettingsStore(settingsPath).write(restored,key);},adopt:async()=>assert.fail('clock recovery never restores authentication/grants'),revoke:async(origin,session)=>{if(offline)throw Error('OFFLINE');await new AccountClient(origin).revokeWorkOSSession(session);}});
  restarted.restoreCleanup(restored.workosCleanup!);await assert.rejects(restarted.retryCleanup(),/WORKOS_REVOCATION_PENDING/);assert.equal(restarted.status().state,'failed');assert.equal((await new PreviewSettingsStore(settingsPath).read(key)).workosCleanup?.length,2);
  assert.equal(restored.profileToken,null);assert.equal(restored.preferences,null);assert.ok(!JSON.stringify(restarted.status()).includes('spindle_session'));
  offline=false;await restarted.retryCleanup();assert.equal(await status(tracking.cookie),401);assert.equal(await status(timer.cookie),401);await restarted.close();
 }finally{shifted?.mock.restore();await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
for(const delta of [-1,1001])test(`default capture Vault still erases a ${delta<0?'backward clock':'TTL expiry'} snapshot`,async()=>{
 const {Vault}=await import('../../core/preview/vault.js'),dir=await mkdtemp(join(tmpdir(),'spindle-capture-clock-')),key=randomBytes(32);let time=10000;
 try{const vault=new Vault(dir,()=>time);await vault.write({invented:'capture'},key,1000,()=>true);time+=delta;assert.equal(await vault.read(key),null);await assert.rejects(readFile(join(dir,'context.enc')),{code:'ENOENT'});}finally{key.fill(0);await rm(dir,{recursive:true,force:true});}
});
for(const later of ['backward','forward'] as const)test(`settings read uses one coherent clock sample before a ${later} clock step`,async()=>{
 const {mock}=await import('node:test'),dir=await mkdtemp(join(tmpdir(),'spindle-clock-step-')),key=randomBytes(32),at=Date.now();let shifted:ReturnType<typeof mock.method>|undefined,calls=0;
 const value:PreviewSettings={schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,workosCleanup:[]};
 try{
  shifted=mock.method(Date,'now',()=>at);await new PreviewSettingsStore(dir).write(value,key);shifted.mock.restore();const before=await readFile(join(dir,'context.enc'));
  shifted=mock.method(Date,'now',()=>++calls===1?at:later==='backward'?at-1:at+11*365*86400000);
  assert.deepEqual(await new PreviewSettingsStore(dir).read(key),value,'read is authorized only at its single sampled instant');assert.equal(calls,1,'a later wall-clock value cannot enter an erase fallback');assert.deepEqual(await readFile(join(dir,'context.enc')),before);
 }finally{shifted?.mock.restore();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
for(const later of ['backward','forward'] as const)test(`settings replacement validates and creates at one instant before a ${later} clock step`,async()=>{
 const {mock}=await import('node:test'),dir=await mkdtemp(join(tmpdir(),'spindle-clock-write-step-')),key=randomBytes(32),at=Date.now();let shifted:ReturnType<typeof mock.method>|undefined,calls=0;
 const value:PreviewSettings={schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,workosCleanup:[]};
 try{
  shifted=mock.method(Date,'now',()=>at);await new PreviewSettingsStore(dir).write(value,key);shifted.mock.restore();
  shifted=mock.method(Date,'now',()=>++calls===1?at:later==='backward'?at-1:at+11*365*86400000);
  await new PreviewSettingsStore(dir).write(value,key);assert.equal(calls,1,'validation and replacement header must share the same instant');shifted.mock.restore();assert.deepEqual(await new PreviewSettingsStore(dir).read(key),value);
 }finally{shifted?.mock.restore();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
