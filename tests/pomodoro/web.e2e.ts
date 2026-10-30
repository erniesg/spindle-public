// Actual Chromium + account HTTP service. Not installed desktop or physical-device proof.
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';
await mkdir('.local',{recursive:true});
const directory=await mkdtemp(join(process.cwd(),'.local/pomodoro-browser-'));
const key=randomBytes(32);let server=await startTrackingServer(join(directory,'server'),key);
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
const first=await browser.newContext(),second=await browser.newContext();
const errors:string[]=[];
async function open(context:typeof first){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(server.origin+'/pomodoro/app/');return page;}
async function signin(page:Page,name:string,register=false){await page.locator('[name=account]').fill(name);await page.locator('[name=password]').fill('invented-only-password');if(register)await page.locator('[name=register]').check();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='online');}
const state=async(page:Page)=>(await page.locator('.revision').innerText());
try{
 const a=await open(first);await signin(a,'invented-web-alice',true);
 const b=await open(second);await signin(b,'invented-web-alice');
 const draft=await open(second);await draft.getByRole('button',{name:'Start focus',exact:true}).waitFor();await draft.locator('.focus-duration').fill('2');
 await a.locator('.focus-duration').fill('1');await a.locator('.break-duration').fill('0.5');
 await a.getByRole('button',{name:'Start focus',exact:true}).click();
 await b.getByRole('button',{name:'Pause',exact:true}).waitFor();
 await b.waitForFunction(()=>(document.querySelector('.focus-duration') as HTMLInputElement)?.value==='1'&&(document.querySelector('.break-duration') as HTMLInputElement)?.value==='0.5',{},{timeout:3000});
 await draft.getByRole('button',{name:'Pause',exact:true}).waitFor();assert.equal(await draft.locator('.focus-duration').inputValue(),'2');assert.match(await draft.locator('.duration-note').innerText(),/Your duration draft/);
 await b.getByRole('button',{name:'Pause',exact:true}).click();
 await a.getByRole('button',{name:'Resume',exact:true}).waitFor();
 const host=new AccountClient(server.origin);await host.signin('invented-web-alice','invented-only-password');
 let snapshot=await host.request('/pomodoro') as Snapshot;
 assert.equal(snapshot.timer.status,'paused');assert.equal(snapshot.timer.revision,2);
 assert.match(await state(a),/revision 2/);assert.match(await state(b),/revision 2/);
 // Real browser cookie auth: CSRF cannot be omitted and credentials never appear in the rendered timer.
 assert.equal(await a.evaluate(async()=>{const r=await fetch('/pomodoro/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'no-csrf',expectedRevision:2,action:'reset'})});return r.status;}),403);
 assert.equal((await a.locator('body').innerText()).includes('invented-only-password'),false);
 await second.setOffline(true);await b.getByRole('button',{name:'Refresh / reconnect'}).click();await b.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='stale');
 assert.equal(await b.getByRole('button',{name:'Resume',exact:true}).isEnabled(),false);
 await a.getByRole('button',{name:'Reset',exact:true}).click();
 await second.setOffline(false);await b.getByRole('button',{name:'Refresh / reconnect'}).click();await b.getByRole('button',{name:'Start focus',exact:true}).waitFor();
 assert.equal((await host.request('/pomodoro') as Snapshot).timer.revision,3);
 await a.reload();await a.getByRole('button',{name:'Start focus',exact:true}).waitFor(); // Cookie bootstrap, no reauthentication.
 const port=Number(new URL(server.origin).port);await server.close();server=await startTrackingServer(join(directory,'server'),key,port);
 await b.reload();await b.getByRole('button',{name:'Start focus',exact:true}).waitFor();
 // Account switch in a second same-profile tab clears old identity/timer, rather than mixing account data.
 const switchTab=await open(first);
 await switchTab.getByRole('button',{name:'Sign out',exact:true}).click();
 await signin(switchTab,'invented-web-bob',true);
 // A poll can clear A before a manual click. Observe that real invalidation
 // first, then Reconnect must load B—not require an already-ended transient.
 await a.waitForFunction(()=>document.querySelector('.account')?.textContent==='Not signed in');
 assert.equal(await a.locator('.countdown').innerText(),'—');
 await a.getByRole('button',{name:'Refresh / reconnect'}).click();await a.waitForFunction(()=>document.querySelector('.account')?.textContent==='Signed in as invented-web-bob');
 assert.match(await state(a),/revision 0/);
 assert.equal((await host.request('/pomodoro') as Snapshot).timer.revision,3);
 await b.getByRole('button',{name:'Sign out',exact:true}).click();
 assert.equal(await b.locator('.countdown').innerText(),'—');
 assert.deepEqual(errors,[]);
 console.log('PASS actual Chromium cookie/Origin/CSRF auth, independent clients, offline/reset/reconnect, reload/server restart and account switching. No installed-platform claim.');
}finally{await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
