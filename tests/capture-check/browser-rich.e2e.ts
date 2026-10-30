// Actual disposable Chromium action -> captureVisibleTab -> Native Messaging ->
// shared session -> encrypted file. Native foreground/key peer is SYNTHETIC;
// fixture-origin install permission substitutes for the untested OS permission UI.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { PreviewSession } from '../../core/preview/session.js';
import { CaptureClassification } from '../../core/preview/classification.js';
import { Vault } from '../../core/preview/vault.js';
import { CollectorHistory } from '../../core/tracking/collector.js';
import { TrackingClient } from '../../core/tracking/client.js';
import { startTrackingServer } from '../../core/tracking/server.js';
import {pomodoroAsset} from '../../core/pomodoro/assets.js';

await mkdir('.local',{recursive:true});
const directory=await mkdtemp(resolve('.local/browser-rich-browser-'));
const profile=join(directory,'profile'),extension=join(directory,'extension'),home=join(directory,'home');
const session=new PreviewSession(),vault=new Vault(join(directory,'vault')),key=Buffer.alloc(32,19);
const classification=new CaptureClassification(session);classification.local(true);
const profileToken='invented-profile-token',secret='invented-ipc-secret';
// Same native-event/receipt mapping as the production owner, but the initial
// native focus event and clock are explicitly simulated in this component test.
let received=performance.now();
const nativeNow=()=>Math.max(0,performance.now()-received);
const reset=(rich=true)=>{session.clear();received=performance.now();session.start({pixels:true,rich,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'synthetic-native-chrome',app:'com.google.Chrome',title:'',clock:'synthetic-native',browser:true});};
const accountServer=await startTrackingServer(join(directory,'account-server'),Buffer.alloc(32,41));
let accountClient=new TrackingClient(accountServer.origin,join(directory,'account-client'),key);
await accountClient.signin('browser-invented-owner','invented-password-123','Synthetic native Chrome',true);
let history=new CollectorHistory(session,accountClient,(await accountClient.inspect()).deviceId,3600000);
reset();await history.settle();let holdContext=false,releaseContext:(()=>void)|null=null;
let imageMessages=0,admissionCount:number|null=null,releaseAdmission:(()=>void)|null=null;
const sockets=new Set<import('node:net').Socket>();
const ipc=createServer(socket=>{
 sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setEncoding('utf8');let text='';
 socket.on('data',chunk=>{text+=chunk;const index=text.indexOf('\n');if(index<0)return;
  const m=JSON.parse(text.slice(0,index));text=text.slice(index+1);assert.equal(m.secret,secret);
  void(async()=>{let result:Record<string,unknown>={ok:false};
   if(m.kind==='pair'&&m.code==='invented-pair-code')result={ok:true,profileToken};
   if(m.profileToken===profileToken){
    if(m.kind==='challenge'){result={challenge:session.challenge(),rich:session.options.rich};if(admissionCount!==null&&++admissionCount===3)await new Promise<void>(r=>{releaseAdmission=r;});}
    if(m.kind==='revoke'){session.revokeBrowser();result={ok:true};}
    if(m.kind==='context'){result={ok:session.browser(m.data,nativeNow())};if(holdContext){holdContext=false;await new Promise<void>(r=>{releaseContext=r;});}}
    if(m.kind==='image'){imageMessages++;const ok=session.browserImage(m.data,nativeNow());if(ok){await vault.write(session.snapshot(),key,900000,()=>true);await history.settle();}result={ok};}
   }
   socket.end(JSON.stringify(result)+'\n');
  })().catch(()=>socket.destroy());
 });
});
const reviewHtml=(await readFile('build/core/preview/index.html','utf8')).replace('<h1>Spindle capture PREVIEW</h1>','<h1>Actual Chromium component · SYNTHETIC native/key peer</h1>');
const reviewJs=await readFile('build/core/preview/ui.js','utf8');
const record=process.env.SPINDLE_BROWSER_RICH_RECORD==='1';
const server=createHttpServer((req,res)=>{void(async()=>{
 if(req.url==='/review'){res.setHeader('Content-Type','text/html');res.end(reviewHtml);return;}
 if(req.url==='/ui.js'){res.setHeader('Content-Type','text/javascript');res.end(reviewJs);return;}
 if(req.url?.startsWith('/pomodoro/')){const asset=await pomodoroAsset(req.url.replace('/pomodoro/','/pomodoro/app/'));if(asset){res.setHeader('Content-Type',asset.type);res.end(asset.body);return;}res.statusCode=401;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'SIGNIN_REQUIRED'}));return;}
 if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...session.snapshot(),platform:'component-test',provider:'SYNTHETIC native/key peer',lastCode:'ACTUAL CHROMIUM API',pair:'test peer'}));return;}
 if(req.url==='/restore'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({saved:await vault.read(key),generation:session.generation}));return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Invented ordinary article</title><style>body{background:rgb(40,150,90);font:30px sans-serif;color:white}</style><h1>INVENTED CHROME ARTICLE</h1><p>Real tab pixels, not an injected PNG.</p>'+(req.url==='/sample/forms'?'<input value="FORM_SENTINEL"><div id="shadow"></div><script>document.getElementById("shadow").attachShadow({mode:"closed"}).innerHTML="<p>INVENTED SHADOW EDITOR</p>";</script>':''));
 })().catch(()=>{res.statusCode=500;res.end('Test peer unavailable');});});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const ipcPath=join(directory,'peer.sock');await new Promise<void>(r=>ipc.listen(ipcPath,r));
let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
try{
 await cp('build/browser-extension/preview',extension,{recursive:true});
 // Test-only scheduler control: fault injection must hold a manual request, not
 // accidentally hold a periodic request and merely exercise the WAIT badge.
 // Positive automatic acquisition below still uses the production scheduler/API.
 const workerPath=join(extension,'worker.js'),workerSource=await readFile(workerPath,'utf8');
 const timer='setInterval(() => void observe(), 1000);';assert.ok(workerSource.includes(timer));
 await writeFile(workerPath,workerSource.replace(timer,`let testTimer=setInterval(() => void observe(),1000);
 globalThis.testObservation={idle:()=>!busy,stop:()=>{clearInterval(testTimer);testTimer=undefined;},start:()=>{if(testTimer===undefined)testTimer=setInterval(()=>void observe(),1000);}};`));
 const publicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
 const extensionId=createHash('sha256').update(publicKey).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
 await writeFile(join(extension,'manifest.json'),JSON.stringify({...manifest,key:publicKey.toString('base64'),host_permissions:['<all_urls>']}));
 const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
 const launcher=join(directory,'native-host');
 await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('build/core/preview/browser-host.js'))} "$@"\n`,{mode:0o700});
 const registration=join(profile,'NativeMessagingHosts','ai.berlayar.spindle.preview.json');await mkdir(dirname(registration),{recursive:true});
 await writeFile(registration,JSON.stringify({name:'ai.berlayar.spindle.preview',description:'Invented browser test',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]}));
 await mkdir(join(home,'.spindle-preview-test'),{recursive:true});await writeFile(join(home,'.spindle-preview-test','connection.json'),JSON.stringify({secret,ipcPath}));
 const launch=(video=false)=>chromium.launchPersistentContext(profile,{executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE,channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging'],env:{...process.env,HOME:home,XDG_CONFIG_HOME:join(directory,'xdg')},viewport:{width:1000,height:700},...(video?{recordVideo:{dir:join(directory,'media'),size:{width:1000,height:700}}}:{})});
 context=await launch();
 let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 const options=await context.newPage();await options.goto(`chrome-extension://${extensionId}/options.html`);
 await options.locator('#code').fill('invented-pair-code');await options.locator('#pair').click();await options.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Paired.'));
 await options.locator('#origin').fill(origin);await options.locator('#allow').click();await options.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Origin permitted.'));
 // Never record pairing/permission entry; restart the same invented profile first.
 if(record){await options.close();await context.close();context=await launch(true);worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');}
 const page=await context.newPage();await page.goto(origin+'/sample/article');await page.bringToFront();
 if(record)await page.waitForTimeout(1800);
 const browser=context.browser();assert.ok(browser);
 const cdp=await browser.newBrowserCDPSession();
 const targets=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
 const target=targets.targetInfos.find(t=>t.url===page.url())?.targetId;assert.ok(target,'CDP toolbar dispatch needs a tab target (Chromium 149+)');
 const send=cdp.send.bind(cdp) as (method:string,params:Record<string,unknown>)=>Promise<unknown>;
 const poll=async(check:()=>boolean|Promise<boolean>,label:string)=>{for(let n=0;n<100;n++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout: '+label+'; history='+history.status+'; recording='+session.recording+'; visits='+session.visits.length);};
 const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0].id);assert.ok(tabId);
 const badge=()=>worker.evaluate(id=>chrome.action.getBadgeText({tabId:id}),tabId);
 const click=async()=>{await worker.evaluate(id=>chrome.action.setBadgeText({tabId:id,text:''}),tabId);await send('Extensions.triggerAction',{id:extensionId,targetId:target});};
 await poll(()=>session.active?.text.includes('INVENTED CHROME ARTICLE')===true,'DOM through real Native Messaging');
 // Instrument ONLY the test's service worker; positive captures delegate to the real API.
 await worker.evaluate(()=>{
  const capture=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
  const state={calls:0,delay:false,release:null as null|(()=>void)};
  (globalThis as typeof globalThis & {testCapture:typeof state}).testCapture=state;
  chrome.tabs.captureVisibleTab=(async(windowId:number,options:chrome.extensionTypes.ImageDetails)=>{state.calls++;const image=await capture(windowId,options);if(state.delay)await new Promise<void>(r=>{state.release=r;});return image;}) as typeof chrome.tabs.captureVisibleTab;
 });
 const calls=()=>worker.evaluate(()=>(globalThis as typeof globalThis & {testCapture:{calls:number}}).testCapture.calls);
 await click();await poll(()=>session.active?.image.length!==0&&!!session.active?.image,'real browser PNG');
 assert.equal(await calls(),1);const image=session.active!.image,id=session.active!.id;assert.ok(image.length>100);
 const saved=await vault.read(key) as {visits:{id:string;image:string}[]};assert.equal(saved.visits.at(-1)?.id,id);assert.equal(saved.visits.at(-1)?.image,image);
 await writeFile(join(directory,'actual-tab.png'),Buffer.from(image,'base64'));
 await page.screenshot({path:join(directory,'fixture-page.png')});
 await page.goto(origin+'/review#test-only-token');await page.locator('#restore').click();await page.locator('#saved img').waitFor();
 assert.equal(await page.locator('#saved img').getAttribute('src'),'data:image/png;base64,'+image);
 await page.locator('#saved').screenshot({path:join(directory,'encrypted-readback.png')});
 if(record)await page.waitForTimeout(3000);
 // Installed all_urls is a TEST substitute for the optional Chrome grant UI.
 // Collection still requires explicit automatic opt-in and an enrolled origin.
 const automaticOptions=record?await context.newPage():options;
 if(record)await automaticOptions.goto(`chrome-extension://${extensionId}/options.html`);
 await page.goto(origin+'/sample/forms');await page.bringToFront();await page.locator('input').fill('EDITED_FORM_SENTINEL');
 // Enable only after the edit, so an earlier in-flight frame cannot satisfy
 // this proof. Wait for both real acquisition and its Native Messaging receipt.
 const beforeAuto=await calls(),beforeAutoMessages=imageMessages;
 await automaticOptions.locator('#automatic').click();await page.bringToFront();
 await poll(()=>calls().then(n=>n>beforeAuto),'automatic edited-page Chrome image');
 await poll(()=>imageMessages>beforeAutoMessages&&session.active?.availability==='browser-automatic-rich-partial','automatic retained image');
 assert.ok(!session.active?.text.includes('FORM_SENTINEL'));
 assert.ok(session.active?.image);
 const automaticId=session.active!.id,automaticRef=classification.inspect(automaticId).ref;
 classification.correct(automaticId,{categoryId:'learning',activityId:'reading',relatedIds:[]},automaticRef);
 assert.equal(classification.inspect(automaticId).source,'override','real automatic Chrome PNG remains admitted by existing classifier/correction');
 const automaticSaved=await vault.read(key) as {visits:{image:string}[]};assert.ok(automaticSaved.visits.at(-1)?.image);
 await writeFile(join(directory,'automatic-edited-tab.png'),Buffer.from(automaticSaved.visits.at(-1)!.image,'base64'));
 if(record)await page.waitForTimeout(3000); // Show the real automatic edited-page path, not only manual readback.
 history.evidence({awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:nativeNow(),coverage:'observed'});await history.settle();assert.ok((await accountClient.inspect()).pending>0);
 // Detach the old writer before reopening the same encrypted pending directory.
 await history.dispose();
 accountClient=new TrackingClient(accountServer.origin,join(directory,'account-client'),key);await accountClient.sync();
 const report=await accountClient.sessions(Date.now()-60000,Date.now()+60000);
 assert.ok(report.visits.some(v=>v.context.availability==='browser-automatic-rich-partial'&&v.context.imageAvailable),'actual signed-in account API reports the automatic Chrome image: '+JSON.stringify(report));
 assert.ok((await accountClient.inspect()).entries.some(e=>e.record?.visit.availability==='browser-automatic-rich-partial'&&e.record.visit.image.length>100),'authenticated sync readback includes the real PNG');
 // Subsequent negative account assertions use a fresh sink on the sole new owner.
 history=new CollectorHistory(session,accountClient,(await accountClient.inspect()).deviceId,3600000);
 await page.goto(origin.replace('127.0.0.1','localhost')+'/sample/denied');await page.bringToFront();
 await new Promise(r=>setTimeout(r,1200));const before=await calls();
 await new Promise(r=>setTimeout(r,1200));assert.equal(await calls(),before,'broad automatic capability does not enroll a different origin');
 await worker.evaluate(()=>chrome.storage.local.set({automaticRich:false}));
 // Default never invokes the screenshot API, despite an explicit toolbar click.
 reset(false);await worker.evaluate(()=>chrome.storage.local.set({automaticRich:true}));await page.goto(origin+'/sample/article');await new Promise(r=>setTimeout(r,1100));await click();await poll(async()=>await badge()==='NO','Default denial');assert.equal(await calls(),before);
 await worker.evaluate(()=>chrome.storage.local.set({automaticRich:false}));
 // A baseline established after this delayed context ack would bind pixels B
 // to extracted text A. Exercise real Chrome, transport, and account readback.
 await worker.evaluate(()=>(globalThis as typeof globalThis & {testObservation:{stop:()=>void}}).testObservation.stop());
 reset();await page.goto(origin+'/sample/article');
 await poll(()=>worker.evaluate(()=>(globalThis as typeof globalThis & {testObservation:{idle:()=>boolean}}).testObservation.idle()),'manual fault phase idle');
 const beforeContextMessages=imageMessages;holdContext=true;releaseContext=null;
 await click();await poll(()=>releaseContext!==null,'context acknowledgement held');
 assert.ok(session.active?.text.includes('Real tab pixels'));
 await page.evaluate(()=>{document.querySelector('p')!.textContent='MUTATED DURING CONTEXT ACK';});
 assert.ok(releaseContext);(releaseContext as ()=>void)();
 await poll(async()=>await badge()==='NO','pre-extraction baseline fence');
 assert.equal(imageMessages,beforeContextMessages,'changed document cannot transport B as A');
 await history.settle();await accountClient.sync();
 assert.equal((await accountClient.inspect()).entries.find(e=>e.visitId===session.active!.id)?.record?.visit.image,'','actual HTTP/store has no cross-context image');
 // Optional unsupported pixel surfaces must not block baseline structured text.
 await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<iframe src="about:blank"></iframe>');});
 await click();await poll(async()=>await badge()==='NO','unsupported pixel surface');
 assert.ok(session.active?.text.includes('MUTATED DURING CONTEXT ACK'),'Basic text continues without optional pixels');
 // Hold the FINAL admission reply: navigation or DOM mutation during this await
 // must invalidate the already-acquired PNG before it is sent to Native Messaging.
 for(const change of ['navigate','form'] as const){
  reset();await vault.clear();await page.goto(origin+'/sample/article');await new Promise(r=>setTimeout(r,1100));
  const beforeMessages=imageMessages,beforeCapture=await calls();admissionCount=0;releaseAdmission=null;
  await click();await poll(()=>releaseAdmission!==null,'final admission held');
  assert.equal(await calls(),beforeCapture+1,'held reply must be AFTER real image acquisition');
  if(change==='navigate')await page.goto(origin+'/sample/other');
  else await page.evaluate(()=>{const input=document.createElement('input');input.value='LATE_FORM_SENTINEL';document.body.append(input);});
  assert.ok(releaseAdmission);(releaseAdmission as ()=>void)();admissionCount=null;
  await poll(async()=>await badge()==='NO','late '+change+' fence');
  assert.equal(imageMessages,beforeMessages,'no late '+change+' image transport');
  assert.equal(await vault.read(key),null);
 }
 // Pause during a delayed, real acquisition rejects before image transport/store.
 reset();await page.goto(origin+'/sample/article');await new Promise(r=>setTimeout(r,1100));const beforePauseCalls=await calls();
 await worker.evaluate(()=>{(globalThis as typeof globalThis & {testCapture:{delay:boolean}}).testCapture.delay=true;});
 await click();await poll(()=>calls().then(n=>n>beforePauseCalls),'delayed real capture');
 await poll(()=>worker.evaluate(()=>!!(globalThis as typeof globalThis & {testCapture:{release:unknown}}).testCapture.release),'capture callback held');
 const messagesBeforePause=imageMessages;session.pause(2);
 await worker.evaluate(()=>{(globalThis as typeof globalThis & {testCapture:{release:()=>void}}).testCapture.release();});
 await poll(async()=>await badge()==='NO','Pause fence');assert.equal(imageMessages,messagesBeforePause);assert.equal(session.active,undefined);
 await vault.clear();assert.equal(await vault.read(key),null);
 // Revoke while the actual screenshot callback is held; no late transport.
 reset();await history.settle();await page.goto(origin+'/sample/article');await page.bringToFront();
 await worker.evaluate(()=>(globalThis as typeof globalThis & {testObservation:{start:()=>void}}).testObservation.start());
 await worker.evaluate(()=>{const s=(globalThis as typeof globalThis & {testCapture:{release:unknown}}).testCapture;s.release=null;return chrome.storage.local.set({automaticRich:true});});
 await poll(()=>worker.evaluate(()=>!!(globalThis as typeof globalThis & {testCapture:{release:unknown}}).testCapture.release),'automatic capture held for revoke');
 const beforeRevoke=imageMessages;
 await automaticOptions.evaluate(()=>chrome.runtime.sendMessage({kind:'revoke'}));
 await worker.evaluate(()=>{(globalThis as typeof globalThis & {testCapture:{release:()=>void}}).testCapture.release();});
 await new Promise(r=>setTimeout(r,1200));assert.equal(imageMessages,beforeRevoke,'revoke fences delayed automatic image');
 assert.equal(await vault.read(key),null);
 console.log('PASS: real Chrome manual and automatic edited-page PNG, Native Messaging, encrypted readback, real account HTTP signin/device association, pending reopen/sync, image readback and automatic-image local correction; enrolled-origin/Default denial, delayed admission navigation/form, Pause and automatic revoke fences. Native OS foreground/key peer synthetic; Mac/Windows enrollment unrun.');
 await writeFile(join(directory,'receipt.json'),JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),scope:'real Chromium component, synthetic native foreground/key peer',platform:process.platform,browser:browser.version(),checks:['toolbar activeTab','actual PNG','Native Messaging','encrypted same-visit readback','automatic edited-page image with structured form sentinel excluded','unenrolled origin denial','Default pre-read denial','delayed final-admission navigation/form fences','delayed Pause pre-transport fence','delayed automatic revoke fence','actual HTTP account signin and device association','encrypted pending reopen and authenticated image readback','actual automatic-image local classification and correction'],nativeAcceptance:false},null,2));
}finally{
 await context?.close();classification.dispose();await history.dispose();await accountServer.close();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>ipc.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));
 await rm(profile,{recursive:true,force:true});await rm(home,{recursive:true,force:true});await rm(extension,{recursive:true,force:true});await rm(launcherPath(),{force:true});await rm(join(directory,'xdg'),{recursive:true,force:true});
}
function launcherPath(){return join(directory,'native-host');}
console.log('Reviewed invented artifacts/receipt directory:',directory);
