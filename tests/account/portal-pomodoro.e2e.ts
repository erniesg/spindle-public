// Standalone actual-Chromium journey for the portal Pomodoro lane. Coordinator-scheduled only:
//   NODE_OPTIONS=--max-old-space-size=512 npm run build
//   SPINDLE_RECORDING_DIR=/private/run-owned/dir node build/tests/account/portal-pomodoro.e2e.js
// Actual account HTTP service, real HttpOnly cookies, Origin and CSRF: every account/timer request goes
// to the backend unintercepted. Until the coordinator's shell is served, a harness document stands in
// for the shell: Playwright fulfils ONLY the static /portal-pomodoro-harness/* document and compiled
// modules under the real origin; it refuses to fulfil any other path. The harness signs in through the
// real AccountClient (browser cookies), never seeds auth/localStorage. Two browser contexts are
// browser sync only, not native multi-device or installed-app acceptance.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,type BrowserContext,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';

const build=resolve(import.meta.dirname,'../..');
const output=process.env.SPINDLE_RECORDING_DIR;if(!output)throw Error('Set SPINDLE_RECORDING_DIR to a private run-owned directory');
await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(output,'service-')),key=randomBytes(32);
let server=await startTrackingServer(join(directory,'server'),key);
const prefix='/portal-pomodoro-harness/';
// Exact allowlist of compiled lane + existing shared client modules; no API path is ever fulfilled here.
const modules=new Map([['core/account/portal/pomodoro.js',''],['core/account/client.js',''],['core/pomodoro/client.js',''],['core/pomodoro/protocol.js','']]);
for(const file of modules.keys())modules.set(file,await readFile(join(build,file),'utf8'));
const harness=`<!doctype html><meta charset="utf-8"><title>Spindle portal · Pomodoro (lane harness)</title>
<style>body{font:16px/1.5 system-ui;margin:2rem auto;max-width:40rem;color:#1d1b16;background:#f6f3ec}.portal-card{background:#fffdf8;border:1px solid #d9d3c4;border-radius:12px;padding:1.5rem}.pomodoro-heading{display:flex;justify-content:space-between;align-items:baseline}.pomodoro-countdown{display:block;font-size:4rem;font-variant-numeric:tabular-nums}.portal-badge{border:1px solid currentColor;border-radius:99px;padding:0 .6rem;font-size:.8rem}.portal-actions{display:flex;gap:.5rem}.portal-muted{color:#6b6556}.portal-error{color:#a13a1f}fieldset{border:0;padding:0;margin:1rem 0}.harness{font-size:.8rem;color:#6b6556;border-bottom:1px dashed #d9d3c4;margin-bottom:1rem}</style>
<p class="harness">Lane harness standing in for the coordinator portal shell. Real account service; invented account only.</p>
<form id="signin"><input name="account" aria-label="Account" required><input name="password" type="password" aria-label="Password" required><label><input name="register" type="checkbox">Create invented account</label><button>Sign in</button><button type="button" id="signout">Sign out</button></form>
<main id="root"></main>
<script type="module">
import {AccountClient} from './core/account/client.js';import {mountPomodoro} from './core/account/portal/pomodoro.js';
const client=new AccountClient(location.origin,fetch.bind(globalThis),true),root=document.getElementById('root');let stop,controller;
const mount=()=>{controller=new AbortController();stop=mountPomodoro({root,client,signal:controller.signal,onError:e=>{document.body.dataset.portalError=String(e?.message??e);}});document.body.dataset.portal='mounted';};
const unmount=()=>{controller?.abort();stop?.();document.body.dataset.portal='signed-out';};
document.getElementById('signin').onsubmit=async e=>{e.preventDefault();const d=new FormData(e.target);unmount();await client.signin(String(d.get('account')),String(d.get('password')),d.get('register')==='on');e.target.reset();mount();};
document.getElementById('signout').onclick=async()=>{unmount();await client.signout();};
client.restore().then(mount,()=>{document.body.dataset.portal='signed-out';});
</script>`;
async function open(context:BrowserContext,errors:string[]){
 await context.route(`${server.origin}${prefix}**`,async route=>{
  const path=new URL(route.request().url()).pathname.slice(prefix.length);
  if(path===''||path==='index.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:harness});
  const body=modules.get(path);if(body===undefined)return route.abort();
  return route.fulfill({contentType:'text/javascript; charset=utf-8',body});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.origin+prefix);return page;
}
const name='invented-portal-timer',password='invented-only-password';
async function signin(page:Page,register=false){
 await page.getByLabel('Account').fill(name);await page.getByLabel('Password').fill(password);if(register)await page.getByLabel('Create invented account').check();
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await online(page);
}
const view=(page:Page)=>page.locator('.pomodoro-view');
const online=(page:Page,status?:string)=>page.waitForFunction(s=>{const v=document.querySelector<HTMLElement>('.pomodoro-view');return v?.dataset.pomodoroState==='online'&&(!s||v.dataset.pomodoroStatus===s);},status,{timeout:8000});
const data=async(page:Page)=>({revision:await view(page).getAttribute('data-pomodoro-revision'),session:await view(page).getAttribute('data-pomodoro-session'),countdown:await page.locator('.pomodoro-countdown').innerText()});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:process.env.SPINDLE_HEADED!=='1',args:['--no-sandbox']});
const size={width:900,height:720},recordVideo={dir:output,size};
const first=await browser.newContext({viewport:size,recordVideo}),second=await browser.newContext({viewport:size,recordVideo});
const errors:string[]=[];
try{
 const a=await open(first,errors),b=await open(second,errors);
 await signin(a,true);await signin(b);await online(a,'idle');await online(b,'idle');
 assert.equal((await data(a)).revision,'0','signin never starts a timer');
 await a.screenshot({path:join(output,'01-signed-in-idle.png')});
 await a.locator('.pomodoro-focus-minutes').fill('3');
 await a.getByRole('button',{name:'Start focus',exact:true}).click();await online(a,'running');
 await online(b,'running'); // Ordinary 2 s poll; no manual refresh.
 const started=await data(a);assert.equal((await data(b)).session,started.session);assert.equal((await data(b)).revision,'1');
 await b.screenshot({path:join(output,'02-second-client-same-session.png')});
 await pause(2500);
 await b.getByRole('button',{name:'Pause',exact:true}).click();await online(b,'paused');await online(a,'paused');
 const paused=await data(b);assert.equal((await data(a)).countdown,paused.countdown);assert.equal(paused.revision,'2');
 await a.screenshot({path:join(output,'03-paused-both.png')});
 await a.reload();await online(a,'paused'); // HttpOnly cookie restore through /session; no reauthentication.
 assert.deepEqual(await data(a),paused);await pause(1500);assert.equal((await data(a)).countdown,paused.countdown);
 await a.screenshot({path:join(output,'04-reload-retains-paused.png')});
 // CSRF stays authoritative: a raw command without the token is refused by the real service.
 assert.equal(await a.evaluate(async()=>(await fetch('/pomodoro/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'no-csrf',expectedRevision:2,action:'reset'})})).status),403);
 await b.getByRole('button',{name:'Reset',exact:true}).click();await online(b,'idle');await online(a,'idle');
 assert.equal((await data(a)).revision,'3');assert.equal((await data(a)).session,'');
 await a.screenshot({path:join(output,'05-reset-both.png')});
 // Server restart: the durable encrypted account timer survives; both views reconcile.
 const port=Number(new URL(server.origin).port);await server.close();server=await startTrackingServer(join(directory,'server'),key,port);
 await b.getByRole('button',{name:'Refresh',exact:true}).click();await online(b,'idle');assert.equal((await data(b)).revision,'3');
 await b.getByRole('button',{name:'Sign out',exact:true}).click();
 await b.waitForFunction(()=>document.body.dataset.portal==='signed-out'&&!document.querySelector('.pomodoro-view'));
 assert.equal((await b.locator('body').innerText()).includes(password),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',scope:'actual Chromium + actual account service; lane harness stands in for shell; two contexts = browser sync only, not native multi-device',output}));
}finally{await first.close();await second.close();await browser.close();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
