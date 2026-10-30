// Invented loopback activity. API failures below are runtime injection, not real quota failures.
import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.end('<h1>Invented persistence lesson</h1><p>Local invented data only.</p>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const resource=`http://example.test:${port}/education`;
const extension=resolve('build/browser-extension/preview');
const launch=()=>chromium.launchPersistentContext(resolve(process.env.SPINDLE_BLOCKING_PROFILE),{executablePath:process.env.SPINDLE_CHROMIUM_PATH,headless:false,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x900','-framerate','10','-i',process.env.DISPLAY,'-c:v','libvpx','-threads','1',process.env.SPINDLE_BLOCKING_MEDIA],{stdio:['pipe','ignore','inherit']});
const started=Date.now();
const mark=s=>console.log(`${((Date.now()-started)/1000).toFixed(2)}s PASS ${s}`);
let c;
try {
 c=await launch();console.log('Chromium',c.browser().version());
 let w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');
 c.on('serviceworker',worker=>{w=worker;});
 const controls=await c.newPage();await controls.goto(w.url().replace('worker.js','blocking.html'));
 await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
 await controls.locator('#host').fill('example.test');await controls.locator('#purpose').fill('education');await controls.locator('form button').click();
 await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:120000});
 const opened=c.waitForEvent('page');
 const tabId=await controls.evaluate(async url=>(await chrome.tabs.create({url})).id,`http://unrelated.test:${port}/unrelated`);
 const page=await opened;await page.waitForSelector('h1');assert.match(await page.textContent('h1'),/Invented/);
 const rules=()=>controls.evaluate(()=>chrome.declarativeNetRequest.getSessionRules());
 const grant=(seconds=2)=>controls.evaluate(async({resource,tabId,seconds})=>{const {sitePolicy}=await chrome.storage.local.get('sitePolicy');return chrome.runtime.sendMessage({type:'resource-review',resource,tabId,version:sitePolicy.version,override:true,seconds});},{resource,tabId,seconds});
 const fault=async method=>{await w.evaluate(method=>{globalThis.originalSessionMethods??={};globalThis.originalSessionMethods[method]??=chrome.storage.session[method];chrome.storage.session[method]=async()=>{throw Error('INJECTED session '+method+' failure');};},method);};
 const restore=async()=>{await w.evaluate(()=>{for(const [method,fn] of Object.entries(globalThis.originalSessionMethods??{}))chrome.storage.session[method]=fn;});};
 async function blocked(){const before=requests.length;await assert.rejects(page.goto(resource),/ERR_BLOCKED_BY_CLIENT/);assert.equal(requests.slice(before).includes('/education'),false);await controls.waitForTimeout(300);}
 await blocked();mark('whole-site blocked; unrelated navigation works');
 await fault('set');assert.equal((await grant()).ok,false);assert.equal((await rules()).length,0);await blocked();mark('injected session.set grant failure leaves no allowance');await restore();
 assert.equal((await grant()).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 await fault('remove');await controls.bringToFront();await controls.waitForTimeout(2600);assert.equal((await rules()).length,0);await blocked();mark('expiry removes real DNR allowance despite injected session.remove failure');await restore();
 // Stale persistence after failed cleanup must not recreate an ALLOW across worker restart.
 assert.equal((await grant(30)).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 await fault('remove');await controls.evaluate(async()=>{const {sitePolicy}=await chrome.storage.local.get('sitePolicy');await chrome.storage.local.set({sitePolicy:{...sitePolicy,version:sitePolicy.version+1}});});await controls.waitForTimeout(500);assert.equal((await rules()).length,0);
 const session=await c.newCDPSession(controls);const states=[];
 session.on('ServiceWorker.workerVersionUpdated',e=>states.push(...e.versions.map(v=>v.runningStatus)));
 await session.send('ServiceWorker.enable');
 await restore();
 assert.equal((await grant(30)).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 await page.bringToFront();await page.waitForTimeout(500);
 await page.goto(`http://unrelated.test:${port}/away`);await page.waitForTimeout(500);assert.equal((await rules()).length,0);await blocked();mark('ungranted origin status-only navigation revokes; server sees no return request');
 assert.equal((await grant(30)).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 await page.bringToFront();await page.waitForTimeout(500);
 await page.evaluate(()=>history.pushState({},'', '/spa-away'));await page.waitForTimeout(600);assert.equal((await rules()).length,0);await blocked();mark('SPA navigation revokes exact resource authority');
 assert.equal((await grant(30)).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 w=c.serviceWorkers().find(worker=>worker.url().endsWith('/worker.js'));
 await w.evaluate(()=>{chrome.declarativeNetRequest.updateSessionRules=async()=>{throw Error('INJECTED network removal failure');};});
 await page.goto(`http://unrelated.test:${port}/failed-revoke`);await page.waitForTimeout(500);assert.equal((await rules()).length,1);
 const persisted=await controls.evaluate(()=>chrome.storage.session.get('blockingGrants'));assert.equal(persisted.blockingGrants[tabId].expires,0);
 states.length=0;await session.send('ServiceWorker.stopAllWorkers');
 for(let i=0;i<100&&!states.includes('stopped');i++)await new Promise(r=>setTimeout(r,50));assert.ok(states.includes('stopped'));
 await controls.reload();await controls.waitForTimeout(500);assert.equal((await rules()).length,0);await blocked();mark('failed early network revoke persists cancellation across actual stopped worker and recovered API');
 assert.equal((await grant(2)).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');
 // Stop the real worker; runtime method injection vanishes on actual restart.
 assert.ok(states.includes('stopped'));states.length=0;
 await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
 for(let i=0;i<100&&!states.includes('stopped');i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(states.includes('stopped'));await controls.waitForTimeout(3000);
 assert.equal((await rules()).length,0);await blocked();mark('real stopped worker cold-wakes and expires persisted allowance');console.log('WORKER',states);
 await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');await page.goto(resource);await page.waitForSelector('h1');mark('explicit recovery restores access');
 await page.bringToFront();await page.waitForTimeout(1000);
 await c.close();c=await launch();w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');
 const restart=await c.newPage();await restart.goto(w.url().replace('worker.js','blocking.html'));assert.equal(await restart.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),0);mark('browser restart has no session allowance');
}finally{
 await c?.close();server.closeAllConnections();await new Promise(r=>server.close(r));recording.stdin.write('q\n');const [code]=await once(recording,'exit');assert.equal(code,0);
}
