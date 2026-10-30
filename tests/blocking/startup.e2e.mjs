// Real unpacked Chromium with a test-only pre-start API wrapper, not disk/API outage proof.
import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const extension=resolve('build/browser-extension/preview');
const workerPath=resolve(extension,'blocking/worker.js');
const original=await readFile(workerPath,'utf8');
const injection=`// TEST ONLY: inject before production initialization in the actual worker.\nconst realEnumeration=chrome.declarativeNetRequest.getSessionRules.bind(chrome.declarativeNetRequest);\nglobalThis.startupProbe={token:crypto.randomUUID(),calls:0,failures:0};\nchrome.declarativeNetRequest.getSessionRules=async()=>{\n globalThis.startupProbe.calls++;\n const {blockingStartupFault}=await chrome.storage.session.get('blockingStartupFault');\n if(blockingStartupFault){\n  if(blockingStartupFault==='once')await chrome.storage.session.remove('blockingStartupFault');\n  globalThis.startupProbe.failures++;throw Error('INJECTED initial enumeration failure');\n }\n return realEnumeration();\n};\n`;
await writeFile(workerPath,injection+original);
console.log('BUILD production',createHash('sha256').update(original).digest('hex'),'instrumented',createHash('sha256').update(injection+original).digest('hex'));
const requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.end('<h1>Invented startup recovery lesson</h1><p>Local invented data only.</p>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port,resource=`http://example.test:${port}/education`;
const launch=()=>chromium.launchPersistentContext(resolve(process.env.SPINDLE_BLOCKING_PROFILE),{executablePath:process.env.SPINDLE_CHROMIUM_PATH,headless:false,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x900','-framerate','10','-i',process.env.DISPLAY,'-c:v','libvpx','-threads','1',process.env.SPINDLE_BLOCKING_MEDIA],{stdio:['pipe','ignore','inherit']});
const started=Date.now();const mark=s=>console.log(`${((Date.now()-started)/1000).toFixed(2)}s PASS ${s}`);
let c;
try{
 c=await launch();console.log('Chromium',c.browser().version());
 let w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');c.on('serviceworker',worker=>{w=worker;});
 const controls=await c.newPage();await controls.goto(w.url().replace('worker.js','blocking.html'));
 await controls.locator('#host').fill('example.test');await controls.locator('#purpose').fill('education');await controls.locator('form button').click();
 await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active:'),null,{timeout:120000});
 const opened=c.waitForEvent('page');
 const tabId=await controls.evaluate(async url=>(await chrome.tabs.create({url})).id,`http://unrelated.test:${port}/unrelated`);
 let page=await opened;await page.waitForSelector('h1');
 const rules=()=>controls.evaluate(()=>chrome.declarativeNetRequest.getSessionRules());
 const grant=async()=>{await controls.waitForTimeout(300);const result=await controls.evaluate(async({resource,tabId})=>{const {sitePolicy}=await chrome.storage.local.get('sitePolicy');return chrome.runtime.sendMessage({type:'resource-review',resource,tabId,version:sitePolicy.version,override:true,seconds:5});},{resource,tabId});console.log('GRANT',result);return result;};
 const session=await c.newCDPSession(controls);let stopped=false;session.on('ServiceWorker.workerVersionUpdated',e=>{if(e.versions.some(v=>v.runningStatus==='stopped'))stopped=true;});await session.send('ServiceWorker.enable');
 async function stop(fault){await controls.evaluate(fault=>chrome.storage.session.set({blockingStartupFault:fault}),fault);stopped=false;await session.send('ServiceWorker.stopAllWorkers');for(let i=0;i<100&&!stopped;i++)await new Promise(r=>setTimeout(r,50));assert.ok(stopped);}
 async function blocked(){const before=requests.length;await assert.rejects(page.goto(resource),/ERR_BLOCKED_BY_CLIENT/);assert.equal(requests.slice(before).includes('/education'),false);}
 await blocked();mark('whole-site blocked, unrelated local navigation works');
 assert.equal((await grant()).ok,true);await page.waitForURL(resource);await page.waitForSelector('h1');assert.equal((await rules()).length,1);
 const fault=process.env.SPINDLE_STARTUP_FAULT==='always'?'always':'once';
 await stop(fault);mark('actual worker stopped with existing ALLOW and persisted grant');
 // The grant alarm starts a new worker; the wrapper rejects its first enumeration only.
 await controls.waitForTimeout(6200);
 if(fault==='always') {
  assert.ok(page.isClosed(),'unknown rule enumeration must bound known tab authority by closing its target');
  page=await c.newPage();await blocked();
 } else {assert.equal((await rules()).length,0);await blocked();}
 const probe=await w.evaluate(()=>globalThis.startupProbe);assert.ok(probe.failures>=1);if(fault==='once')assert.equal(probe.failures,1);mark('initial enumeration rejected; recovery removes allowance or closes known target without deleting uninspected rules');
 if(fault==='always') {
  const response=await controls.evaluate(()=>chrome.runtime.sendMessage({type:'site-remove'}));assert.equal(response.ok,false);
  const before=await w.evaluate(()=>globalThis.startupProbe);await controls.waitForTimeout(2200);const after=await w.evaluate(()=>globalThis.startupProbe);assert.equal(after.token,before.token);console.log('PACED ENUMERATIONS',after.calls-before.calls);assert.ok(after.calls-before.calls<=8,'paced recovery plus one in-flight boundary attempt; each attempt includes ownership-safe revoke inspection');mark(`repeated enumeration failures fail closed, paced retries (${after.calls-before.calls} calls/2.2s)`);
  await controls.evaluate(()=>chrome.storage.session.remove('blockingStartupFault'));
 }
 await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');assert.equal(await w.evaluate(()=>globalThis.startupProbe.token),probe.token);await page.goto(resource);mark('explicit controls recover in the same worker after initial rejection');
 await page.bringToFront();await page.waitForTimeout(1000);await c.close();c=await launch();w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');const restart=await c.newPage();await restart.goto(w.url().replace('worker.js','blocking.html'));assert.equal(await restart.evaluate(async()=>(await chrome.declarativeNetRequest.getSessionRules()).length),0);mark('browser restart retains no permissive session authority');
}finally{await c?.close();server.closeAllConnections();await new Promise(r=>server.close(r));recording.stdin.write('q\n');const [code]=await once(recording,'exit');await writeFile(workerPath,original);assert.equal(code,0);}
