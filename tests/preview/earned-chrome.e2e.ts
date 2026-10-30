// Linux browser journey for the shared desktop page + compact Chrome controls +
// study -> earned leisure. ACTUAL: account HTTP server, encrypted TrackingClient,
// EarnedControl, PomodoroControl, served index.html/ui.js/shared assets,
// browser-host.js Native Messaging, unpacked extension, blocking worker and DNR
// in Chromium. HARNESS (not app.ts): this file's IPC/HTTP routes mirror app.ts
// only for the routes used, and /state is scripted because the native capture
// helper, OS key and settings vault do not run on Linux. Invented data only; no
// native capture, installed Mac/Windows or real Chrome profile claim.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as ipcServer} from 'node:net';
import type {AddressInfo} from 'node:net';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';
import {EarnedControl,earnedCode} from '../../core/preview/earned-control.js';
import {PomodoroControl} from '../../core/preview/pomodoro-control.js';
import {previewUiAsset} from '../../core/preview/ui-assets.js';
import {pomodoroAsset} from '../../core/pomodoro/assets.js';
const media=resolve(process.env.SPINDLE_EARNED_MEDIA??'.local/earned-chrome/media');await mkdir(media,{recursive:true});
await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/earned-chrome-'));
const NAME='invented-leisure-demo',PASSWORD='invented-only-password';
const backend=await startTrackingServer(join(directory,'server'),randomBytes(32));
const client=new TrackingClient(backend.origin,join(directory,'client'),randomBytes(32));await client.signin(NAME,PASSWORD,'Invented Linux harness',true);
const reader=new AccountClient(backend.origin);await reader.signin(NAME,PASSWORD);await reader.request('/processing',{local:true});
let profile:string|undefined,pair=randomBytes(16).toString('hex');
const earned=new EarnedControl(()=>profile,()=>client);
const timer=new PomodoroControl(()=>profile,()=>earned.revoke());
const control=join(directory,'control');await mkdir(control,{recursive:true,mode:0o700});
const secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex'),ipcPath=join(control,'ipc.sock');
const ipc=ipcServer(socket=>{const abort=new AbortController();socket.on('close',()=>abort.abort());socket.on('error',()=>{});let text='';socket.on('data',chunk=>{text+=chunk;const i=text.indexOf('\n');if(i<0)return;void(async()=>{
 const m=JSON.parse(text.slice(0,i));if(m.secret!==secret){socket.destroy();return;}let result:unknown={ok:false};
 if(m.kind==='pair'&&m.code===pair&&!profile){profile=randomBytes(32).toString('hex');earned.revoke();timer.revokeProfile();result={ok:true,profileToken:profile};}
 else if(m.kind==='revoke'&&m.profileToken===profile){profile=undefined;pair=randomBytes(16).toString('hex');earned.revoke();timer.revokeProfile();result={ok:true};}
 else if(m.kind==='earned')result=await earned.extension(m.data,m.profileToken,abort.signal);
 else if(m.kind==='pomodoro')result=await timer.extension(m.data,m.profileToken,abort.signal);
 if(!socket.destroyed)socket.end(JSON.stringify(result)+'\n');})();});});
await new Promise<void>(r=>ipc.listen(ipcPath,r));await writeFile(join(control,'connection.json'),JSON.stringify({ipcPath,secret}),{mode:0o600});
let origin='';
const server=httpServer(async(req,res)=>{
 const reply=(status:number,body:unknown,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'"});res.end(type.startsWith('application/json')?JSON.stringify(body):body as string|Buffer);};
 try{
  const url=req.url??'';
  if(req.method==='GET'&&['/','/ui.js'].includes(url)){reply(200,await readFile(resolve('build/core/preview',url==='/'?'index.html':'ui.js')),url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');return;}
  if(req.method==='GET'){const asset=await previewUiAsset(url);if(asset){reply(200,asset.body,asset.type);return;}}
  if(req.method==='GET'&&url.startsWith('/pomodoro/')){const asset=await pomodoroAsset(url.replace('/pomodoro/','/pomodoro/app/'));if(asset){reply(200,asset.body,asset.type);return;}}
  if(req.headers.authorization!==`Bearer ${token}`){reply(401,{code:'UNAUTHORIZED'});return;}
  if(url==='/state'){reply(200,{generation:1,platform:'linux-harness',recording:false,provider:'not-native',lastCode:'LINUX_HARNESS_NO_CAPTURE',capabilities:{accessibility:'not-reported',screenRecording:'not-reported'},pair:profile?'enrolled':pair,visits:[],settingsReady:true,timerOrigin:backend.origin,preferences:null,pomodoroAccess:timer.accessEnabled,earnedAccess:earned.accessEnabled});return;}
  if(url==='/tracking/status'){const {entries:_,...summary}=await client.inspect();reply(200,{setup:{origin:backend.origin,name:NAME,deviceName:summary.deviceName},historyStatus:'disabled',client:summary});return;}
  if(url==='/auth/workos/status'){reply(200,{state:'idle'});return;}
  let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw||'{}');
  const action=/^\/pomodoro\/(signin|session|read|command|signout|access)$/.exec(url);
  if(action){try{reply(200,await timer.route(action[1]!,data));}catch(error){reply(409,{code:error instanceof Error?error.message:'INVALID_POMODORO_REQUEST'});}return;}
  if(url.startsWith('/earned/')){try{
   if(url==='/earned/read'){reply(200,await earned.local('read'));return;}
   if(url==='/earned/opt-in'){reply(200,await earned.local('opt-in',{enabled:data.enabled}));return;}
   if(url==='/earned/access'){reply(200,await earned.setAccess(data.enabled));return;}
  }catch(error){reply(409,{code:earnedCode(error,'EARNED_REQUEST_REFUSED')});return;}}
  reply(404,{code:'LINUX_HARNESS_UNAVAILABLE'});
 }catch{reply(500,{code:'HARNESS_FAILED'});}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const leisure=httpServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Invented leisure</title><h1>Invented leisure page</h1><p>Invented fixture content only.</p>');});
await new Promise<void>(r=>leisure.listen(0,'127.0.0.1',r));const leisureUrl=`http://leisure.test:${(leisure.address() as AddressInfo).port}/`;
const home=join(directory,'home'),config=join(home,'.config');await mkdir(config,{recursive:true});
// Run-owned copy of the built extension. Its manifest pre-grants ONLY the invented
// leisure.test host so automation needs no native permission bubble (production asks
// in a user gesture); every other byte is the build output.
const extensionPath=join(directory,'extension');await cp(resolve('build/browser-extension/preview'),extensionPath,{recursive:true});
const manifest=JSON.parse(await readFile(join(extensionPath,'manifest.json'),'utf8'));manifest.host_permissions=['http','https'].flatMap(p=>[`${p}://leisure.test/*`,`${p}://leisure.test./*`]);await writeFile(join(extensionPath,'manifest.json'),JSON.stringify(manifest));
const context=await chromium.launchPersistentContext(join(directory,'profile'),{executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:false,viewport:{width:1280,height:860},env:{...process.env,HOME:home,XDG_CONFIG_HOME:config,CHROME_CONFIG_HOME:config},args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1',`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
const errors:string[]=[];const watch=(page:Page)=>{page.on('pageerror',error=>errors.push(error.message));return page;};
const shot=async(page:Page,name:string)=>{await page.bringToFront();await page.screenshot({path:join(media,name),fullPage:true});console.log('SCREENSHOT',join(media,name));};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let passed=false;
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const launcher=join(directory,'native-host.sh'),quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('build/core/preview/browser-host.js'))} "$@" --control-directory ${quote(control)}\n`,{mode:0o700});
 const hosts=join(directory,'profile/NativeMessagingHosts');await mkdir(hosts,{recursive:true,mode:0o700});
 await writeFile(join(hosts,'ai.berlayar.spindle.preview.json'),JSON.stringify({name:'ai.berlayar.spindle.preview',description:'Run-owned invented earned-leisure check',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 // 1. Shared desktop page: real timer account + Lock-in dial.
 const desktop=watch(await context.newPage());await desktop.goto(`${origin}/#${token}`);
 await desktop.waitForFunction(()=>document.querySelector('.fd-ring')!==null);
 await desktop.locator('#pomodoro-setup summary').click();await desktop.locator('#pomodoro-origin').fill(backend.origin);await desktop.locator('#pomodoro-setup summary').click();
 await desktop.locator('[name=account]').fill(NAME);await desktop.locator('[name=password]').fill(PASSWORD);await desktop.locator('.signin button[type=submit]').click();
 await desktop.locator('[data-action=start]').click();
 await desktop.waitForFunction(()=>document.querySelector('.fd-eyebrow')?.textContent==='In focus');
 // 2. Explicit opt-in on the local page, then invented observed study labelled by the user.
 await desktop.locator('#earned-optin').check();await desktop.locator('#earned-optin-apply').click();
 await desktop.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.startsWith('Counting starts now'));
 const deviceId=(await client.inspect()).deviceId,start=Date.now(),visitId=randomUUID();
 const op:Operation={id:randomUUID(),deviceId,recordingId:'invented-demo',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-demo',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:start,monotonicAnchor:0,observedAt:46000,expiresAt:start+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:46000,coverage:'observed'},visit:{id:visitId,key:'invented-editor',app:'invented-editor',title:'Invented fractions notes',start:0,end:46000,clock:'owned-clock',revision:1,browser:false,text:'Invented study notes about fractions.',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:start+3600000}}};
 // 3. Pair this Chrome profile while the invented visit accrues observed time.
 const options=watch(await context.newPage());await options.goto(`chrome-extension://${id}/options.html`);
 await options.locator('#code').fill(await desktop.locator('#pair').innerText());await options.locator('#pair').click();
 await options.waitForFunction(()=>document.querySelector('#status')?.textContent?.startsWith('Paired.'));await shot(options,'chrome-options-paired.png');
 await pause(Math.max(0,start+47000-Date.now()));await client.enqueue(op);await client.sync();
 await reader.request('/corrections',{key:recordKey(op),evidenceRevision:1,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}});
 await desktop.bringToFront();await desktop.locator('#earned-refresh').click();
 await desktop.waitForFunction(()=>/^46 s available/.test(document.querySelector('#earned-balance')?.textContent??''));
 // 4. Separate explicit earned grant for the paired profile (timer access stays off).
 await desktop.locator('#earned-access').check();await desktop.locator('#earned-access-apply').click();
 await desktop.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.startsWith('This paired Chrome profile may'));
 assert.equal(await desktop.locator('#pomodoro-extension-access').isChecked(),false,'timer grant is separate');
 await shot(desktop,'desktop-shared-page.png');
 // 5. Compact Chrome blocking page: block, then spend earned time through the bridge.
 const blocking=watch(await context.newPage());await blocking.goto(`chrome-extension://${id}/blocking.html`);
 await blocking.locator('#host').fill('leisure.test');await blocking.locator('button').first().click();
 await blocking.waitForFunction(()=>document.querySelector('output')?.textContent?.startsWith('Active:'),null,{timeout:60000});
 const visit=watch(await context.newPage());await assert.rejects(visit.goto(leisureUrl),/ERR_BLOCKED_BY_CLIENT/);console.log('PASS leisure.test blocked by existing DNR');
 await blocking.bringToFront();await blocking.reload();
 await blocking.waitForFunction(()=>/^46 s available/.test(document.querySelector('#earned-balance')?.textContent??'')&&!(document.querySelector('#earned-use') as HTMLButtonElement).disabled,null,{timeout:20000});
 await shot(blocking,'chrome-blocking-earned-before.png');
 await blocking.locator('#earned-seconds').fill('30');await blocking.locator('#earned-use').click();
 await blocking.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.startsWith('Earned pause applied'),null,{timeout:20000}).catch(async error=>{throw Error(`EARNED_STATUS: ${await blocking.locator('#earned-status').innerText()} / ${await blocking.locator('output').innerText()}`,{cause:error});});
 await blocking.waitForFunction(()=>document.querySelector('output')?.textContent?.startsWith('Paused:')&&/^16 s available/.test(document.querySelector('#earned-balance')?.textContent??''),null,{timeout:20000});
 const policy=await blocking.evaluate(async()=>(await chrome.storage.local.get('sitePolicy')).sitePolicy);
 assert.equal(typeof policy.earnedLease,'string');assert.ok(policy.pausedUntil<=Date.now()+30_500);console.log('PASS earned lease applied via worker readback',policy.earnedLease);
 await shot(blocking,'chrome-blocking-earned-applied.png');
 await visit.goto(leisureUrl);assert.equal(await visit.locator('h1').innerText(),'Invented leisure page');console.log('PASS leisure.test opens during earned pause');
 await visit.bringToFront();await pause(1500);
 // 6. Revoking the grant on the desktop stops Chrome from reading/spending.
 await desktop.bringToFront();await desktop.locator('#earned-access').uncheck();await desktop.locator('#earned-access-apply').click();
 await desktop.waitForFunction(()=>document.querySelector('#earned-status')?.textContent==='Chrome earned-leisure access is off.');
 await blocking.bringToFront();await blocking.reload();
 await blocking.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.startsWith('Not allowed yet'),null,{timeout:20000});
 await shot(blocking,'chrome-blocking-earned-revoked.png');
 // 7. Expiry: the worker's own alarm restores blocking (Chrome alarms may run late, never early).
 await visit.bringToFront();await pause(Math.max(0,policy.pausedUntil-Date.now()+1500));
 await blocking.reload();await blocking.waitForFunction(()=>document.querySelector('output')?.textContent?.startsWith('Active:'),null,{timeout:90000});
 await assert.rejects(visit.goto(leisureUrl),/ERR_BLOCKED_BY_CLIENT/);console.log('PASS block restored after earned pause');
 assert.deepEqual(errors,[]);passed=true;console.log('PASS earned chrome journey');
}finally{
 await context.close().catch(()=>{});earned.close();await timer.close().catch(()=>{});server.close();leisure.close();ipc.close();await backend.close();
 if(passed)await rm(directory,{recursive:true,force:true});else console.error('Run diagnostics retained:',directory);
}
