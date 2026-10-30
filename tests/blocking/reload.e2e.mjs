// Invented local sites, real unpacked Chromium. Runtime rejection injection, not OS failure.
import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const extension=resolve('build/browser-extension/preview'),requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.end('<h1>Invented existing-tab lesson</h1>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x900','-framerate','10','-i',process.env.DISPLAY,'-c:v','libvpx','-threads','1',process.env.SPINDLE_BLOCKING_MEDIA],{stdio:['pipe','ignore','inherit']});
let c;const start=Date.now(),mark=s=>console.log(`${((Date.now()-start)/1000).toFixed(2)}s PASS ${s}`);
try {
 c=await chromium.launchPersistentContext(resolve(process.env.SPINDLE_BLOCKING_PROFILE),{executablePath:process.env.SPINDLE_CHROMIUM_PATH,headless:false,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.test 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 console.log('Chromium',c.browser().version());const w=c.serviceWorkers()[0]??await c.waitForEvent('serviceworker');
 const page=await c.newPage();await page.goto(`http://reload.test:${port}/existing`);
 const controls=await c.newPage();await controls.goto(w.url().replace('worker.js','blocking.html'));
 await w.evaluate(()=>{globalThis.realReload=chrome.tabs.reload.bind(chrome.tabs);chrome.tabs.reload=async()=>{throw Error('INJECTED reload rejection');};});
 await controls.locator('#host').fill('reload.test');await controls.locator('#purpose').fill('education');await controls.locator('form button').click();await controls.waitForTimeout(1000);
 execFileSync('python3',['-c',`import ctypes
x=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong];t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong];x.XFlush.argtypes=[ctypes.c_void_p];t.XTestFakeMotionEvent(d,-1,823,286,0);t.XTestFakeButtonEvent(d,1,1,0);t.XTestFakeButtonEvent(d,1,0,0);x.XFlush(d)`]);
 await controls.screenshot({path:'.local/issue78/reload9-debug.png'});console.log('OUTPUT',await controls.locator('output').textContent());
 await controls.waitForFunction(()=>document.querySelector('output').textContent.includes('Existing tab protection incomplete'));
 assert.match(await page.locator('h1').textContent(),/Invented/);assert.ok(await controls.evaluate(async()=>(await chrome.storage.local.get('sitePolicy')).sitePolicy.pending));
 mark('surviving matching loaded tab: reload rejected, controls incomplete not Active');await controls.waitForTimeout(1500);
 await controls.reload();assert.match(await controls.locator('output').textContent(),/incomplete/);
 await controls.locator('#host').fill('reload.test');await controls.locator('#purpose').fill('education');await controls.locator('form button').click();await controls.waitForFunction(()=>document.querySelector('output').textContent.includes('Existing tab protection incomplete'));mark('repeated rejection remains pending');
 await w.evaluate(()=>{chrome.tabs.reload=globalThis.realReload;});await controls.locator('form button').click();await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active: reload.test'));
 await page.waitForTimeout(500);assert.notEqual(page.url(),`http://reload.test:${port}/existing`);mark('explicit retry really re-gates existing document before Active');
 await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
 const closed=await c.newPage();await closed.goto(`http://reload.test:${port}/closing`);
 await w.evaluate(()=>{chrome.tabs.reload=async id=>{await chrome.tabs.remove(id);throw Error('INJECTED actual close race');};});
 await controls.bringToFront();await controls.locator('form button').click();await controls.waitForFunction(()=>document.querySelector('output').textContent.startsWith('Active: reload.test'));assert.ok(closed.isClosed());mark('actual closed matching tab permits commit without false pending');
 await w.evaluate(()=>{chrome.tabs.reload=globalThis.realReload;});await controls.locator('#remove').click();await controls.waitForFunction(()=>document.querySelector('output').textContent==='No site policy active.');
 const free=await c.newPage();await free.goto(`http://unrelated.test:${port}/free`);assert.ok(requests.includes('/free'));await controls.bringToFront();await controls.waitForTimeout(1500);mark('explicit removal recovery and unrelated navigation succeed');
} finally {await c?.close();server.closeAllConnections();await new Promise(r=>server.close(r));recording.stdin.write('q\n');const [code]=await once(recording,'exit');assert.equal(code,0);}
