// Actual Linux desktop-control frontend + web + extension/worker/Native Messaging.
// Use an isolated Xvfb display; no native capture/installed Windows/Mac claim.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {runTimerOnly} from '../../core/preview/timer-only.js';
await mkdir('.local',{recursive:true});
const directory=await mkdtemp(join(process.cwd(),'.local/pmn-'));
const serverKey=randomBytes(32);let backend=await startTrackingServer(join(directory,'server'),serverKey),backendActive=true;
const host=await runTimerOnly(join(directory,'control'),true);
const home=join(directory,'home'),config=join(home,'.config');await mkdir(config,{recursive:true});
const extensionPath=resolve('build/browser-extension/preview');
const context=await chromium.launchPersistentContext(join(directory,'profile'),{executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:false,env:{...process.env,HOME:home,XDG_CONFIG_HOME:config,CHROME_CONFIG_HOME:config},args:['--no-sandbox',`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
const browser=context.browser()!;const desktopContext=await browser.newContext(),webContext=await browser.newContext();
let passed=false,paired=false,options:Page|undefined,pairingCode='';const errors:string[]=[];const watch=(page:Page)=>page.on('pageerror',error=>errors.push(error.message));
async function ready(page:Page,action:string,revision?:number){await page.bringToFront();if(revision!==undefined)await page.waitForFunction(expected=>document.querySelector('.revision')?.textContent?.startsWith(`Shared revision ${expected} ·`),revision);await page.getByRole('button',{name:action,exact:true}).waitFor();}
async function signin(page:Page,register=false){await page.locator('[name=account]').fill('invented-three-surfaces');await page.locator('[name=password]').fill('invented-only-password');if(register)await page.locator('[name=register]').check();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='online');}
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const launcher=join(directory,'native-host.sh');const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('build/core/preview/browser-host.js'))} "$@" --control-directory ${quote(join(directory,'control'))}\n`,{mode:0o700});
 const hosts=join(directory,'profile/NativeMessagingHosts');await mkdir(hosts,{recursive:true,mode:0o700});
 await writeFile(join(hosts,'ai.berlayar.spindle.preview.json'),JSON.stringify({name:'ai.berlayar.spindle.preview',description:'Run-owned invented Pomodoro integration check',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 const web=await webContext.newPage();watch(web);await web.goto(backend.origin+'/pomodoro/app/');await signin(web,true);
 const desktop=await desktopContext.newPage();watch(desktop);await desktop.goto(host.url);await desktop.locator('#pomodoro-origin').fill(backend.origin);await signin(desktop);
 await desktop.waitForFunction(()=>document.querySelector('#capture-controls')?.hasAttribute('hidden'));
 assert.equal(await desktop.locator('#capture-controls').isVisible(),false);
 options=await context.newPage();watch(options);await options.goto(`chrome-extension://${id}/options.html`);
 const code=pairingCode=await desktop.locator('#pomodoro-pair').innerText();assert.match(code,/^[a-f0-9]{32}$/);
 await options.locator('#code').fill(code);await options.getByRole('button',{name:'Pair this profile',exact:true}).click();
 await options.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('Paired'),{},{timeout:8000});paired=true;
 const extension=await context.newPage();watch(extension);await extension.goto(`chrome-extension://${id}/pomodoro/pomodoro.html`);
 await extension.waitForFunction(()=>document.querySelector('.account')?.textContent==='Not signed in');
 // Pairing alone must not reveal a timer. Desktop explicitly grants this identity/profile.
 assert.equal(await extension.locator('.countdown').innerText(),'—');
 await desktop.bringToFront();await desktop.locator('#pomodoro-extension-access').check();await desktop.getByRole('button',{name:'Apply timer access',exact:true}).click();await desktop.getByText('Paired profile may control this account timer.',{exact:true}).waitFor();
 await extension.bringToFront();await extension.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await ready(extension,'Start focus');
 await web.bringToFront();await web.locator('.focus-duration').fill('1');await web.locator('.break-duration').fill('0.5');await web.getByRole('button',{name:'Start focus',exact:true}).click();
 await ready(extension,'Pause',1);await extension.getByRole('button',{name:'Pause',exact:true}).click();
 await ready(desktop,'Resume',2);await desktop.getByRole('button',{name:'Resume',exact:true}).click();
 await ready(web,'End phase',3);await web.getByRole('button',{name:'End phase',exact:true}).click();
 await ready(extension,'Start next phase',4);await extension.getByRole('button',{name:'Start next phase',exact:true}).click();
 await ready(desktop,'Pause',5);assert.equal(await desktop.locator('.phase').textContent(),'Break');
 await desktop.getByRole('button',{name:'Reset',exact:true}).click();await ready(extension,'Start focus',6);await ready(web,'Start focus',6);
 for(const page of [web,desktop,extension])assert.match(await page.locator('.revision').innerText(),/revision 6/);
 // Stop the ACTUAL owned extension worker, then reopen its page. No injected
 // session/token/timer state: persisted profile enrollment must restore the bridge.
 const cdp=await context.newCDPSession(extension);
 const version=(status:string)=>new Promise<string>((resolve,reject)=>{const timeout=setTimeout(()=>{cdp.off('ServiceWorker.workerVersionUpdated',listener);reject(Error('WORKER_STATE_TIMEOUT'));},10000);const listener=(event:{versions:{versionId:string;scriptURL:string;runningStatus:string}[]})=>{const found=event.versions.find(v=>v.scriptURL===worker.url()&&v.runningStatus===status);if(found){clearTimeout(timeout);cdp.off('ServiceWorker.workerVersionUpdated',listener);resolve(found.versionId);}};cdp.on('ServiceWorker.workerVersionUpdated',listener);});
 const running=version('running');await cdp.send('ServiceWorker.enable');const versionId=await running;const stoppedWorker=version('stopped');await cdp.send('ServiceWorker.stopWorker',{versionId});await stoppedWorker;
 await extension.reload();await ready(extension,'Start focus',6);await extension.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='online');await cdp.detach();
 // Restart the actual account service while the timer is RUNNING. Independent
 // browser and host/extension sessions must preserve its exact deadline/revision.
 await web.bringToFront();await web.getByRole('button',{name:'Start focus',exact:true}).click();await ready(extension,'Pause',7);await ready(desktop,'Pause',7);
 const readWeb=()=>web.evaluate(async()=>{const session=await(await fetch('/pomodoro/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();return(await fetch('/pomodoro/read',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'})).json();});
 const beforeRestart=await readWeb(),port=Number(new URL(backend.origin).port);await backend.close();backendActive=false;backend=await startTrackingServer(join(directory,'server'),serverKey,port);backendActive=true;
 for(const page of [web,desktop,extension]){await page.bringToFront();await page.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await ready(page,'Pause',7);}
 const afterRestart=await readWeb();assert.equal(afterRestart.timer.deadlineAt,beforeRestart.timer.deadlineAt);assert.equal(afterRestart.timer.revision,7);assert.equal(afterRestart.timer.status,'running');
 await desktop.bringToFront();await desktop.getByRole('button',{name:'Reset',exact:true}).click();await ready(extension,'Start focus',8);await ready(web,'Start focus',8);
 // Retain an ACTUAL host-issued session from the real extension page, switch
 // the host account to B at the SAME revision, then deliver that old typed command
 // through the real worker/Native Messaging path. No fabricated identity/binding.
 const oldSession=await extension.evaluate(async()=>{const response=await chrome.runtime.sendMessage({kind:'pomodoro',request:{action:'session'}});return {ok:response.ok,binding:response.value?.binding};});assert.equal(oldSession.ok,true);
 const hostApi=async(action:string,value:unknown)=>{const response=await fetch(host.origin+'/pomodoro/'+action,{method:'POST',headers:{Origin:host.origin,Authorization:'Bearer '+new URL(host.url).hash.slice(1),'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(response.status,200);return response.json();};
 await hostApi('signin',{origin:backend.origin,name:'invented-three-surfaces-bob',password:'invented-only-password',register:true});const bob=await hostApi('session',{});
 for(let i=0;i<8;i++)await hostApi('command',{binding:bob.binding,command:{id:'bob-reset-'+i,expectedRevision:i,action:'reset'}});
 await hostApi('access',{binding:bob.binding,enabled:true});
 const rejected=await extension.evaluate(async binding=>await chrome.runtime.sendMessage({kind:'pomodoro',request:{action:'command',binding,command:{id:'stale-actual-extension',expectedRevision:8,action:'start'}}}),oldSession.binding);assert.equal(rejected.ok,false);assert.equal(rejected.code,'ACCOUNT_CHANGED');
 const bobState=await hostApi('read',{binding:bob.binding});assert.equal(bobState.timer.revision,8);assert.equal(bobState.timer.status,'idle');assert.equal(bobState.timer.durations.focusMs,25*60000);
 await extension.reload();await ready(extension,'Start focus',8);assert.match(await extension.locator('.account').innerText(),/invented-three-surfaces-bob/);
 await desktop.bringToFront();await desktop.waitForFunction(()=>document.querySelector('.account')?.textContent==='Not signed in');await desktop.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await ready(desktop,'Start focus',8);
 // Explicit grant disable and profile revoke remove actual extension access without ending shared timer.
 await desktop.bringToFront();await desktop.locator('#pomodoro-extension-access').uncheck();await desktop.getByRole('button',{name:'Apply timer access',exact:true}).click();await extension.bringToFront();await extension.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await extension.waitForFunction(()=>document.querySelector('.account')?.textContent==='Not signed in');assert.equal(await extension.locator('.countdown').innerText(),'—');
 await desktop.bringToFront();await desktop.locator('#pomodoro-extension-access').check();await desktop.getByRole('button',{name:'Apply timer access',exact:true}).click();await extension.bringToFront();await extension.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await ready(extension,'Start focus');
 await options.bringToFront();await options.getByRole('button',{name:'Revoke local enrollment',exact:true}).click();await extension.bringToFront();await extension.getByRole('button',{name:'Refresh / reconnect',exact:true}).click();await extension.waitForFunction(()=>document.querySelector('.account')?.textContent==='Not signed in');
 await ready(web,'Start focus',8);assert.match(await web.locator('.revision').innerText(),/revision 8/);
 assert.deepEqual(errors,[]);
 await writeFile('.local/pomodoro-three-surfaces-result.json',JSON.stringify({result:'PASS',method:'Actual Chromium web, same actual desktop control frontend/guarded HTTP+IPC in explicit timer-only mode, real unpacked extension/page/worker and Native Messaging host',scope:'Linux timer-only integration; NOT native capture/installed Windows/Mac/physical-device proof',browser:browser.version(),extensionId:id,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),flow:'webStart -> extensionPause -> desktopResume -> webEnd -> extensionNextBreak -> desktopReset; all revision6, then actual running account-server restart preserves exactdeadline/revision7 and resetconverges8; actual extension worker stopped viaCDP and page cold-reloaded, canonical state/bridge restored; same-revision staleA->newB actual extension command rejected before mutation; pairing-alone denied, grant disable and profile revoke clear extension view',nativeHostRegistration:'Only new isolated Chromium user-data-dir/NativeMessagingHosts (measured actual lookup); HOME/XDG_CONFIG_HOME also isolated; no existing user/global registration changed',at:new Date().toISOString()},null,2));
 passed=true;console.log('PASS actual desktop controls + web + real extension/worker/Native Messaging synchronize; running server restart, cold worker, account fences and grants/revoke verified. Timer-only Linux, not installed/native capture.');
}catch(error){
 if(options&&pairingCode&&!paired){const diagnostic=await options.evaluate(code=>new Promise(resolve=>chrome.runtime.sendNativeMessage('ai.berlayar.spindle.preview',{schema:'spindle-browser-preview/v1',id:999,kind:'pair',code},response=>resolve({error:chrome.runtime.lastError?.message??null,ok:response?.ok===true}))),pairingCode).catch(()=>({error:'DIAGNOSTIC_UNAVAILABLE'}));await writeFile(join(directory,'native-diagnostic.json'),JSON.stringify(diagnostic));console.error('Native Messaging diagnostic (no token):',JSON.stringify(diagnostic));}
 const pages=[...context.pages(),...desktopContext.pages(),...webContext.pages()];for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:join(directory,`failure-${i}.png`)}).catch(()=>{});console.error('Run-owned failure artifacts retained at',directory);throw error;}
finally{await desktopContext.close();await webContext.close();await context.close();await host.close();if(backendActive)await backend.close();if(passed)await rm(directory,{recursive:true,force:true});}
