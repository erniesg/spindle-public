import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
await mkdir('.local/issue78/media',{recursive:true});
// External synthetic-screen recording avoids Chromium/Playwright video pipe teardown hangs.
const mediaPath=process.env.SPINDLE_BLOCKING_MEDIA ?? `.local/issue78/media/blocking-${Date.now()}.webm`;
console.log('MEDIA',mediaPath);
const recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x900','-framerate','10','-i',process.env.DISPLAY,'-c:v','libvpx','-threads','1',mediaPath],{stdio:['pipe','ignore','inherit']});
const requests=[];
const server=createServer((req,res)=>{requests.push({host:req.headers.host,url:req.url}); console.log('SERVER',req.headers.host,req.url); if(req.url==='/redirect'){res.writeHead(302,{location:`http://example.test:${server.address().port}/lesson`});res.end();}else res.end('<h1>Invented lesson fixture</h1><p>No personal data. Local site.</p>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const extension=resolve('build/browser-extension/preview');
const launch=()=>chromium.launchPersistentContext(resolve(process.env.SPINDLE_BLOCKING_PROFILE ?? '.local/issue78/profile'),{executablePath:process.env.SPINDLE_CHROMIUM_PATH,headless:false,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1, MAP *.test. 127.0.0.1, MAP invented.youtube.com 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
let c;
try {
c=await launch(); console.log('Chromium',c.browser().version());
const browserErrors=[];
c.on('weberror',error=>browserErrors.push(error.error().message));
let w=c.serviceWorkers()[0]||await c.waitForEvent('serviceworker'); const controls=await c.newPage(); await controls.goto(w.url().replace('worker.js','blocking.html'));
await controls.locator('#remove').click(); await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
const p=await c.newPage(); await p.goto(`http://example.test:${port}/lesson`); assert.match(await p.textContent('h1'),/Invented/);
await controls.bringToFront(); await controls.locator('#purpose').fill('education'); await controls.locator('#host').fill('example.test'); await controls.locator('button').first().click();
await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:120000});
await p.waitForTimeout(1000); assert.ok(!await p.locator('h1').filter({hasText:'Invented'}).count()); console.log('PASS existing tab re-gated');
async function blocked(url){const b=await c.newPage();try{await b.goto(url);throw Error('NOT BLOCKED '+url);}catch(e){assert.match(String(e),/ERR_BLOCKED_BY_CLIENT/);}finally{await b.close();}}
await blocked(`http://example.test:${port}/direct`); console.log('PASS direct block');
await blocked(`http://example.test.:${port}/dotted`); console.log('PASS trailing-dot host block');
await p.goto(`http://unrelated.test:${port}/`); assert.match(await p.textContent('h1'),/Invented/); console.log('PASS unrelated');
await p.goto(`http://sub.example.test:${port}/`); assert.match(await p.textContent('h1'),/Invented/); console.log('PASS exact host excludes subdomain');
await blocked(`http://unrelated.test:${port}/redirect`); console.log('PASS redirect');
await assert.rejects(p.goto(`http://example.test:${port}/review`),/ERR_BLOCKED_BY_CLIENT/);
await controls.reload();
// A rejected navigation can resolve before Chromium exposes its final tab URL.
await controls.waitForFunction(async()=>Boolean((await chrome.tabs.query({})).find(t=>(t.pendingUrl??t.url)?.includes('/review'))));
const target=await controls.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>(t.pendingUrl??t.url)?.includes('/review')).id;});
const resource=`http://example.test:${port}/education`;
await controls.locator('#tab').selectOption(String(target)); await controls.locator('#resource').fill(resource);
await controls.locator('#review').click(); await controls.waitForFunction(()=>document.querySelector('output').textContent.includes('explicit user override required')); console.log('PASS uncertain baseline does not unlock');
await controls.locator('#override').check();
await controls.locator('#resource').fill(resource+'?private=fixture'); await controls.locator('#review').click();
await controls.waitForFunction(()=>document.querySelector('output').textContent==='Gated: invalid'); console.log('PASS ambiguous query identity stays gated');
await controls.locator('#resource').fill(resource); await controls.locator('#seconds').fill('2'); await controls.locator('#review').click();
await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Last action: explicit override applied'));
await p.waitForURL(resource); await p.waitForFunction(()=>document.querySelector('h1')?.textContent.includes('Invented'));
console.log('PASS resource override opens exact target tab'); await blocked(resource); await blocked(resource+'-other'); console.log('PASS multitab and exact-path isolation');
await p.waitForTimeout(2500); assert.ok(!await p.locator('h1').filter({hasText:'Invented'}).count()); console.log('PASS expiry re-gates');
await controls.locator('#seconds').fill('30'); await controls.locator('#review').click(); await p.waitForURL(resource); await p.waitForSelector('h1');
// The server, not the post-navigation guard/DOM, is the leakage oracle.
for(const variant of ['/Education','/EDUCATION','/education?V=Invented','/education?v=invented']){
 const before=requests.length;
 await p.goto(`http://example.test:${port}${variant}`).catch(()=>{});
 await p.waitForTimeout(150);
 assert.equal(requests.slice(before).filter(r=>r.url===variant).length,0,`network leaked ${variant}`);
 console.log('PASS server observed no variant request',variant);
 await controls.locator('#review').click(); await p.waitForURL(resource); await p.waitForSelector('h1');
 assert.ok(requests.slice(before).some(r=>r.url==='/education'),'exact approved resource reaches server');
}
const session=await c.newCDPSession(controls);
const workerStates=[];
session.on('ServiceWorker.workerVersionUpdated',event=>workerStates.push(...event.versions.map(v=>v.runningStatus)));
await session.send('ServiceWorker.enable');
// Schedule an actual stale alarm to wake the worker while its grant is valid.
await controls.evaluate(async target=>{await chrome.alarms.create(`blocking-${target}`,{when:Date.now()+2500});},target);
await session.send('ServiceWorker.stopAllWorkers');
for(let i=0;i<100 && !workerStates.includes('stopped');i++) await new Promise(resolve=>setTimeout(resolve,50));
assert.ok(workerStates.includes('stopped'),`No actual stopped worker observed: ${workerStates}`);
console.log('WORKER lifecycle',JSON.stringify(workerStates));
await p.waitForTimeout(3200);
assert.ok(workerStates.slice(workerStates.indexOf('stopped')+1).includes('running'),'alarm must actually cold-wake the worker');
assert.match(await p.textContent('h1'),/Invented/);
assert.equal(await controls.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),1);
console.log('PASS actual cold-start stale alarm preserves unexpired resource exception without capture wake');
await p.evaluate(()=>history.pushState({},'', '/other')); await p.waitForTimeout(700); assert.ok(!await p.locator('h1').filter({hasText:'Invented'}).count()); console.log('PASS SPA navigation re-gates');
await controls.locator('#review').click(); await p.waitForURL(resource); await p.waitForSelector('h1');
const oldVersion=await controls.evaluate(async()=>(await chrome.storage.local.get('sitePolicy')).sitePolicy.version);
await controls.locator('#host').fill('example.test'); await controls.locator('#purpose').fill('research'); await controls.locator('form button').click();
await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:')); await p.waitForTimeout(500);
assert.ok(!await p.locator('h1').filter({hasText:'Invented'}).count()); console.log('PASS policy revision re-gates');
const stale=await controls.evaluate(async({resource,target,oldVersion})=>chrome.runtime.sendMessage({type:'resource-review',resource,tabId:target,version:oldVersion,override:true}),{resource,target,oldVersion});
assert.equal(stale.ok,false); console.log('PASS stale review rejected');
await controls.screenshot({path:'.local/issue78/integrated-controls.png'}); await controls.waitForTimeout(1500);
assert.deepEqual(browserErrors,[]); console.log('PASS content guard loads without script errors');
console.log('rules',JSON.stringify(await w.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())));
await c.close(); c=await launch(); w=c.serviceWorkers()[0]||await c.waitForEvent('serviceworker');
const restart=await c.newPage(); await assert.rejects(restart.goto(`http://example.test:${port}/restart`),/ERR_BLOCKED_BY_CLIENT/); console.log('PASS restart persists block');
const recovery=await c.newPage(); await recovery.goto(w.url().replace('worker.js','blocking.html')); await recovery.locator('#remove').click(); await recovery.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
await restart.goto(`http://example.test:${port}/recovered`); assert.match(await restart.textContent('h1'),/Invented/); await restart.screenshot({path:'.local/issue78/recovered.png'}); console.log('PASS explicit recovery');
await recovery.locator('#host').fill('example.test'); await recovery.locator('#purpose').fill('education'); await recovery.locator('#subdomains').check();
console.log('GRANT subdomain permission now'); await recovery.locator('form button').click();
await recovery.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:120000});
await blocked(`http://sub.example.test:${port}/nested`);
await blocked(`http://sub.example.test.:${port}/nested-dot`);
await restart.goto(`http://notexample.test:${port}/boundary`); assert.match(await restart.textContent('h1'),/Invented/); console.log('PASS subdomain inclusion and suffix boundary');
const loadedResource=`http://example.test:${port}/loaded-guard`;
const loadedPage=c.waitForEvent('page');
const loadedGrant=await recovery.evaluate(async resource=>{const tab=await chrome.tabs.create({url:'about:blank'});const p=(await chrome.storage.local.get('sitePolicy')).sitePolicy;return chrome.runtime.sendMessage({type:'resource-review',resource,tabId:tab.id,version:p.version,override:true,seconds:60});},loadedResource);
assert.equal(loadedGrant.ok,true);
const loaded=await loadedPage;
await loaded.waitForURL(loadedResource); await loaded.waitForSelector('h1');
await recovery.locator('#remove').click(); await recovery.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
if(loaded){await loaded.waitForTimeout(500);await loaded.waitForSelector('h1');await loaded.evaluate(()=>history.pushState({},'', '/guard-stopped'));await loaded.waitForTimeout(600);assert.match(await loaded.textContent('h1'),/Invented/);}
console.log('PASS existing document recovers after guard shutdown');
assert.equal(await recovery.evaluate(async()=>(await chrome.scripting.getRegisteredContentScripts()).filter(s=>s.id==='blocking-guard').length),0);
console.log('PASS removal unregisters guard');
await recovery.locator('#host').fill('example.test'); await recovery.locator('form button').click();
await recovery.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'));
// Real production clear and re-enable calls race; no production API monkeypatch.
for(let i=0;i<3;i++) {
 const result=await recovery.evaluate(async()=>{
  await chrome.storage.local.clear();
  return chrome.runtime.sendMessage({type:'site-block',host:'example.test',subdomains:true,purpose:'education'});
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 await blocked(`http://example.test:${port}/rapid-${i}`);
 assert.equal(await recovery.evaluate(async()=>(await chrome.declarativeNetRequest.getDynamicRules()).filter(r=>r.id===78001).length),1);
}
console.log('PASS rapid production storage revoke/re-enable preserves new site rule (3 cycles)');
const captureOptions=await c.newPage();
await captureOptions.goto(recovery.url().replace('blocking.html','options.html'));
await captureOptions.locator('#revoke').click();
await captureOptions.waitForFunction(()=>document.querySelector('#status').textContent.includes('UNCONFIRMED'));
console.log('PASS actual capture revoke control; absent native acknowledgement disclosed');
await recovery.waitForFunction(async()=>(await chrome.declarativeNetRequest.getDynamicRules()).length===0);
await recovery.reload(); await recovery.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
await restart.goto(`http://example.test:${port}/capture-revoke`); assert.match(await restart.textContent('h1'),/Invented/);
assert.equal(await recovery.evaluate(async()=>(await chrome.scripting.getRegisteredContentScripts()).length),0);
console.log('PASS capture storage clear reconciles DNR, guard and inactive UI');
console.log('NATIVE HOST PROBE',await recovery.evaluate(()=>new Promise(resolve=>{const port=chrome.runtime.connectNative('ai.berlayar.spindle.preview');port.onDisconnect.addListener(()=>resolve(chrome.runtime.lastError?.message ?? 'disconnected'));setTimeout(()=>{port.disconnect();resolve('connected; enrollment not attempted without supported native host');},2000);})));
// Invented YouTube-shaped identity, DNS mapped only to this loopback server.
// No real YouTube request or classifier is involved.
await recovery.bringToFront(); await recovery.locator('#purpose').fill('education'); await recovery.locator('#host').fill('invented.youtube.com');
await recovery.locator('#subdomains').uncheck(); await recovery.locator('form button').click();
console.log('GRANT invented.youtube.com loopback permission now');
await recovery.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:120000});
const videoResource=`http://invented.youtube.com:${port}/watch?v=InventedID`;
const priorTabs=await recovery.evaluate(async()=> (await chrome.tabs.query({})).map(t=>t.id));
const videoPage=await c.newPage();
const videoTab=await recovery.evaluate(async prior=> (await chrome.tabs.query({})).find(t=>!prior.includes(t.id)).id,priorTabs);
async function grantVideo(){
 const result=await recovery.evaluate(async({videoResource,videoTab})=>{
  const p=(await chrome.storage.local.get('sitePolicy')).sitePolicy;
  return chrome.runtime.sendMessage({type:'resource-review',resource:videoResource,tabId:videoTab,version:p.version,override:true,seconds:30});
 },{videoResource,videoTab}); assert.equal(result.ok,true);
}
await grantVideo();
await videoPage.waitForURL(videoResource); await videoPage.waitForSelector('h1');
for(const variant of ['/watch?v=inventedID','/watch?v=INVENTEDID','/watch?V=InventedID']){
 const before=requests.length;
 await videoPage.goto(`http://invented.youtube.com:${port}${variant}`).catch(()=>{});
 await videoPage.waitForTimeout(150);
 assert.equal(requests.slice(before).filter(r=>r.host===`invented.youtube.com:${port}`&&r.url===variant).length,0,`query network leaked ${variant}`);
 console.log('PASS server observed no query-case variant',variant);
 await grantVideo(); await videoPage.waitForURL(videoResource); await videoPage.waitForSelector('h1');
 assert.ok(requests.slice(before).some(r=>r.url==='/watch?v=InventedID'),'exact query identity reaches server');
}
await recovery.waitForTimeout(1500);
}finally{console.log('closing browser'); await c?.close(); console.log('closing fixture'); server.closeAllConnections(); await new Promise(r=>server.close(r)); console.log('closed'); recording.stdin.write('q\n'); const [code]=await once(recording,'exit'); assert.equal(code,0); console.log('recording closed');}
