// Actual preview HTTP/settings/collector wiring on Linux with a SIMULATED Mac
// key/ready protocol peer. Never calls native capture APIs or an OS credential
// store; not native/installed acceptance. The fake HOME and all output are owned.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generatePreviewPdf} from '../../tools/generate-preview-pdf.js';
import {randomBytes} from 'node:crypto';
import {connect} from 'node:net';
import {Server} from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PreviewStoreOwner} from '../../core/preview/tracking-setup.js';
import {PreviewSettingsStore} from '../../core/preview/settings.js';
import {runPreview} from '../../core/preview/app.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {EncryptedStore} from '../../core/tracking/store.js';
test('production preview restores protected service/device setup paused without reenrollment or timer regrant', {skip:process.platform!=='linux'},async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/preview-setup-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform')!,originalHome=process.env.HOME,originalLog=console.log,originalCwd=process.cwd(),originalGlobalFetch=globalThis.fetch;
 let runtime:Awaited<ReturnType<typeof runPreview>>|undefined,url='',samplePdf='',generatedSamplePdf=false;
 try{
  const root=join(dir,'root');await mkdir(join(root,'runtime'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"commonjs"}');
  const helper=join(root,'runtime/SpindlePreview'),key=randomBytes(32).toString('base64');
  await writeFile(helper,`#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});const send=x=>console.log(JSON.stringify({schema:'spindle-native-preview/v1',...x}));send({kind:'ready',permission:true});rl.on('line',line=>{const v=JSON.parse(line);require('node:fs').appendFileSync('${root}/commands',v.action+'\\n');if(v.action==='key'){let kind='key';try{kind=require('node:fs').readFileSync('${root}/event','utf8');}catch{}send(kind==='locked'?{kind:'locked'}:{kind:'key',value:'${key}'});}if(v.action==='start'){const epoch=v.epoch,base=epoch*10000;send({kind:'activity',epoch,at:base,inputAgeBucket:'under-15s'});send({kind:'focus',epoch,at:base,revision:1,key:'invented/editor',app:'Invented Editor',title:'Invented visit',clock:'invented-boot'});send({kind:'sample',epoch,at:base+10,revision:1,text:'Invented text',textSource:'native',status:'native-text'});send({kind:'focus',epoch,at:base+1000,revision:2,key:'invented/document',app:'Invented Document',title:'Invented document',clock:'invented-boot'});}if(v.action==='quit')process.exit(0);});\n`,{mode:0o700});
  // Linux Unix socket names have a short byte limit. A run-owned cwd/relative
  // fake HOME keeps this simulated peer below it; never change the real HOME.
  process.chdir(dir);process.env.HOME='.';Object.defineProperty(process,'platform',{value:'darwin'});
  console.log=(...values:unknown[])=>{const line=String(values[0]);if(line.startsWith('Spindle PREVIEW: '))url=line.slice('Spindle PREVIEW: '.length);else originalLog(...values);};
  const start=async()=>{runtime=await runPreview(root,undefined,{noOpen:true});assert.ok(url);};
  const request=async(path:string,body?:unknown)=>{
   const parsed=new URL(url),response=await fetch(parsed.origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+parsed.hash.slice(1),Origin:parsed.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {status:response.status,value:await response.json()};
  };
  const ready=async()=>{for(let n=0;n<100;n++){const r=await request('/state');if(r.value.settingsReady)return r.value;await new Promise(r=>setTimeout(r,10));}throw Error('SETTINGS_TIMEOUT');};
  await start();assert.equal((await ready()).recording,false);
  const sampleRequest=async(path:string)=>{const parsed=new URL(url);return fetch(parsed.origin+path,{headers:{Origin:parsed.origin}});};
  for(const page of ['a','b']){const response=await sampleRequest('/sample/'+page);assert.equal(response.status,200);const body=await response.text();assert.match(body,/id="counter"/);assert.match(body,/sample-counter.js/);}
  const rich=await sampleRequest('/sample/rich');assert.equal(rich.status,200);const richBody=await rich.text();assert.doesNotMatch(richBody,/id="counter"|sample-counter.js/);assert.match(richBody,/SPINDLE SAMPLE rich/);
  samplePdf=join(dirname(fileURLToPath(import.meta.url)),'../../core/preview/sample.pdf');try{await readFile(samplePdf);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await generatePreviewPdf(samplePdf);generatedSamplePdf=true;}
  const pdf=await sampleRequest('/sample/pdf');assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await pdf.arrayBuffer()).subarray(0,5),Buffer.from('%PDF-'));
  const setup={origin:server.origin,name:'invented-preview-setup',deviceName:'Invented native peer',password:'invented-password-123',register:true};
  // Interrupt first enrollment while the server has replied but the client has
  // not committed it. Key recovery must not expose ready settings or open a
  // second store owner until that control operation has drained.
  const originalFetch=globalThis.fetch;let release=()=>{},entered=()=>{};
  const held=new Promise<void>(r=>{release=r;}),atBind=new Promise<void>(r=>{entered=r;});
  globalThis.fetch=async(input,init)=>{const response=await originalFetch(input,init);if(String(input)===server.origin+'/devices'&&init?.method==='POST'){entered();await held;}return response;};
  let interrupted:ReturnType<typeof request>|undefined;
  try{
   interrupted=request('/tracking/signin',setup);await atBind;
   assert.equal((await request('/key',{})).status,200);
   for(let n=0;n<100;n++){if(!(await request('/state')).value.settingsReady)break;await new Promise(r=>setTimeout(r,10));}
   await new Promise(r=>setTimeout(r,100));
   assert.equal((await request('/state')).value.settingsReady,false,'key recovery must wait for in-flight enrollment');
  }finally{release();await interrupted;globalThis.fetch=originalFetch;}
  assert.equal((await interrupted!).status,409);await ready();
  assert.equal((await request('/tracking/signin',{...setup,register:false})).status,200);
  // The automatic two-second sync must retire only its own stale outage code
  // after a confirmed current success. A later key status remains authoritative.
  const waitForState=async(predicate:(state:any)=>boolean,description:string)=>{
   for(let n=0;n<350;n++){const state=(await request('/state')).value;if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,20));}
   throw Error('AUTOMATIC_SYNC_'+description);
  };
  const automaticFetch=globalThis.fetch;let automaticOffline=true;
  globalThis.fetch=async(input,init)=>{
   const target=String(input);
   if(automaticOffline&&target.startsWith(server.origin+'/history?'))throw Error('INVENTED_AUTOMATIC_OFFLINE');
   return automaticFetch(input,init);
  };
  try{
   await waitForState(state=>state.lastCode==='HISTORY_OFFLINE_OR_SIGNIN_REQUIRED','OUTAGE_NOT_REPORTED');
   automaticOffline=false;
   await waitForState(state=>state.lastCode==='IDLE','RECOVERY_CODE_NOT_RETIRED');
   automaticOffline=true;
   await waitForState(state=>state.lastCode==='HISTORY_OFFLINE_OR_SIGNIN_REQUIRED','SECOND_OUTAGE_NOT_REPORTED');
   assert.equal((await request('/key',{})).status,200);await ready();
   assert.equal((await request('/state')).value.lastCode,'KEY_READY','later key status must replace the old outage marker');
   automaticOffline=false;
   await new Promise(resolve=>setTimeout(resolve,2200));
   assert.equal((await request('/state')).value.lastCode,'KEY_READY','recovered automatic sync must not clear a later unrelated status');
  }finally{globalThis.fetch=automaticFetch;}
  // Pause must cancel a Start admitted behind actual sync, before acquisition,
  // retention or upload can be enabled. Observe admission without changing the
  // queue; hold only the real history response (success and transport failure).
  const scope=new AsyncLocalStorage<string>(),originalEmit=Server.prototype.emit,originalRun=PreviewStoreOwner.prototype.run;
  let admitted=()=>{};
  Server.prototype.emit=function(event:string,...args:unknown[]){
   if(event==='request')return scope.run((args[0] as {url:string}).url,()=>Reflect.apply(originalEmit,this,[event,...args]));
   return Reflect.apply(originalEmit,this,[event,...args]);
  };
  try{
   for(const failure of [false,true]){
    let releaseHistory=()=>{},enteredHistory=()=>{},hold=true;
    const heldHistory=new Promise<void>(r=>{releaseHistory=r;}),atHistory=new Promise<void>(r=>{enteredHistory=r;}),atStart=new Promise<void>(r=>{admitted=r;});
    PreviewStoreOwner.prototype.run=function<T>(operation:(check:()=>void)=>Promise<T>){if(scope.getStore()==='/start')admitted();return originalRun.call(this,operation) as Promise<T>;};
    const savedFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{const response=await savedFetch(input,init);if(hold&&String(input).startsWith(server.origin+'/history?')){hold=false;enteredHistory();await heldHistory;if(failure)return new Response('{}',{status:503});}return response;};
    let syncing:ReturnType<typeof request>|undefined,starting:ReturnType<typeof request>|undefined;
    const helperStarts=async()=>(await readFile(join(root,'commands'),'utf8')).split('\n').filter(v=>v==='start').length;
    const startsBefore=await helperStarts(),preferencesBefore=(await request('/state')).value.preferences;
    try{
     syncing=request('/tracking/sync',{});await atHistory;
     starting=request('/start',{apps:['invented.editor'],pixels:true,rich:true,retain:true,upload:true,retentionMs:3600000});await atStart;
     assert.equal(await helperStarts(),startsBefore,'Start is still pending, not already acquiring');
     assert.equal((await request('/pause',{})).status,200);assert.equal((await request('/state')).value.recording,false);
     releaseHistory();assert.equal((await syncing).status,failure?409:200,'Pause must not invalidate unrelated sync');
     const startResult=await starting,state=(await request('/state')).value;
     assert.equal(state.recording,false,'Pause must invalidate the admitted Start after sync release');
     assert.equal(startResult.status,409);assert.equal(await helperStarts(),startsBefore,'cancelled pending Start must never acquire');
     assert.deepEqual(state.preferences,preferencesBefore,'cancelled Start must not enable retention');
     assert.equal((await request('/tracking/status')).value.historyStatus,'disabled');
     // A deliberate later Start remains usable; it is not cancelled by old Pause.
     assert.equal((await request('/start',{apps:['invented.editor'],pixels:false,rich:false,retain:false,upload:false})).status,200);
     for(let n=0;n<100&&await helperStarts()===startsBefore;n++)await new Promise(r=>setTimeout(r,10));
     assert.equal(await helperStarts(),startsBefore+1);assert.equal((await request('/state')).value.recording,true);
     assert.equal((await request('/pause',{})).status,200);assert.equal((await request('/state')).value.recording,false);
     console.log('Pause intent regression:',failure?'failed history response':'successful history response','cancelled pending Start; later Start and Pause passed');
    }finally{releaseHistory();await Promise.allSettled([syncing,starting].filter(v=>v!==undefined));globalThis.fetch=savedFetch;await request('/pause',{});}
   }
  }finally{Server.prototype.emit=originalEmit;PreviewStoreOwner.prototype.run=originalRun;}
  assert.equal((await request('/clear',{})).status,200);
  const before=(await request('/tracking/status')).value;assert.ok(before.client.deviceId);assert.equal('entries'in before.client,false);assert.equal(before.client.pending,0);
  assert.equal((await request('/pomodoro/signin',{origin:server.origin,name:setup.name,password:setup.password})).status,200);
  assert.equal((await request('/state')).value.timerOrigin,server.origin);
  await runtime!.close();runtime=undefined;url='';await start();const state=await ready();
  assert.equal(state.recording,false);assert.equal(state.pomodoroAccess,false);assert.equal(state.timerOrigin,server.origin);
  const after=(await request('/tracking/status')).value;assert.deepEqual(after.setup,{origin:setup.origin,name:setup.name,deviceName:setup.deviceName});assert.equal(after.client.deviceId,before.client.deviceId);assert.equal(after.client.pending,0);
  assert.equal((await request('/tracking/devices')).value.devices.length,1);
  assert.equal((await request('/pomodoro/session',{})).status,401,'timer credentials must not be restored');
  assert.equal((await request('/tracking/signin',{...setup,name:'invented-other',register:false})).value.code,'ACCOUNT_SWITCH_REQUIRES_NEW_STORE');
  assert.equal((await request('/tracking/status')).value.client.deviceId,before.client.deviceId);
  assert.equal((await request('/tracking/signin',{...setup,origin:'https://other.example',register:false})).value.code,'CLIENT_IDENTITY_MISMATCH');
  assert.equal((await request('/tracking/status')).value.setup.origin,server.origin);
  // Reviewer P1 causal trace: hold an unpublished reopen's inspect transaction
  // AFTER loading the old whole-store state but BEFORE its write. A later key
  // response must not open another owner and sync ahead of that stale write.
  const originalTransaction=EncryptedStore.prototype.transaction;
  let releaseInspect=()=>{},enteredInspect=()=>{},holdInspect=true,accountAdmissions=0;
  const heldInspect=new Promise<void>(r=>{releaseInspect=r;}),atInspect=new Promise<void>(r=>{enteredInspect=r;});
  EncryptedStore.prototype.transaction=function<R>(this:EncryptedStore<unknown>,fn:(state:unknown)=>R|Promise<R>,write?:boolean):Promise<R>{if(this.directory.endsWith('/account'))accountAdmissions++;return originalTransaction.call(this,async state=>{const result=await fn(state);if(holdInspect&&this.directory.endsWith('/account')){holdInspect=false;enteredInspect();await heldInspect;}return result;},write) as Promise<R>;};
  let newerSync:number|null=null,readyWhileHeld=false,admissionsWhileHeld=0;
  try{
   await request('/key',{});await atInspect;await request('/key',{});await new Promise(r=>setTimeout(r,150));
   readyWhileHeld=(await request('/state')).value.settingsReady;
   if(readyWhileHeld){assert.equal((await request('/tracking/sync',{})).status,200);newerSync=(await request('/tracking/status')).value.client.lastSync;assert.ok(newerSync);}
   assert.equal((await request('/clear',{})).status,409);assert.equal((await request('/restore',{})).status,409);assert.equal((await request('/start',{})).status,409);assert.equal((await request('/tracking/devices')).status,409);
   admissionsWhileHeld=accountAdmissions;
  }finally{releaseInspect();EncryptedStore.prototype.transaction=originalTransaction;}
  await ready();await new Promise(r=>setTimeout(r,100));
  const afterStale=(await request('/tracking/status')).value.client;
  if(newerSync!==null)assert.equal(afterStale.lastSync,newerSync,'retired inspect overwrote newer lastSync with null (reviewer P1)');
  assert.equal(readyWhileHeld,false,'replacement cannot be admitted before unpublished inspect drains');
  assert.equal(admissionsWhileHeld,1,'no replacement transaction can enter while the retired opener owns the store');
  assert.equal((await request('/tracking/sync',{})).status,200);
  assert.ok((await request('/tracking/status')).value.client.lastSync);
  // Real preview Start -> simulated source messages -> production collector ->
  // encrypted queue. Keep transport offline to prove refresh preserves puts and
  // explicit deletion intent, rather than merely recreating an empty client.
  const transportFetch=globalThis.fetch;let offline=true;
  globalThis.fetch=async(input,init)=>{if(offline&&String(input).startsWith(server.origin)&&/\/(sync|history)(\?|$)/.test(new URL(String(input)).pathname+new URL(String(input)).search))throw Error('INVENTED_OFFLINE');return transportFetch(input,init);};
  const refresh=async()=>{await request('/key',{});await new Promise(r=>setTimeout(r,75));await ready();};
  try{
   assert.equal((await request('/start',{apps:['invented.editor'],pixels:false,rich:false,retain:true,upload:true,retentionMs:3600000})).status,200);
   await new Promise(r=>setTimeout(r,100));await request('/pause',{});
   const queued=(await request('/tracking/status')).value.client;assert.equal(queued.pending,2);
   for(let i=0;i<3;i++){await refresh();const state=(await request('/tracking/status')).value.client;assert.equal(state.pending,2);assert.equal(state.cursor,queued.cursor);assert.equal(state.lastSync,queued.lastSync);assert.equal(state.deviceId,before.client.deviceId);assert.equal((await request('/state')).value.recording,false);}
   offline=false;assert.equal((await request('/tracking/sync',{})).status,200);
   const synced=(await request('/tracking')).value.client;assert.equal(synced.pending,0);assert.equal(synced.entries.length,2);assert.ok(synced.cursor>queued.cursor);assert.ok(synced.lastSync);
   // Hold a live sync across key invalidation: it may commit its admitted work,
   // but cannot publish success or overlap the replacement client.
   let releaseSync=()=>{},enteredSync=()=>{};const heldSync=new Promise<void>(r=>{releaseSync=r;}),atSync=new Promise<void>(r=>{enteredSync=r;});
   globalThis.fetch=async(input,init)=>{const response=await transportFetch(input,init);if(String(input).startsWith(server.origin+'/history?')){enteredSync();await heldSync;}return response;};
   const syncing=request('/tracking/sync',{});await atSync;await request('/key',{});await new Promise(r=>setTimeout(r,75));
   assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/tracking/sync',{})).status,409);assert.equal((await request('/tracking/signin',{...setup,register:false})).status,409);
   releaseSync();assert.equal((await syncing).status,409);globalThis.fetch=transportFetch;await ready();
   const concurrent=(await request('/tracking/status')).value.client;assert.ok(concurrent.lastSync>=synced.lastSync);assert.equal(concurrent.cursor,synced.cursor);
   offline=true;globalThis.fetch=async(input,init)=>{if(offline&&String(input).startsWith(server.origin))throw Error('INVENTED_OFFLINE');return transportFetch(input,init);};
   assert.equal((await request('/clear',{})).status,200);const deleting=(await request('/tracking/status')).value.client;assert.equal(deleting.pending,2);
   for(let i=0;i<3;i++){await refresh();const state=(await request('/tracking')).value.client;assert.equal(state.pending,2);assert.equal(state.cursor,deleting.cursor);assert.equal(state.lastSync,deleting.lastSync);assert.ok(state.entries.every((e:{deleted:boolean})=>e.deleted));}
   offline=false;assert.equal((await request('/tracking/sync',{})).status,200);await refresh();
   const deleted=(await request('/tracking')).value.client;assert.equal(deleted.pending,0);assert.ok(deleted.cursor>deleting.cursor);assert.ok(deleted.entries.every((e:{deleted:boolean})=>e.deleted));
   await runtime!.close();runtime=undefined;url='';await start();await ready();
   const restarted=(await request('/tracking')).value.client;assert.equal(restarted.deviceId,before.client.deviceId);assert.equal(restarted.pending,0);assert.equal(restarted.cursor,deleted.cursor);assert.equal(restarted.lastSync,deleted.lastSync);assert.deepEqual(restarted.entries,deleted.entries);
  }finally{globalThis.fetch=transportFetch;}
  // Browser revocation owns both its settings receipt and the account erase.
  // A key refresh must drain the entire unpublished receipt/erase operation.
  const connection=JSON.parse(await readFile('Library/Application Support/SpindlePreview/connection.json','utf8'));
  const ipc=async(message:Record<string,unknown>)=>new Promise<Record<string,unknown>>((resolve,reject)=>{const socket=connect(connection.ipcPath);let raw='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({schema:'spindle-browser-preview/v1',secret:connection.secret,...message})+'\n'));socket.on('data',chunk=>{raw+=chunk;if(raw.includes('\n')){socket.end();resolve(JSON.parse(raw.split('\n')[0]!));}});socket.on('end',()=>{if(!raw)reject(Error('IPC_NO_REPLY'));});});
  assert.equal((await request('/start',{apps:['invented.editor'],pixels:false,rich:false,retain:true,upload:true,retentionMs:3600000})).status,200);
  await new Promise(r=>setTimeout(r,100));await request('/pause',{});assert.equal((await request('/tracking/sync',{})).status,200);
  const recoveryFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{if(String(input).startsWith(server.origin))throw Error('INVENTED_OFFLINE');return recoveryFetch(input,init);};
  assert.equal((await request('/start',{apps:['invented.editor'],pixels:false,rich:false,retain:true,upload:true,retentionMs:3600000})).status,200);
  await new Promise(r=>setTimeout(r,100));await request('/pause',{});
  const pairing=await ipc({kind:'pair',code:(await request('/state')).value.pair});assert.equal(pairing.ok,true);
  // Grant timer access to the old profile so recovery proves revocation,
  // rather than merely observing its default-off state.
  globalThis.fetch=recoveryFetch;
  const timerIdentity=(await request('/pomodoro/signin',{origin:server.origin,name:setup.name,password:setup.password})).value;
  assert.equal((await request('/pomodoro/access',{binding:timerIdentity.binding,enabled:true})).status,200);
  assert.equal((await request('/state')).value.pomodoroAccess,true);
  globalThis.fetch=async(input,init)=>{if(String(input).startsWith(server.origin))throw Error('INVENTED_OFFLINE');return recoveryFetch(input,init);};
  // Local app recovery rotates only pairing; the retained account and vault stay.
  const preserved=(await request('/tracking')).value,localBefore=(await request('/restore',{})).value.saved;
  preserved.historyStatus='disabled';assert.ok(preserved.client.pending>0);assert.ok(preserved.client.entries.some((e:{deleted:boolean})=>!e.deleted));assert.ok(localBefore);
  const oldPair=pairing.profileToken,oldCode=(await request('/state')).value.pair;
  const appUrl=new URL(url);
  for(const headers of [{Origin:appUrl.origin,'Content-Type':'application/json'},{Authorization:'Bearer '+appUrl.hash.slice(1),'Content-Type':'application/json'},{Authorization:'Bearer '+appUrl.hash.slice(1),Origin:appUrl.origin,'Content-Type':'text/plain'}]){
   const denied=await fetch(appUrl.origin+'/chrome/replace-pairing',{method:'POST',headers:headers as Record<string,string>,body:'{}'});assert.ok([401,403].includes(denied.status));
  }
  const waitFor=async<T>(promise:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('RECOVERY_TEST_TIMEOUT')),5000);})]);}finally{clearTimeout(timer);}};
  const originalWrite=PreviewSettingsStore.prototype.write;let releaseReplace=()=>{},enteredReplace=()=>{},holdReplace=true;
  const heldReplace=new Promise<void>(r=>{releaseReplace=r;}),atReplace=new Promise<void>(r=>{enteredReplace=r;});
  PreviewSettingsStore.prototype.write=async function(value,key){if(holdReplace&&value.profileToken===null){holdReplace=false;enteredReplace();await heldReplace;}return originalWrite.call(this,value,key);};
  // Admit Start behind a held real sync before recovery takes its synchronous
  // fence. Recovery must cancel that intent even though it executes first.
  let releaseRecoverySync=()=>{},enteredRecoverySync=()=>{},admittedRecoveryStart=()=>{};
  const recoverySyncHeld=new Promise<void>(r=>{releaseRecoverySync=r;}),recoverySyncAt=new Promise<void>(r=>{enteredRecoverySync=r;}),recoveryStartAt=new Promise<void>(r=>{admittedRecoveryStart=r;});
  const offlineFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{if(String(input)===server.origin+'/sync'){enteredRecoverySync();await recoverySyncHeld;}return offlineFetch(input,init);};
  Server.prototype.emit=function(event:string,...args:unknown[]){if(event==='request')return scope.run((args[0] as {url:string}).url,()=>Reflect.apply(originalEmit,this,[event,...args]));return Reflect.apply(originalEmit,this,[event,...args]);};
  PreviewStoreOwner.prototype.run=function<T>(operation:(check:()=>void)=>Promise<T>){if(scope.getStore()==='/start')admittedRecoveryStart();return originalRun.call(this,operation) as Promise<T>;};
  let recoverySync:ReturnType<typeof request>|undefined,queuedRecoveryStart:ReturnType<typeof request>|undefined,replacing:ReturnType<typeof request>|undefined,recoveryStart:ReturnType<typeof request>|undefined;
  try{
   recoverySync=request('/tracking/sync',{});await waitFor(recoverySyncAt);
   queuedRecoveryStart=request('/start',{apps:['invented.editor'],pixels:true,rich:true,retain:true,upload:true,retentionMs:3600000});await waitFor(recoveryStartAt);
   replacing=request('/chrome/replace-pairing',{});
   for(let n=0;n<100&&(await request('/state')).value.pair!=='pairing-recovery';n++)await new Promise(r=>setTimeout(r,10));
   releaseRecoverySync();assert.equal((await recoverySync).status,409);preserved.client.error='SYNC_FAILED';
   assert.equal((await queuedRecoveryStart).status,409);
   await waitFor(Promise.race([atReplace,replacing.then(r=>assert.equal(r.status,200))]));
   assert.equal((await request('/state')).value.pair,'pairing-recovery');
   for(const kind of ['challenge','context','image','revoke'])assert.equal((await ipc({kind,profileToken:oldPair,data:{}})).ok,false,kind+' must reject retired token while recovery drains');
   assert.equal((await ipc({kind:'pair',code:oldCode})).ok,false);
   recoveryStart=request('/start',{apps:['invented.editor']});
  }finally{releaseRecoverySync();releaseReplace();PreviewSettingsStore.prototype.write=originalWrite;globalThis.fetch=offlineFetch;Server.prototype.emit=originalEmit;PreviewStoreOwner.prototype.run=originalRun;await Promise.allSettled([recoverySync,queuedRecoveryStart,replacing].filter(p=>p!==undefined));}
  assert.equal((await replacing!).status,200);assert.equal((await recoveryStart!).status,409);
  const recovered=(await request('/state')).value;assert.equal(recovered.recording,false);assert.equal(recovered.pomodoroAccess,false);assert.match(recovered.pair,/^[a-f0-9]{32}$/);
  assert.deepEqual((await request('/tracking')).value,preserved);assert.deepEqual((await request('/restore',{})).value.saved,localBefore);
  const fresh=await ipc({kind:'pair',code:recovered.pair});assert.equal(fresh.ok,true);assert.notEqual(fresh.profileToken,oldPair);
  assert.equal((await ipc({kind:'challenge',profileToken:oldPair})).ok,false);assert.equal((await ipc({kind:'revoke',profileToken:oldPair})).ok,false);
  assert.deepEqual((await request('/tracking')).value,preserved,'stale revoke cannot delete replacement history');
  await runtime!.close();runtime=undefined;url='';await start();await ready();
  Object.assign(connection,JSON.parse(await readFile('Library/Application Support/SpindlePreview/connection.json','utf8')));
  assert.equal((await request('/state')).value.pair,'enrolled');assert.ok('challenge'in await ipc({kind:'challenge',profileToken:fresh.profileToken}));
  assert.deepEqual((await request('/tracking')).value,preserved);assert.deepEqual((await request('/restore',{})).value.saved,localBefore);
  // A failed settings write cannot publish a code, revive the old token after
  // key recovery, or erase existing queue/history. Explicit retry remains usable.
  PreviewSettingsStore.prototype.write=async function(value,key){if(value.profileToken===null)throw Error('INVENTED_SETTINGS_FAILURE');return originalWrite.call(this,value,key);};
  try{assert.equal((await request('/chrome/replace-pairing',{})).status,409);}finally{PreviewSettingsStore.prototype.write=originalWrite;}
  assert.equal((await request('/state')).value.pair,'pairing-recovery');
  assert.equal((await ipc({kind:'challenge',profileToken:fresh.profileToken})).ok,false);
  await refresh();assert.equal((await request('/state')).value.pair,'pairing-recovery');
  assert.equal((await ipc({kind:'revoke',profileToken:fresh.profileToken})).ok,false);
  assert.deepEqual((await request('/tracking')).value,preserved);assert.deepEqual((await request('/restore',{})).value.saved,localBefore);
  // Key recovery must drain an already committed settings write before opening
  // another owner, and the cancelled HTTP action cannot expose a fresh code.
  let releaseKeyReplace=()=>{},enteredKeyReplace=()=>{};
  const keyReplaceHeld=new Promise<void>(r=>{releaseKeyReplace=r;}),keyReplaceAt=new Promise<void>(r=>{enteredKeyReplace=r;});
  PreviewSettingsStore.prototype.write=async function(value,key){const result=originalWrite.call(this,value,key);if(value.profileToken===null){await result;enteredKeyReplace();await keyReplaceHeld;}return result;};
  const interruptedReplace=request('/chrome/replace-pairing',{});
  try{await waitFor(keyReplaceAt);await request('/key',{});for(let n=0;n<100&&(await request('/state')).value.settingsReady;n++)await new Promise(r=>setTimeout(r,10));assert.equal((await request('/state')).value.settingsReady,false);}
  finally{releaseKeyReplace();PreviewSettingsStore.prototype.write=originalWrite;}
  assert.equal((await interruptedReplace).status,409);await ready();
  assert.equal((await request('/state')).value.pair,'pairing-recovery');
  assert.equal((await ipc({kind:'revoke',profileToken:fresh.profileToken})).ok,false);
  assert.deepEqual((await request('/tracking')).value,preserved);assert.deepEqual((await request('/restore',{})).value.saved,localBefore);
  assert.equal((await request('/chrome/replace-pairing',{})).status,200);
  const retried=await ipc({kind:'pair',code:(await request('/state')).value.pair});assert.equal(retried.ok,true);
  pairing.profileToken=retried.profileToken;globalThis.fetch=recoveryFetch;
  const originalFinish=PreviewSettingsStore.prototype.finishBrowserRevocation;let releaseRevoke=()=>{},enteredRevoke=()=>{};
  const heldRevoke=new Promise<void>(r=>{releaseRevoke=r;}),atRevoke=new Promise<void>(r=>{enteredRevoke=r;});
  PreviewSettingsStore.prototype.finishBrowserRevocation=async function(...args){enteredRevoke();await heldRevoke;return originalFinish.apply(this,args);};
  const revoking=ipc({kind:'revoke',profileToken:pairing.profileToken});
  try{await atRevoke;assert.equal((await request('/chrome/replace-pairing',{})).status,409);await request('/key',{});await new Promise(r=>setTimeout(r,75));assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/clear',{})).status,409);}finally{releaseRevoke();PreviewSettingsStore.prototype.finishBrowserRevocation=originalFinish;}
  await revoking.catch(()=>{});await ready();assert.notEqual((await request('/state')).value.pair,'enrolled');assert.equal((await request('/tracking/status')).value.client.deviceId,before.client.deviceId);
  // Failed recovery stays unavailable; it cannot resurrect the old client or
  // admit signin/sync. Recovery is explicit, not a background retry loop.
  const queuePath=join('Library/Application Support/SpindlePreview/account','tracking.enc'),encrypted=await readFile(queuePath);
  await writeFile(queuePath,'invented-corruption');await request('/key',{});await new Promise(r=>setTimeout(r,100));
  assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/tracking/status')).value.client,null);
  assert.equal((await request('/tracking/sync',{})).status,409);assert.equal((await request('/tracking/signin',{...setup,register:false})).status,409);
  await writeFile(queuePath,encrypted);await refresh();assert.equal((await request('/tracking/status')).value.client.deviceId,before.client.deviceId);
  // Lock cancels a held signin and drains it before any explicit recovery.
  const lockFetch=globalThis.fetch;let releaseSignin=()=>{},enteredSignin=()=>{};
  const heldSignin=new Promise<void>(r=>{releaseSignin=r;}),atSignin=new Promise<void>(r=>{enteredSignin=r;});
  globalThis.fetch=async(input,init)=>{const response=await lockFetch(input,init);if(String(input)===server.origin+'/devices'&&init?.method==='POST'){enteredSignin();await heldSignin;}return response;};
  const signing=request('/tracking/signin',{...setup,register:false});await atSignin;await writeFile(join(root,'event'),'locked');await request('/key',{});await new Promise(r=>setTimeout(r,75));
  assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/tracking/sync',{})).status,409);
  releaseSignin();assert.equal((await signing).status,409);globalThis.fetch=lockFetch;
  await writeFile(join(root,'event'),'key');await refresh();assert.equal((await request('/tracking/devices')).value.devices.length,1);
  // Quit also cancels a held signin; the store remains durable for a later
  // explicit launch, but the closing runtime cannot publish it.
  let quitSigninRelease=()=>{},quitSigninEntered=()=>{};const quitSigninHeld=new Promise<void>(r=>{quitSigninRelease=r;}),quitSigninAt=new Promise<void>(r=>{quitSigninEntered=r;});
  globalThis.fetch=async(input,init)=>{const response=await lockFetch(input,init);if(String(input)===server.origin+'/devices'&&init?.method==='POST'){quitSigninEntered();await quitSigninHeld;}return response;};
  const quitSignin=request('/tracking/signin',{...setup,register:false});await quitSigninAt;const closingSignin=runtime!.close();
  try{assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/tracking/sync',{})).status,409);quitSigninRelease();assert.equal((await quitSignin).status,409);}finally{quitSigninRelease();globalThis.fetch=lockFetch;await closingSignin;runtime=undefined;}
  url='';await start();await ready();assert.equal((await request('/tracking/devices')).value.devices.length,1);
  // Quit is terminal even while an unpublished inspect is in flight. A late
  // key message and late signin cannot resurrect readiness or create an owner.
  holdInspect=true;let quitRelease=()=>{},quitEntered=()=>{};const quitHeld=new Promise<void>(r=>{quitRelease=r;}),quitAt=new Promise<void>(r=>{quitEntered=r;});
  EncryptedStore.prototype.transaction=function<R>(this:EncryptedStore<unknown>,fn:(state:unknown)=>R|Promise<R>,write?:boolean):Promise<R>{return originalTransaction.call(this,async state=>{const result=await fn(state);if(holdInspect&&this.directory.endsWith('/account')){holdInspect=false;quitEntered();await quitHeld;}return result;},write) as Promise<R>;};
  await request('/key',{});await quitAt;const quitting=runtime!.close();
  try{assert.equal((await request('/state')).value.settingsReady,false);assert.equal((await request('/tracking/signin',{...setup,register:false})).status,409);await request('/key',{});}finally{quitRelease();EncryptedStore.prototype.transaction=originalTransaction;await quitting;runtime=undefined;}
 }finally{globalThis.fetch=originalGlobalFetch;await runtime?.close();if(generatedSamplePdf)await rm(samplePdf,{force:true});Object.defineProperty(process,'platform',originalPlatform);if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;console.log=originalLog;process.chdir(originalCwd);await server.close();await rm(dir,{recursive:true,force:true});}
});
