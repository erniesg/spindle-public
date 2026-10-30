// Real Chromium/production extension, invented loopback sites, capture OFF.
// The queue delay is runtime latency injection, not a physical storage failure.
import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const extension=resolve('build/browser-extension/preview');
for(const file of ['blocking/worker.js','blocking/guard.js']) console.log('INSTALLED',file,createHash('sha256').update(await readFile(resolve(extension,file))).digest('hex'));
const cold=process.env.SPINDLE_COLD_RESTORE==='1',workerPath=resolve(extension,'blocking/worker.js');
const production=await readFile(workerPath,'utf8');
if(cold) {
 const injection=`// TEST ONLY: delay actual cold session restoration, not event delivery.\nconst realSessionGet=chrome.storage.session.get.bind(chrome.storage.session);\nchrome.storage.session.get=async keys=>{const value=await realSessionGet(keys);if(keys==='blockingGrants'&&Object.keys(value.blockingGrants??{}).length)await new Promise(resolve=>{globalThis.releaseNavigationQueue=resolve;});return value;};\n`;
 await writeFile(workerPath,injection+production);
 console.log('INSTRUMENTED cold worker',createHash('sha256').update(injection+production).digest('hex'));
}
const requests=[];
const server=createServer((req,res)=>{requests.push({host:req.headers.host,path:req.url});res.end('<h1>Invented navigation lesson</h1><p>Local test only. No tracking or model.</p>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const resource=`http://example.test:${port}/education`;
const started=Date.now(),mark=s=>console.log(`${((Date.now()-started)/1000).toFixed(2)}s PASS ${s}`);
let recording,c,pending;
function startRecording(){
 // Never retain permission/consent entry in publication candidates.
 console.log('RECORDING_OFFSET_SECONDS',((Date.now()-started)/1000).toFixed(3));
 recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x900','-framerate','10','-i',process.env.DISPLAY,'-c:v','libvpx','-b:v','1M','-threads','1',process.env.SPINDLE_BLOCKING_MEDIA],{stdio:['pipe','ignore','inherit']});
}
try {
 c=await chromium.launchPersistentContext(resolve(process.env.SPINDLE_BLOCKING_PROFILE),{executablePath:process.env.SPINDLE_CHROMIUM_PATH,headless:false,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 console.log('Chromium',c.browser().version());let w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');
 c.on('serviceworker',worker=>{w=worker;});
 const controls=await c.newPage();await controls.goto(w.url().replace('worker.js','blocking.html'));
 const opened=c.waitForEvent('page');
 const tabId=await controls.evaluate(async url=>(await chrome.tabs.create({url})).id,`http://unrelated.test:${port}/unrelated`);
 const page=await opened;await page.waitForSelector('h1');await controls.bringToFront();
 await controls.reload(); // Refresh the real target-tab selector after creating the test tab.
 assert.equal(await controls.evaluate(async()=>Boolean((await chrome.storage.local.get('profileToken')).profileToken)),false);
 await controls.locator('#host').fill('example.test');await controls.locator('form button').click();
 if(process.env.SPINDLE_ALLOW_PROMPT==='1') {
  await controls.waitForTimeout(1000);
  execFileSync('python3',['-c',`import ctypes
x=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong];t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong];x.XFlush.argtypes=[ctypes.c_void_p];t.XTestFakeMotionEvent(d,-1,823,286,0);t.XTestFakeButtonEvent(d,1,1,0);t.XTestFakeButtonEvent(d,1,0,0);x.XFlush(d)`]);
 }
 await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:30000});
 startRecording();
 await controls.waitForTimeout(1000);
 assert.equal(await controls.evaluate(async()=>(await chrome.storage.local.get('sitePolicy')).sitePolicy.purpose),'');
 mark('whole-site policy enabled with no purpose, capture enrollment or model');
 async function grant(){
  await controls.bringToFront();await controls.locator('#tab').selectOption(String(tabId));
  await controls.locator('#resource').fill(resource);await controls.locator('#seconds').fill('60');await controls.locator('#override').check();
  await controls.locator('#review').click();await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Last action: explicit override applied'));
 }
 async function blocked(url){
  const before=requests.length;let failure;
  try {await page.goto(url);} catch(error) {failure=error;}
  await controls.waitForTimeout(300);
  assert.equal(requests.slice(before).some(r=>r.host===new URL(url).host&&r.path===new URL(url).pathname),false,'blocked main frame must not reach server');
  if(failure)assert.match(String(failure),/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/);
  assert.equal(await page.locator('h1').filter({hasText:'Invented'}).count(),0);
 }
 await blocked(resource);await page.bringToFront();await page.waitForTimeout(1000);
 mark('blocked resource reaches no server; unrelated navigation remains available');
 await controls.bringToFront();await controls.locator('#tab').selectOption(String(tabId));await controls.locator('#resource').fill(resource);await controls.locator('#override').check();await controls.locator('#review').click();
 await controls.waitForFunction(()=>document.querySelector('output').textContent==='Choose an allowed purpose before reviewing a resource.');
 assert.equal(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),0);
 await controls.waitForTimeout(1000);mark('purpose-less resource review remains gated with recovery reason');
 await controls.locator('#purpose').fill('education');await controls.locator('form button').click();
 await controls.waitForFunction(()=>document.querySelector('output').textContent.includes('purpose: education'));
 await grant();await page.waitForURL(resource);await page.waitForSelector('h1');await page.bringToFront();await page.waitForTimeout(600);
 assert.equal(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),1);
 mark('deliberate exact-resource override opens only selected resource');
 // Either hold an existing production control, or stop the real worker and
 // delay its next restoration. Tab event delivery stays real in both modes.
 if(cold) {
  const session=await c.newCDPSession(controls);let stopped=false;
  session.on('ServiceWorker.workerVersionUpdated',event=>{if(event.versions.some(v=>v.runningStatus==='stopped'))stopped=true;});
  await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
  for(let i=0;i<100&&!stopped;i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(stopped,'must observe actual stopped worker, not simulated restoration');
  pending=controls.evaluate(()=>chrome.runtime.sendMessage({type:'blocking-status'}));
  void pending.catch(()=>{}); // Observe immediately; teardown must not orphan the recorder.
  // Chromium can reuse its ServiceWorker target, without a new Playwright event.
  for(let i=0;i<100;i++) {
   w=c.serviceWorkers().find(worker=>worker.url().endsWith('/worker.js'))??w;
   if(await w.evaluate(()=>typeof globalThis.releaseNavigationQueue==='function').catch(()=>false))break;
   await new Promise(r=>setTimeout(r,20));
  }
  mark('actual worker stopped and restarted with existing bounded exception');
 } else {
  await w.evaluate(()=>{
   const get=chrome.storage.local.get.bind(chrome.storage.local);let first=true;
   chrome.storage.local.get=async keys=>{if(first&&keys==='sitePolicy'){first=false;await new Promise(resolve=>{globalThis.releaseNavigationQueue=resolve;});}return get(keys);};
  });
  pending=controls.evaluate(()=>chrome.runtime.sendMessage({type:'blocking-status'}));
  void pending.catch(()=>{});
 }
 await w.evaluate(tabId=>{
  globalThis.navigationEvents=[];
  chrome.tabs.onUpdated.addListener((id,change)=>{if(id===tabId&&change.url)globalThis.navigationEvents.push(change.url);});
 },tabId);
 for(let i=0;i<100&&!await w.evaluate(()=>typeof globalThis.releaseNavigationQueue==='function');i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(await w.evaluate(()=>typeof globalThis.releaseNavigationQueue),'function');
 await page.evaluate(()=>{history.pushState({},'', '/departed');history.pushState({},'', '/education');});
 for(let i=0;i<100&&!await w.evaluate(()=>globalThis.navigationEvents.some(url=>url.endsWith('/departed')));i++)await new Promise(r=>setTimeout(r,20));
 const events=await w.evaluate(()=>globalThis.navigationEvents);console.log('OBSERVED tab URL events',events);
 assert.ok(events.includes(`http://example.test:${port}/departed`));assert.equal(page.url(),resource);
 await controls.waitForTimeout(100);
 const current=await controls.evaluate(async tabId=>{const tab=await chrome.tabs.get(tabId);return tab.pendingUrl??tab.url;},tabId);
 assert.equal(current,resource,'queued revalidation must see the returned resource');
 console.log('RULES before queue release',await controls.evaluate(()=>chrome.declarativeNetRequest.getSessionRules()));
 await w.evaluate(()=>globalThis.releaseNavigationQueue());await pending;pending=undefined;
 // Poll resolved API data; a Promise-returning page predicate is not a rule oracle.
 for(let i=0;i<100;i++) {
  if(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length)===0)break;
  await new Promise(r=>setTimeout(r,20));
 }
 assert.equal(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),0);
 mark(`${cold?'cold-restored':'warm'} observed SPA away/return revokes although current-tab read sees original resource`);
 await blocked(resource);await page.waitForTimeout(1000);mark('same-resource request after cancellation never reaches server');
 await grant();await page.waitForURL(resource);await page.waitForSelector('h1');
 await page.evaluate(()=>history.pushState({},'', '/next'));await page.waitForTimeout(800);
 assert.equal(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),0);
 await blocked(resource);mark('ordinary SPA next re-gates and needs a new deliberate review');
 await controls.bringToFront();await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');await controls.waitForTimeout(1000);
 await page.goto(resource);await page.waitForSelector('h1');await page.bringToFront();await page.waitForTimeout(1500);
 mark('explicit recovery restores access; capture remains unenrolled');
 console.log('LIMIT: injected queue latency proves observed-event retention, not atomic departure or zero pre-playback.');
} finally {
 await c?.close();if(pending)await pending.catch(()=>{});
 server.closeAllConnections();await new Promise(r=>server.close(r));
 let recorderCode=0;
 if(recording){recording.stdin.write('q\n');const [code]=await once(recording,'exit');recorderCode=code;}
 if(cold)await writeFile(workerPath,production);
 assert.equal(recorderCode,0);
}
