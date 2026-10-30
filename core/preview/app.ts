import { createServer as httpServer } from 'node:http';
import { createServer as ipcServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes,randomUUID,timingSafeEqual,createHash } from 'node:crypto';
import { mkdir,writeFile,readFile,rm,chmod,lstat } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { PreviewSession } from './session.js';
import { Vault } from './vault.js';
import { PreviewSettingsStore, type CapturePreferences, type PreviewSettings, type WorkOSCleanupLease } from './settings.js';
import { TrackingClient } from '../tracking/client.js';
import {PreviewStoreOwner,reopenTracking,trackingStoreDirectory,validateServiceOrigin,validateTrackingSetup,type TrackingSetup} from './tracking-setup.js';
import { CollectorHistory } from '../tracking/collector.js';
import type { ActivityEvidence } from '../tracking/types.js';
import { FixtureOwner } from './fixture.js';
import { CaptureClassification } from './classification.js';
import { configuredNebius } from '../models/config.js';
import type { TextProvider } from '../models/provider.js';
import { openInspector } from '../capture-check/app.js';
import {PomodoroControl} from './pomodoro-control.js';
import {PreviewWorkOSControl} from './workos-control.js';
import {PurposeControl} from '../blocking/control.js';
import {optionalPurpose} from './purpose-config.js';
import {pomodoroAsset} from '../pomodoro/assets.js';
import {runTimerOnly} from './timer-only.js';
import { acquireWindowsPreviewOwner } from './windows-owner.js';
import {verifyMacosPreview} from '../../tools/verify-macos-preview.js';
import {inspectChromeNativeHost,stageChromeExtension,installChromeNativeHost} from './chrome-install.js';
import {EarnedControl,earnedCode} from './earned-control.js';
import {previewUiAsset} from './ui-assets.js';
const here=dirname(fileURLToPath(import.meta.url));
export const dataDirectory=()=>process.platform==='darwin'?join(homedir(),'Library/Application Support/SpindlePreview'):process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'SpindlePreview'):join(homedir(),'.spindle-preview-test');
export class PreviewControlOwner {
  private active=false;
  private idle:Promise<void>=Promise.resolve();
  get pending(){return this.active;}
  async settle(){await this.idle;}
  async run<T>(operation:()=>Promise<T>){if(this.active)throw Error('CONTROL_BUSY');this.active=true;let release=()=>{};this.idle=new Promise<void>(resolve=>{release=resolve;});try{return await operation();}finally{this.active=false;release();}}
}
export async function signinPausedCollector(session:PreviewSession,detach:()=>Promise<void>,client:TrackingClient,credentials:{name:string;password:string;deviceName:string;register?:boolean}){
  if(session.recording)throw Error('PAUSE_REQUIRED');const generation=session.generation;
  await detach();await client.settle();
  if(session.recording||session.generation!==generation)throw Error('SIGNIN_CANCELLED');
  await client.signin(credentials.name,credentials.password,credentials.deviceName,credentials.register===true);
  if(session.recording||session.generation!==generation)throw Error('SIGNIN_CANCELLED');
}
export function previewLaunchOptions(args:readonly string[],nonce=process.env.SPINDLE_DESKTOP_NONCE){
  if(args.length===1&&args[0]==='--desktop-shell'){
    if(typeof nonce!=='string'||! /^[A-Za-z0-9_-]{16,128}$/.test(nonce))throw Error('DESKTOP_NONCE_REQUIRED');
    return {noOpen:true,desktopNonce:nonce};
  }
  if(args.length!==0&&(args.length!==1||args[0]!=='--no-open'))throw Error('PREVIEW_ARGUMENTS_REQUIRED');
  return {noOpen:args.length===1};
}
export async function runPreview(root=resolve(here,'../../..'),remoteProvider?:TextProvider,options:{noOpen?:boolean;desktopNonce?:string}={}){
  if(!['darwin','win32'].includes(process.platform))throw new Error('WINDOWS_OR_MAC_REQUIRED');
  if(options.desktopNonce){if(process.platform!=='darwin')throw Error('DESKTOP_MAC_REQUIRED');verifyMacosPreview(root);}
  let closed=false,recordingIntent=0;
  const stores=new PreviewStoreOwner(),controls=new PreviewControlOwner(),session=new PreviewSession(),classification=new CaptureClassification(session,remoteProvider),directory=dataDirectory(),vault=new Vault(directory);
  let source='development';try{const meta=JSON.parse(await readFile(join(root,'preview-build.json'),'utf8'));if(typeof meta.source==='string'&&/^[a-f0-9]{40}$/.test(meta.source))source=meta.source;}catch{/* source run */}
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
  let pair=randomBytes(16).toString('hex'),pairingRecovery=false,pairingRecoveryPending=false;
  let profileToken=randomBytes(32).toString('hex');
  const settings=new PreviewSettingsStore(join(directory,'settings'));
  let workosCleanup:WorkOSCleanupLease[]=[],workosJournalKey:Buffer|null=null,keyIntent=0;
  let settingsReady=false,preferences:CapturePreferences|null=null,revocation:PreviewSettings['revocation'],trackingSetup:TrackingSetup|undefined,timerOrigin:string|undefined;
  const saveSettings=(savedProfileToken:string|null=enrolled?profileToken:null)=>{if(!key||!settingsReady)return Promise.reject(new Error('SETTINGS_KEY_REQUIRED'));return settings.write({schema:'spindle-preview-settings/v1',profileToken:savedProfileToken,preferences,...(trackingSetup?{tracking:trackingSetup}:{}),...(timerOrigin?{timerOrigin}:{}),...(revocation?{revocation}: {}),workosCleanup},key);};
  let enrolled=false,provider='starting',key:Buffer|null=null,nativeAt=0,received=performance.now(),lastCode='IDLE';
  const purpose=new PurposeControl(()=>enrolled?profileToken:undefined,async signal=>{signal.throwIfAborted();const identity=await pomodoro.route('session',{});signal.throwIfAborted();return identity as {binding:string};},optionalPurpose());
  let workos:PreviewWorkOSControl|undefined,workosAdopting=false;
  const pomodoro=new PomodoroControl(()=>enrolled?profileToken:undefined,()=>{purpose.revokeProfile();earned.revoke();if(!workosAdopting)void workos?.retire().catch(()=>{});});
  // Separate, ephemeral paired-profile grant over this host's own account client.
  const earned=new EarnedControl(()=>enrolled?profileToken:undefined,()=>settingsReady&&!pairingRecovery&&!revocation?.pending?tracking:undefined,operation=>controls.run(operation));
  const capabilities={accessibility:'not-reported',screenRecording:'not-reported'};
  let lastBrowser=0;
  let tracking:TrackingClient|undefined,history:CollectorHistory|undefined;
  let historyDrain:Promise<void>=Promise.resolve();
  const stopHistory=()=>{const retired=history;history=undefined;if(retired)historyDrain=Promise.all([historyDrain,retired.dispose()]).then(()=>{});return historyDrain;};
  // Collector callbacks are admitted only by a live history subscription. Retire
  // that producer and drain its queued work before releasing the client owner.
  const retireTracking=async()=>{await stopHistory();await tracking?.settle();tracking=undefined;await settings.settle();await vault.settle();};
  const invalidateStores=()=>{const authDrain=workos?.retire().catch(()=>{})??Promise.resolve();settingsReady=false;enrolled=false;pomodoro.revokeProfile();purpose.revokeProfile();earned.revoke();session.pause(nativeNow());send({action:'stop'});void stopHistory().catch(()=>{});return authDrain;};
  const recoverKey=(b:Buffer|null)=>{
    const intent=++keyIntent,authDrain=invalidateStores();key?.fill(0);key=b;lastCode=b?'KEY_READY':'KEY_UNAVAILABLE';
    // Keep the old journal key and store lease available until in-flight native
    // authority has been journaled/revoked; recovery must not fence that cleanup.
    void authDrain.then(async()=>{if(intent!==keyIntent||closed)return;await stores.recover(async current=>{
      await retireTracking();if(!current())return false;
      workosJournalKey?.fill(0);workosJournalKey=null;if(!b)return false;workosJournalKey=Buffer.from(b);
      const saved=await settings.read(b);if(!current())return false;workosCleanup=saved.workosCleanup??[];workos!.restoreCleanup(workosCleanup);
      // The opener's write-producing inspect is part of this same ownership
      // lease even before publication. A replacement waits for it to return.
      let reopened:TrackingClient|undefined;try{reopened=saved.tracking?await reopenTracking(saved.tracking,join(directory,'account'),b):undefined;}catch(error){if(!workosCleanup.length)throw error;lastCode='ACCOUNT_SIGNIN_REQUIRED';}
      if(!current()){await reopened?.settle();return false;}
      profileToken=saved.profileToken??randomBytes(32).toString('hex');enrolled=!pairingRecovery&&saved.profileToken!==null;preferences=saved.preferences;revocation=saved.revocation;trackingSetup=saved.tracking;timerOrigin=saved.timerOrigin;tracking=reopened;
      settingsReady=true;if(revocation?.pending)lastCode='BROWSER_REVOKE_PENDING_ACCOUNT_SIGNIN';return true;
    });if(intent===keyIntent&&settingsReady&&!closed)await workos!.retryCleanup().catch(()=>{lastCode='WORKOS_REVOCATION_PENDING';});}).catch(error=>{if(key===b&&!closed){invalidateStores();lastCode=error instanceof Error&&error.message==='STORE_CLOCK_ANOMALY'?'SETTINGS_CLOCK_PENDING':'SETTINGS_UNAVAILABLE';}});
  };
  workos=new PreviewWorkOSControl({persistCleanup:async leases=>{
    const journalKey=workosJournalKey;if(!journalKey)throw Error('SETTINGS_KEY_REQUIRED');
    await stores.run(async check=>{if(workosJournalKey!==journalKey)throw Error('SIGNIN_CANCELLED');const saved=await settings.read(journalKey);check();if(workosJournalKey!==journalKey)throw Error('SIGNIN_CANCELLED');const pending=structuredClone([...leases]);await settings.write({...saved,workosCleanup:pending},journalKey);check();workosCleanup=pending;});
  },adopt:async(origin,deviceName,credentials,guard)=>{
    await stores.run(async check=>{await controls.run(async()=>{
      const signinKey=key;guard();check();if(!signinKey||!settingsReady||session.recording||revocation?.pending)throw Error('SIGNIN_CANCELLED');
      const signinGeneration=session.generation,client=tracking&&trackingSetup?.workosAccountId===credentials.account.id&&trackingSetup.origin===origin?tracking:new TrackingClient(origin,trackingStoreDirectory(join(directory,'account'),origin,credentials.account.id),signinKey);
      const current=()=>{check();guard();if(key!==signinKey||!settingsReady||closed||session.recording||session.generation!==signinGeneration)throw Error('SIGNIN_CANCELLED');};
      if(client.origin!==origin)throw Error('CLIENT_IDENTITY_MISMATCH');
      await stopHistory();await tracking?.settle();await client.settle();current();
      let timerBinding:string|undefined;const previousSetup=trackingSetup,previousTimerOrigin=timerOrigin;
      try{
        workosAdopting=true;const identity=await pomodoro.signinWorkOSSession(origin,credentials.timer);timerBinding=identity.binding;current();
        await client.signinWorkOSSession(credentials.tracking,deviceName);current();const state=await client.inspect();current();
        trackingSetup={origin,name:credentials.account.name,deviceName:state.deviceName,workosAccountId:credentials.account.id};timerOrigin=origin;await saveSettings();current();tracking=client;
      }catch(error){
        if(key===signinKey){trackingSetup=previousSetup;timerOrigin=previousTimerOrigin;}
        if(timerBinding)await pomodoro.route('signout',{binding:timerBinding}).catch(()=>{});
        throw error;
      }finally{workosAdopting=false;}
    });});
  }});
  let revokePending:Promise<void>|undefined;
  const revokeBrowser=(oldToken?:string)=>{
    if(revokePending)return revokePending;
    if(!key||!settingsReady)return Promise.reject(Error('SETTINGS_KEY_REQUIRED'));
    pomodoro.revokeProfile();purpose.revokeProfile();earned.revoke();
    const expectedKey=key,secretKey=Buffer.from(key);
    if(oldToken){revocation={tokenHash:createHash('sha256').update(oldToken).digest('hex'),pending:true};enrolled=false;}
    const tokenHash=revocation?.tokenHash;
    session.pause(nativeNow());session.revokeBrowser();send({action:'stop'});
    revokePending=(async()=>{
      if(oldToken)await settings.beginBrowserRevocation(secretKey,oldToken);
      await stopHistory();
      const saved=await settings.finishBrowserRevocation(secretKey,async()=>{
        // After restart, require account reauthentication rather than falsely
        // acknowledging removal of an encrypted client we have not reopened.
        if(!tracking){try{await lstat(join(directory,'account','tracking.enc'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await vault.clear();return;}throw Error('ACCOUNT_SIGNIN_REQUIRED');}
        await tracking.eraseDeviceHistory(true);await vault.clear();
      },tokenHash);
      if(key===expectedKey){revocation=saved.revocation;enrolled=saved.profileToken!==null;profileToken=saved.profileToken??randomBytes(32).toString('hex');lastCode='BROWSER_REVOKED_DELETION_QUEUED';}
    })().finally(()=>{secretKey.fill(0);revokePending=undefined;});return revokePending;
  };
  const fixtures=new FixtureOwner(()=>spawn(join(root,'runtime',process.platform==='darwin'?'SpindleFixture':'SpindleFixture.exe'),['--fixture'],{stdio:'ignore',windowsHide:false}),()=>{lastCode='FIXTURE_UNAVAILABLE';});
  const nativeNow=()=>nativeAt+Math.max(0,performance.now()-received);
  const executable=process.platform==='darwin'?join(root,'runtime/SpindlePreview'):join(root,'runtime/SpindlePreview.exe');
  let helperHash='not-built';try{helperHash=createHash('sha256').update(await readFile(executable)).digest('hex');}catch{/* unavailable helper */}
  const ownership=process.platform==='win32'?await acquireWindowsPreviewOwner(executable):undefined;
  let ownershipReleased=false;
  let startupResolve!:()=>void,startupReject!:(error:Error)=>void;
  const startup=new Promise<void>((resolve,reject)=>{startupResolve=resolve;startupReject=reject;});
  const startupTimeout=setTimeout(()=>startupReject(Error('NATIVE_STARTUP_TIMEOUT')),5000);
  const helper=spawn(executable,process.platform==='win32'?['--capture-worker']:[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  ownership?.once('exit',()=>{if(!ownershipReleased){helper.kill();console.error('Spindle stopped: WINDOWS_OWNER_LEASE_LOST');process.exit(1);}});
  const send=(v:Record<string,unknown>)=>{if(!helper.stdin.destroyed)helper.stdin.write(JSON.stringify({schema:'spindle-native-preview/v1',...v})+'\n');};
  session.subscribe(()=>{if(history&&history.status!=='ready'){send({action:'stop'});lastCode=history.status;}});
  const persist=()=>{if(session.options.retain&&key&&settingsReady&&!closed)void vault.write(session.snapshot(),key,900000,()=>session.options.retain).catch(()=>{lastCode='STORE_WRITE_FAILED';});};
  let buffer='';helper.stdout.setEncoding('utf8');helper.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>4_000_000){helper.kill();lastCode='NATIVE_FRAME_BOUND';return;}
    let index:number;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{
      const e:Record<string,unknown>=JSON.parse(line);if(e.schema!=='spindle-native-preview/v1'){session.pause(nativeNow());helper.kill();lastCode='NATIVE_PROTOCOL_VERSION';continue;}
      if(e.kind==='capability'){
        if(e.code==='NATIVE_READY'||e.code==='ACCESSIBILITY_REQUIRED')capabilities.accessibility=e.code==='NATIVE_READY'?'granted':'required';
        if(e.code==='SCREEN_RECORDING_GRANTED'||e.code==='SCREEN_RECORDING_REQUIRED')capabilities.screenRecording=e.code==='SCREEN_RECORDING_GRANTED'?'granted':'required';
        if(e.code==='SCREEN_RECORDING_NOT_REQUESTED')capabilities.screenRecording='not-requested';
      }
      if(e.kind==='ready'){provider=e.permission===true?'ready':'permission-required';send({action:'key'});startupResolve();}
      if(typeof e.at==='number'&&Number.isFinite(e.at)&&e.at>=nativeAt){nativeAt=e.at;received=performance.now();}
      if(e.kind==='key'&&typeof e.value==='string'&&!closed){const b=Buffer.from(e.value,'base64');recoverKey(b.length===32?b:null);}
      if(e.kind==='activity'&&e.epoch===session.epoch&&typeof e.at==='number'&&['under-15s','15s-1m','1m-5m','over-5m','unknown'].includes(String(e.inputAgeBucket))){history?.evidence({awake:true,unlocked:true,inputAgeBucket:e.inputAgeBucket as ActivityEvidence['inputAgeBucket'],heartbeatAt:e.at,coverage:'observed'});}
      if(e.kind==='locked'&&!closed){recoverKey(null);lastCode='SESSION_LOCKED';}
      if(e.kind==='error'){lastCode=e.code==='WINDOWS_CAPTURE_OWNER_BUSY'?'WINDOWS_CAPTURE_OWNER_BUSY':'NATIVE_UNAVAILABLE';if(session.recording){session.gap(nativeAt);persist();}else session.pause(nativeNow());startupReject(Error(lastCode));}
      if(e.kind==='focus'){session.focus(e);persist();}
      if(e.kind==='sample'){session.sample(e);persist();}
      if(e.kind==='gap'&&e.epoch===session.epoch){session.gap(e.at);lastCode='COVERAGE_GAP';persist();}
    }catch{lastCode='NATIVE_MESSAGE_INVALID';}}
  });helper.stderr.on('data',()=>{});helper.stdin.on('error',()=>{});
  helper.on('error',()=>{provider='unavailable';lastCode='HELPER_MISSING';session.pause(nativeNow());startupReject(Error(lastCode));});helper.on('exit',()=>{provider='stopped';if(!closed&&session.recording){session.gap(nativeAt);lastCode='NATIVE_UNAVAILABLE';persist();}else session.pause(nativeNow());});
  helper.once('close',()=>startupReject(Error('NATIVE_STARTUP_FAILED')));
  // Native ownership must succeed before this process can publish/replace the
  // current user's browser connection. A duplicate launch leaves its owner intact.
  try{await startup;}catch(error){helper.kill();ownershipReleased=true;ownership?.stdin.end('quit\n');classification.dispose();(key as Buffer|null)?.fill(0);throw error;}finally{clearTimeout(startupTimeout);}
  const ipcPath=process.platform==='win32'?`\\\\.\\pipe\\spindle-preview-${randomUUID()}`:join(directory,`ipc-${randomUUID()}.sock`);
  const connections=new Set<import('node:net').Socket>();
  const ipc=ipcServer(socket=>{
    const acknowledge=(ok:boolean)=>{void (history?.settle()??Promise.resolve()).then(()=>socket.write(JSON.stringify({ok})+'\n')).catch(()=>socket.write('{"ok":false}\n'));};
    const abort=new AbortController();connections.add(socket);socket.on('close',()=>{connections.delete(socket);abort.abort();});socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());let pending='';
    socket.on('data',chunk=>{pending+=chunk.toString('utf8');if(Buffer.byteLength(pending)>3_000_000){socket.destroy();return;}let i:number;while((i=pending.indexOf('\n'))>=0){const raw=pending.slice(0,i);pending=pending.slice(i+1);try{
      const m=JSON.parse(raw);if(m.schema!=='spindle-browser-preview/v1'||m.secret!==secret){socket.destroy();return;}
      if(m.kind==='pair'&&m.code===pair&&!enrolled&&settingsReady&&!pairingRecovery&&!revocation?.pending){const code=pair,candidate=profileToken;void stores.run(async check=>{if(enrolled||pairingRecovery||m.code!==pair||revocation?.pending)throw Error('PROFILE_DENIED');await saveSettings(candidate);check();if(pairingRecovery||pair!==code)throw Error('PROFILE_DENIED');enrolled=true;socket.write(JSON.stringify({ok:true,profileToken:candidate})+'\n');}).catch(()=>{socket.write('{"ok":false}\n');});}
      else if(m.kind==='revoke'&&!pairingRecovery&&typeof m.profileToken==='string'&&/^[a-f0-9]{64}$/.test(m.profileToken)&&((enrolled&&m.profileToken===profileToken)||revocation?.tokenHash===createHash('sha256').update(m.profileToken).digest('hex'))){
        if(revocation?.tokenHash===createHash('sha256').update(m.profileToken).digest('hex')&&!revocation.pending)socket.write('{"ok":true}\n');
        else void stores.run(async check=>{if(pairingRecovery||!(enrolled&&m.profileToken===profileToken)&&revocation?.tokenHash!==createHash('sha256').update(m.profileToken).digest('hex'))throw Error('PROFILE_DENIED');await revokeBrowser(m.profileToken);check();}).then(()=>socket.write('{"ok":true}\n')).catch(()=>{lastCode='BROWSER_REVOKE_PENDING_ACCOUNT_SIGNIN_OR_STORAGE';socket.destroy();});
      }
      else if(m.kind==='pomodoro')void pomodoro.extension(m.data,m.profileToken,abort.signal).then(result=>{if(!socket.destroyed)socket.write(JSON.stringify(result)+'\n');});
      else if(m.kind==='purpose')void purpose.extension(m.data,m.profileToken,abort.signal).then(result=>{if(!socket.destroyed)socket.write(JSON.stringify(result)+'\n');});
      // Account network may take the client's full bounded request time.
      else if(m.kind==='earned'){socket.setTimeout(12000,()=>socket.destroy());void earned.extension(m.data,m.profileToken,abort.signal).then(result=>{if(!socket.destroyed)socket.write(JSON.stringify(result)+'\n');});}
      else if(m.kind==='challenge'&&enrolled&&m.profileToken===profileToken)socket.write(JSON.stringify({challenge:session.challenge(),rich:session.options.pixels&&session.options.rich&&session.options.retain})+'\n');
      else if(m.kind==='context'&&enrolled&&m.profileToken===profileToken){const ok=session.browser(m.data,nativeNow());if(ok){lastBrowser=performance.now();persist();}acknowledge(ok);}
      else if(m.kind==='image'&&enrolled&&m.profileToken===profileToken){const ok=session.browserImage(m.data,nativeNow());if(ok)persist();acknowledge(ok);}
      else socket.write('{"ok":false}\n');
    }catch{socket.destroy();}}});
  });await new Promise<void>((resolve,reject)=>{ipc.once('error',reject);ipc.listen(ipcPath,resolve);});if(process.platform!=='win32')await chmod(ipcPath,0o600);
  await writeFile(join(directory,'connection.json'),JSON.stringify({ipcPath,secret}),{mode:0o600});
  let origin='';
  const syncTimer=setInterval(()=>{if(tracking&&key&&settingsReady&&!pairingRecovery&&!controls.pending&&!revocation?.pending)void stores.run(async check=>{await tracking!.sync();check();if(lastCode==='HISTORY_OFFLINE_OR_SIGNIN_REQUIRED')lastCode='IDLE';}).catch(()=>{lastCode='HISTORY_OFFLINE_OR_SIGNIN_REQUIRED';});},2000);
  const expiry=setInterval(()=>{session.expire();const v=session.active;if(v?.browser&&v.text&&performance.now()-lastBrowser>2500)v.availability='browser-stale-companion-or-focus-unavailable';classification.sync();},500);
  const close=async()=>{if(closed)return;closed=true;const authClose=workos!.close().catch(()=>{});if(options.desktopNonce)process.stdin.destroy();invalidateStores();const storeClose=authClose.then(()=>stores.close(retireTracking));purpose.close();earned.close();const timerClose=pomodoro.close().catch(()=>{});clearInterval(expiry);clearInterval(syncTimer);session.pause(nativeNow());classification.dispose();fixtures.stop();send({action:'quit'});const timer=setTimeout(()=>helper.kill(),1000);timer.unref();await storeClose;await authClose;await vault.settle();await settings.settle();await timerClose;key?.fill(0);workosJournalKey?.fill(0);for(const c of connections)c.destroy();ipc.close();server.close();server.closeAllConnections();await rm(join(directory,'connection.json'),{force:true});if(process.platform!=='win32')await rm(ipcPath,{force:true});};
  const server=httpServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"};
    const reply=(status:number,value:unknown,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(value):String(value));};
    if(!origin||req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin){reply(403,{code:'FORBIDDEN'});return;}
    if(req.method==='GET'&&['/','/ui.js'].includes(req.url??'')){try{reply(200,await readFile(join(here,req.url==='/'?'index.html':'ui.js'),'utf8'),req.url==='/'?'text/html':'text/javascript');}catch{reply(500,{code:'ASSET_UNAVAILABLE'});}return;}
    if(req.method==='GET'){const asset=await previewUiAsset(req.url??'');if(asset){res.writeHead(200,{...headers,'Content-Type':asset.type});res.end(asset.body);return;}}
    if(req.method==='GET'&&req.url?.startsWith('/pomodoro/')){const asset=await pomodoroAsset(req.url.replace('/pomodoro/','/pomodoro/app/'));if(asset){reply(200,asset.body,asset.type.split(';')[0]);return;}}
    if(req.method==='GET'&&req.url==='/sample/pdf'){try{const pdf=await readFile(join(here,'sample.pdf'));res.writeHead(200,{...headers,'Content-Type':'application/pdf'});res.end(pdf);}catch{reply(404,{code:'SAMPLE_PDF_UNAVAILABLE'});}return;}
    if(req.method==='GET'&&/^\/sample\/(a|b|rich)$/.test(req.url??'')){const page=req.url?.split('/').at(-1),dynamic=page!=='rich';reply(200,`<!doctype html><title>Invented page ${page}</title><h1>SPINDLE SAMPLE ${page}</h1><p>Invented visible article. Return visits must stay separate.</p>${dynamic?'<p id="counter">Counter 0</p>':''}${page==='rich'?'':'<input value="FORM_SECRET_MUST_NOT_BE_READ">'}${dynamic?'<script src="/sample-counter.js"></script>':''}`,'text/html');return;}
    if(req.url==='/sample-counter.js'){reply(200,'let n=0;setInterval(()=>document.getElementById("counter").textContent="Counter "+(++n),1000);','text/javascript');return;}
    const auth=req.headers.authorization??'',expected=`Bearer ${token}`;if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){reply(401,{code:'UNAUTHORIZED'});return;}
    if(req.method==='GET'&&req.url==='/state'){reply(200,{...session.snapshot(),classification:classification.snapshot(),platform:process.platform,provider,lastCode,capabilities,pair:revocation?.pending?'revocation-pending':pairingRecovery?'pairing-recovery':!settingsReady?'key-unavailable':enrolled?'enrolled':pair,preferences,settingsReady,timerOrigin:settingsReady?timerOrigin:null,pomodoroAccess:pomodoro.accessEnabled,earnedAccess:earned.accessEnabled});return;}
    if(req.method==='GET'&&['/tracking','/tracking/status'].includes(req.url??'')){try{const client=settingsReady&&tracking?await stores.run(async check=>{const value=await tracking!.inspect();check();return value;}):null;let summary=null;if(client){const {entries:_,...metadata}=client;summary=metadata;}reply(200,{setup:settingsReady?trackingSetup??null:null,historyStatus:history?.status??'disabled',client:req.url==='/tracking/status'?summary:client});}catch{reply(409,{code:'HISTORY_STATE_UNAVAILABLE'});}return;}
    if(req.method==='GET'&&req.url==='/tracking/devices'){try{if(!tracking||!settingsReady)throw Error();reply(200,await stores.run(async check=>{const value=await tracking!.devices();check();return value;}));}catch{reply(409,{code:'HISTORY_OFFLINE_OR_SIGNIN_REQUIRED'});}return;}
    if(req.method==='GET'&&req.url==='/auth/workos/status'){reply(200,lastCode==='SETTINGS_CLOCK_PENDING'?{state:'failed',code:'SETTINGS_CLOCK_PENDING'}:workos!.status());return;}
    if(req.method==='GET'&&req.url==='/classification'){reply(200,classification.snapshot());return;}
    if(req.method==='GET'&&req.url==='/feedback'){reply(200,{...session.feedback(),source,helperSha256:helperHash,provider,code:lastCode,capabilities});return;}
    if(req.method!=='POST'){reply(404,{});return;}
    let raw='';try{for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>4096)throw new Error();}const data=JSON.parse(raw||'{}');
      if(req.url?.startsWith('/auth/workos/')){
        if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{code:'ORIGIN_OR_JSON_REQUIRED'});return;}
        try{
          if(req.url==='/auth/workos/cancel'){if(Object.keys(data).length)throw Error('WORKOS_BACKEND_CONFIG_INVALID');await workos!.cancel();reply(200,workos!.status());return;}
          if(req.url!=='/auth/workos/begin'){reply(404,{code:'NOT_FOUND'});return;}
          if(!key){send({action:'key'});reply(409,{code:'KEY_REQUESTED_RETRY_SIGNIN'});return;}
          if(!settingsReady||session.recording||revocation?.pending)throw Error(session.recording?'PAUSE_REQUIRED':'SETTINGS_KEY_REQUIRED');
          const signinKey=key,signinGeneration=session.generation;
          await workos!.retire();
          const result=await stores.run(async check=>controls.run(async()=>{
            const guard=()=>{check();if(closed||key!==signinKey||!settingsReady||session.recording||session.generation!==signinGeneration||revocation?.pending)throw Error('SIGNIN_CANCELLED');};
            guard();await stopHistory();await tracking?.settle();guard();return workos!.begin(data,guard);
          }));reply(200,result);
        }catch(error){const code=error instanceof Error?error.message:'';reply(409,{code:['WORKOS_SYNC_CONSENT_REQUIRED','WORKOS_BACKEND_CONFIG_INVALID','WORKOS_REVOCATION_PENDING','WORKOS_DURABILITY_PENDING','WORKOS_SIGNIN_UNAVAILABLE','PAUSE_REQUIRED','SETTINGS_KEY_REQUIRED','CONTROL_BUSY'].includes(code)?code:'WORKOS_SIGNIN_UNAVAILABLE'});}return;
      }
      if(req.url?.startsWith('/chrome/')){
        if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{code:'ORIGIN_OR_JSON_REQUIRED'});return;}
        if(req.url==='/chrome/replace-pairing'){
          // Fence admission synchronously, including Starts already queued behind
          // a store operation. Only local authenticated controls own recovery.
          if(pairingRecoveryPending){reply(409,{code:'CONTROL_BUSY'});return;}
          if(!key||!settingsReady||revocation?.pending||revokePending){reply(409,{code:revocation?.pending?'BROWSER_REVOCATION_PENDING':'SETTINGS_KEY_REQUIRED'});return;}
          const recoveryKey=key;
          pairingRecovery=true;pairingRecoveryPending=true;enrolled=false;recordingIntent++;
          pomodoro.revokeProfile();purpose.revokeProfile();earned.revoke();
          session.pause(nativeNow());send({action:'stop'});
          const drained=stopHistory();
          try{
            await stores.run(async check=>{await controls.run(async()=>{
              await drained;await tracking?.settle();await vault.settle();check();
              if(key!==recoveryKey||closed||revocation?.pending)throw Error('PAIRING_RECOVERY_CANCELLED');
              await saveSettings(null);check();
              if(key!==recoveryKey||closed||revocation?.pending)throw Error('PAIRING_RECOVERY_CANCELLED');
              profileToken=randomBytes(32).toString('hex');pair=randomBytes(16).toString('hex');
              pairingRecovery=false;lastCode='CHROME_PAIRING_REPLACED_HISTORY_KEPT';
            });});
            reply(200,{ok:true});
          }catch{lastCode='CHROME_PAIRING_RECOVERY_RETRY_REQUIRED';reply(409,{code:'PAIRING_RECOVERY_RETRY_REQUIRED'});}finally{pairingRecoveryPending=false;}
          return;
        }
        try{await controls.run(async()=>{
          const context={home:homedir(),platform:process.platform};
          if(req.url==='/chrome/stage'){const staged=await stageChromeExtension(root,context);openInspector(staged.directory);reply(200,staged);return;}
          if(typeof data.extensionId!=='string')throw Error('INVALID_EXTENSION_ID');
          if(req.url==='/chrome/install'){reply(200,await installChromeNativeHost(data.extensionId,root,context));return;}
          if(req.url==='/chrome/inspect'){reply(200,await inspectChromeNativeHost(data.extensionId,root,context));return;}
          reply(404,{code:'NOT_FOUND'});
        });}catch(error){const candidate=error instanceof Error?error.message.split(';')[0]!:'';const code=/^[A-Z_]+$/.test(candidate)?candidate:'CHROME_REGISTRATION_UNAVAILABLE';reply(409,{code});}return;
      }
      if(req.url?.startsWith('/pomodoro/')){
        if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{code:'ORIGIN_OR_JSON_REQUIRED'});return;}
        const action=/^\/pomodoro\/(signin|session|read|command|signout|access)$/.exec(req.url);
        if(!action){reply(404,{code:'NOT_FOUND'});return;}
        try{if(['signin','signout'].includes(action[1]!))await workos!.retire();if(action[1]==='signin')validateServiceOrigin(data.origin);const result=action[1]==='signin'?await stores.run(async check=>{const result=await pomodoro.route('signin',data);check();timerOrigin=data.origin;await saveSettings();check();return result;}):await pomodoro.route(action[1]!,data);reply(200,result);}catch(error){const code=error instanceof Error?error.message:'';reply(code==='SIGNIN_REQUIRED'?401:409,{code:['SIGNIN_REQUIRED','ACCOUNT_CHANGED','PROFILE_REQUIRED','POMODORO_SIGNIN_BUSY'].includes(code)?code:'INVALID_POMODORO_REQUEST'});}return;
      }
      if(req.url?.startsWith('/earned/')){
        if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{code:'ORIGIN_OR_JSON_REQUIRED'});return;}
        try{
          const keys=Object.keys(data).sort().join(',');
          if(req.url==='/earned/read'&&!keys){reply(200,await earned.local('read'));return;}
          if(req.url==='/earned/opt-in'&&keys==='enabled'&&typeof data.enabled==='boolean'){reply(200,await earned.local('opt-in',{enabled:data.enabled}));return;}
          if(req.url==='/earned/access'&&keys==='enabled'){reply(200,await earned.setAccess(data.enabled));return;}
          reply(404,{code:'NOT_FOUND'});
        }catch(error){reply(409,{code:earnedCode(error,'EARNED_REQUEST_REFUSED')});}return;
      }
      if(req.url==='/tracking/signin'){
        earned.revoke();await workos!.retire();
        if(!key){send({action:'key'});reply(409,{code:'KEY_REQUESTED_RETRY_SIGNIN'});return;}
        if(session.recording||typeof data.origin!=='string'||typeof data.name!=='string'||typeof data.password!=='string'||typeof data.deviceName!=='string')throw new Error();
        if(!settingsReady)throw Error('SETTINGS_KEY_REQUIRED');
        const setup:TrackingSetup={origin:data.origin,name:data.name,deviceName:data.deviceName};validateTrackingSetup(setup);
        const signinKey=key;
        await stores.run(async check=>{await controls.run(async()=>{
          const client=tracking&&!trackingSetup?.workosAccountId?tracking:new TrackingClient(data.origin,trackingStoreDirectory(join(directory,'account'),data.origin),signinKey);
          await tracking?.settle();
          if(client.origin!==data.origin)throw Error('CLIENT_IDENTITY_MISMATCH');
          await signinPausedCollector(session,stopHistory,client,data);
          if(key!==signinKey||closed)throw Error('SIGNIN_CANCELLED');
          const state=await client.inspect();if(key!==signinKey||closed)throw Error('SIGNIN_CANCELLED');
          check();trackingSetup={...setup,deviceName:state.deviceName};await saveSettings();
          if(key!==signinKey||closed)throw Error('SIGNIN_CANCELLED');
          check();tracking=client;if(revocation?.pending)await revokeBrowser();check();
        });});
      }
      else if(req.url==='/tracking/sync'){if(!tracking||!key||!settingsReady||controls.pending)throw new Error();reply(200,await stores.run(async check=>{const value=await tracking!.sync();check();return value;}));return;}
      else if(req.url==='/classification/local'){if(typeof data.enabled!=='boolean')throw new Error();classification.local(data.enabled);}

      else if(req.url==='/classification/remote'){if(typeof data.text!=='boolean'||typeof data.image!=='boolean')throw new Error();if(!data.text&&!data.image)classification.revokeRemote();else classification.grantRemote(data.text,data.image);}
      else if(req.url==='/classification/correct'){if(typeof data.visit!=='string'||data.visit.length>128)throw new Error();if(!data.ref||typeof data.ref!=='object'||Array.isArray(data.ref))throw new Error();classification.correct(data.visit,data.labels,data.ref);}
      else if(req.url==='/classification/classify'){if(typeof data.visit!=='string'||data.visit.length>128||!['text','image'].includes(data.mode))throw new Error();reply(200,await classification.classify(data.visit,data.mode));return;}
      else if(req.url==='/fixtures'){fixtures.open();}
      else if(req.url==='/key'){send({action:'key'});}
      else if(req.url==='/restore'){const restored=await stores.run(async check=>{if(!key)throw new Error();const generation=session.generation;const saved=await vault.read(key);check();if(generation!==session.generation)throw new Error();if(saved&&typeof saved==='object'&&'schema'in saved&&saved.schema==='spindle-capture-preview/v1'&&'visits'in saved&&Array.isArray(saved.visits)){saved.visits=saved.visits.filter((v:unknown)=>v&&typeof v==='object'&&'expiresAt'in v&&typeof v.expiresAt==='number'&&v.expiresAt>Date.now());}else if(saved!==null)throw new Error();return {saved,generation};});reply(200,restored);return;}
      else if(req.url==='/start'){
        await workos!.cancel();
        // Capture intent at HTTP admission, not when the store queue executes.
        // Pause cancels pending Starts without invalidating unrelated store work.
        if(pairingRecovery)throw Error('PAIRING_RECOVERY_RETRY_REQUIRED');
        const startIntent=++recordingIntent;
        await stores.run(async check=>{await controls.run(async()=>{
        if(startIntent!==recordingIntent)throw new Error('START_CANCELLED');
        if(!settingsReady||pairingRecovery||revocation?.pending||provider!=='ready'||!Array.isArray(data.apps)||data.apps.length>8||!data.apps.every((x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(x)))throw new Error();
        if(data.retain===true&&!key)throw new Error();
        session.pause(nativeNow());send({action:'stop'});const startGeneration=session.generation,startKey=key;
        const checkStart=()=>{check();if(startIntent!==recordingIntent||session.generation!==startGeneration||key!==startKey||!settingsReady||closed||pairingRecovery||revocation?.pending)throw new Error('START_CANCELLED');};
        try{
          await stopHistory();checkStart();let deviceId:string|undefined;
          if(data.upload===true){
            if(!tracking||data.retain!==true||typeof data.retentionMs!=='number')throw new Error();
            deviceId=(await tracking.inspect()).deviceId;checkStart();
          }
          preferences={apps:data.apps,pixels:data.pixels===true,rich:data.rich===true&&data.retain===true&&data.pixels===true,retain:data.retain===true};
          await saveSettings();checkStart();
          // Publish the sink and start synchronously only after every async fence.
          if(deviceId)history=new CollectorHistory(session,tracking!,deviceId,data.retentionMs);
          session.start(preferences);
          send({action:'start',epoch:session.epoch,apps:data.apps,pixels:session.options.pixels,rich:session.options.rich});
        }catch(e){session.pause(nativeNow());send({action:'stop'});await stopHistory();throw e;}
      });});}else if(req.url==='/pause'){recordingIntent++;session.pause(nativeNow());send({action:'stop'});persist();}
      else if(req.url==='/clear'){await workos!.cancel();await stores.run(async check=>{session.pause(nativeNow());send({action:'stop'});await stopHistory();if(tracking)await tracking.eraseDeviceHistory();check();session.clear();fixtures.stop();send({action:'stop'});await vault.clear();check();});}
      else if(req.url==='/quit'){reply(200,{ok:true});await close();return;}
      else{reply(404,{});return;}await history?.settle();reply(200,{ok:true});
    }catch(error){const code=error instanceof Error?error.message:'';reply(409,{code:['ACCOUNT_SWITCH_REQUIRES_NEW_STORE','CLIENT_IDENTITY_MISMATCH','CONTROL_BUSY','PAUSE_REQUIRED','SETTINGS_KEY_REQUIRED'].includes(code)?code:'CONTROL_OR_KEY_UNAVAILABLE'});}
  });server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // In app mode stdout is a private parent pipe, not a diagnostic log. The
  // authenticated fragment is consumed by the existing UI and removed immediately.
  if(options.desktopNonce)process.stdout.write(JSON.stringify({schema:'spindle.desktop-ready/v1',nonce:options.desktopNonce,url:`${origin}/#${token}`})+'\n');
  else console.log(`Spindle PREVIEW: ${origin}/#${token}`);
  if(!options.noOpen)openInspector(`${origin}/#${token}`);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void close());
  if(options.desktopNonce){process.stdin.resume();process.stdin.once('end',()=>void close());}
  return {close};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args[0]==='--timer-only'){
    if(args[1]!=='--control-directory'||!args[2]||args.length>4||args[3]!==undefined&&args[3]!=='--no-open')throw Error('TIMER_ONLY_ARGUMENTS_REQUIRED');
    const runtime=await runTimerOnly(args[2],args[3]==='--no-open');console.log(`Timer-only desktop controls: ${runtime.origin} (capture unavailable; authenticated URL stays with trusted launcher)`);
  }else{
    let remoteProvider:TextProvider|undefined;
    if(process.env.SPINDLE_NEBIUS_CONFIG){try{remoteProvider=configuredNebius(process.env.SPINDLE_NEBIUS_CONFIG);}catch{console.log('REMOTE_CONFIGURATION_UNAVAILABLE: capture/local labels remain available');}}
    try{await runPreview(undefined,remoteProvider,previewLaunchOptions(args));}catch(error){
    const code=error instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'STARTUP_FAILED';
    console.error(`Spindle did not start: ${code}`);
    try{
      const root=resolve(here,'../../..');let identity:{source?:string;sourceDirty?:boolean;fingerprint?:string}={};
      try{const meta=JSON.parse(await readFile(join(root,'preview-build.json'),'utf8'));if(typeof meta.source==='string'&&/^[a-f0-9]{40}$/.test(meta.source))identity={source:meta.source,sourceDirty:meta.sourceDirty===true,...(typeof meta.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(meta.fingerprint)?{fingerprint:meta.fingerprint}:{})};}catch{/* development tree */}
      const feedbackDirectory=args[0]==='--desktop-shell'?dataDirectory():join(root,'.local');
      await mkdir(feedbackDirectory,{recursive:true,mode:0o700});
      await writeFile(join(feedbackDirectory,'launcher-feedback.json'),JSON.stringify({schema:'spindle-preview-launcher-feedback/v1',...identity,platform:process.platform,arch:process.arch,code,nativeAcceptance:'not-validated'}),{mode:0o600});
    }catch{/* A read-only package still reports the content-free console code. */}
    // Bootstrap can fail after an IPC handle exists. Exit closes every private
    // child pipe, releasing the lease and stopping the still-paused native worker.
    process.exit(1);
    }
  }
}
