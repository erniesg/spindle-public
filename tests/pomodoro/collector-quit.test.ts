// Production regular-preview close body + real timer/account; capture settlement
// and OS helper/filesystem are substituted. Not native/installed acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {startTrackingServer} from '../../core/tracking/server.js';
import {PomodoroControl} from '../../core/preview/pomodoro-control.js';
import {PreviewWorkOSControl} from '../../core/preview/workos-control.js';
import type {DesktopWorkOSCallback} from '../../core/account/workos-desktop.js';

test('regular host Quit retires timer and stops native acquisition before collector and native authentication settlement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'timer-collector-quit-')),server=await startTrackingServer(directory,randomBytes(32));
 const pomodoro=new PomodoroControl(()=> 'invented-paired-profile');
 let release!:()=>void;const drain=new Promise<void>(resolve=>{release=resolve;});let closing:Promise<void>|undefined;
 let finishExchange!:(response:Response)=>void,exchangeArrived!:()=>void,releaseRevocation!:()=>void,revocationArrived!:()=>void;
 const exchangeWaiting=new Promise<void>(r=>exchangeArrived=r),revocationWaiting=new Promise<void>(r=>revocationArrived=r),revocationDrain=new Promise<void>(r=>releaseRevocation=r);
 let acceptCallback!:(value:DesktopWorkOSCallback)=>void,rejectCallback!:(error:Error)=>void,cancellations=0;
 const callback=new Promise<DesktopWorkOSCallback>((resolve,reject)=>{acceptCallback=resolve;rejectCallback=reject;}),revoked:string[]=[];
 const account={id:'12345678-1234-1234-1234-123456789abc',name:'workos-quit'},envelope=(letter:string)=>({account,cookie:'spindle_session='+letter.repeat(64),csrf:letter.repeat(64)});
 const issued={account,tracking:envelope('a'),timer:envelope('b')};
 const workos=new PreviewWorkOSControl({persistCleanup:async()=>{},
  transport:async input=>String(input).endsWith('/config')?Response.json({configured:true,clientId:'client_invented',backendOrigin:server.origin}):new Promise<Response>(resolve=>{finishExchange=resolve;exchangeArrived();}),
  start:async()=>({authorizationUrl:'https://api.workos.com/user_management/authorize',callback,cancel:async()=>{cancellations++;rejectCallback(Error('WORKOS_DESKTOP_CANCELLED'));}}),
  adopt:async()=>{assert.fail('a shutdown native exchange must never adopt credentials');},
  revoke:async(_origin,session)=>{revocationArrived();await revocationDrain;revoked.push(session.cookie);},
 });
 try{
  const identity=await pomodoro.route('signin',{origin:server.origin,name:'invented-quit','password':'invented-password-123',register:true}) as {binding:string};
  await pomodoro.route('access',{binding:identity.binding,enabled:true});
  await workos.begin({origin:server.origin,deviceName:'Invented shutdown host',syncConsent:true},()=>{});
  acceptCallback({code:'invented-code',codeVerifier:'invented-verifier',redirectUri:'http://127.0.0.1:43168/auth/callback'});await exchangeWaiting;
  const source=await readFile(new URL('../../core/preview/app.js',import.meta.url),'utf8');
  const close=source.match(/const close = (async \(\) => \{[\s\S]*?\});\n    const server/);
  assert.ok(close,'actual compiled regular-preview close body required');
  let timerClosing:Promise<void>|undefined;
  const stop=()=>{};const nativeCommands:string[]=[];let fixturesStopped=false,watchdogArmed=false,earnedClosed=false;
  const context={closed:false,workos,options:{},invalidateStores:()=>{void workos.retire().catch(()=>{});},stores:{close:()=>drain},retireTracking:stop,controls:{settle:async()=>{}},tracking:{settle:async()=>{}},pomodoro:{close:()=>{timerClosing=pomodoro.close();return timerClosing;}},purpose:{close:stop},earned:{close:()=>{earnedClosed=true;}},expiry:0,syncTimer:0,clearInterval:stop,session:{pause:stop},nativeNow:()=>0,stopHistory:()=>drain,classification:{dispose:stop},fixtures:{stop:()=>{fixturesStopped=true;}},send:(command:{action:string})=>nativeCommands.push(command.action),setTimeout:()=>{watchdogArmed=true;return {unref:stop};},helper:{kill:stop},vault:{settle:async()=>{}},settings:{settle:async()=>{}},key:null,workosJournalKey:null,connections:new Set(),ipc:{close:stop},server:{close:stop,closeAllConnections:stop},rm:async()=>{},join,directory,ipcPath:'unused-component-ipc',process:{platform:'linux'}};
  const actualClose=runInNewContext('('+close[1]+')',context) as ()=>Promise<void>;
  const accessResult=pomodoro.route('access',{binding:identity.binding,enabled:true}).then(()=>({ok:true,message:''}),error=>({ok:false,message:String(error.message)}));
  let hostClosed=false;closing=actualClose().then(()=>{hostClosed=true;});
  assert.ok(cancellations>=1,'production Quit cancels the active native listener immediately');
  assert.deepEqual(nativeCommands,['quit'],'native shutdown must not wait for held collector/disk settlement');
  assert.equal(fixturesStopped,true,'owned fixtures stop before disk settlement');
  assert.equal(earnedClosed,true,'earned authority closes before held collector/disk settlement');
  assert.equal(watchdogArmed,true,'native kill watchdog is armed before disk settlement');
  await assert.rejects(pomodoro.route('session',{}),/SIGNIN_REQUIRED|HOST_CLOSING/);
  // These arrivals model HTTP bodies delivered after Quit was acknowledged,
  // while the actual regular close body remains held on collector settlement.
  await assert.rejects(pomodoro.route('signin',{origin:server.origin,name:'invented-quit',password:'invented-password-123'}),/HOST_CLOSING/);
  await assert.rejects(pomodoro.route('access',{binding:identity.binding,enabled:true}),/HOST_CLOSING/);
  await assert.rejects(pomodoro.route('command',{binding:identity.binding,command:{id:'late-quit',expectedRevision:0,action:'start'}}),/HOST_CLOSING/);
  const resumedAccess=await accessResult;assert.equal(resumedAccess.ok,false,'pre-Quit access resumed after an await must not republish a grant');assert.match(resumedAccess.message,/HOST_CLOSING/);
  assert.equal(pomodoro.accessEnabled,false);
  assert.equal((await pomodoro.extension({action:'read',binding:identity.binding},'invented-paired-profile')).ok,false);
  assert.ok(timerClosing,'production close must begin real timer retirement');await timerClosing;
  release();await new Promise<void>(r=>setImmediate(r));
  assert.equal(hostClosed,false,'collector drain alone must not complete shutdown while native exchange is pending');
  finishExchange(Response.json(issued));await revocationWaiting;
  assert.equal(hostClosed,false,'shutdown waits for revocation of sessions issued after cancellation');
  releaseRevocation();await closing;
  assert.deepEqual(revoked.sort(),[issued.tracking.cookie,issued.timer.cookie].sort());
  await assert.rejects(workos.begin({origin:server.origin,deviceName:'late',syncConsent:true},()=>{}),/WORKOS_HOST_CLOSING/);
 }finally{release();finishExchange?.(Response.json(issued));releaseRevocation();try{await closing;}finally{await workos.close().catch(()=>{});await pomodoro.close().catch(()=>{});await server.close();await rm(directory,{recursive:true,force:true});}}
});
