import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,type Browser} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';

// Explicit existing browser only: no downloads, seeded auth or intercepted APIs.
// Run sequentially with SPINDLE_REVIEW_CHROMIUM and a short private TMPDIR.
test('first visit is neutral; real session expiry still clears the signed-in workspace', {skip:!process.env.SPINDLE_REVIEW_CHROMIUM,timeout:30000},async()=>{
 const root=resolve('.local/portal-tests');mkdirSync(root,{recursive:true});
 const directory=mkdtempSync(join(root,'entry-')),key=randomBytes(32);
 const server=await startTrackingServer(directory,key);
 let browser:Browser|undefined;
 try{
  browser=await chromium.launch({executablePath:process.env.SPINDLE_REVIEW_CHROMIUM,headless:true,chromiumSandbox:true});
  const context=await browser.newContext(),page=await context.newPage();
  const errors:string[]=[],responses:{path:string;status:number}[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{const url=new URL(response.url());if(url.origin===server.origin)responses.push({path:url.pathname,status:response.status()});});
  await page.goto(server.origin+'/portal#pomodoro');
  await page.waitForFunction(()=>document.getElementById('portal-message')?.textContent?.startsWith('Create an account or sign in.'),undefined,{timeout:5000});
  assert.equal(await page.locator('#portal-message').getAttribute('class'),'portal-status');
  assert.ok(responses.some(r=>r.path==='/session'&&r.status===401));
  if(process.env.SPINDLE_PORTAL_ENTRY_SCREENSHOT)await page.screenshot({path:process.env.SPINDLE_PORTAL_ENTRY_SCREENSHOT,fullPage:true});
  await page.locator('#portal-name').fill('invented-entry-'+Date.now());
  await page.locator('#portal-password').fill('invented-session-check-password');
  await page.locator('#portal-register').click();
  await page.locator('#portal-sync-view').click();
  await page.locator('.pomodoro-view[data-pomodoro-state="online"]').waitFor();
  assert.ok(responses.some(r=>r.path==='/register'&&r.status===200));
  assert.equal(await page.locator('.pomodoro-view').getAttribute('data-pomodoro-status'),'idle');
  // Deletion, not injection: the next real timer poll receives an actual401.
  await context.clearCookies();
  await page.locator('#portal-auth:not([hidden])').waitFor({timeout:6000});
  assert.match(await page.locator('#portal-message').innerText(),/Your session ended/);
  assert.equal(await page.locator('#portal-message').getAttribute('class'),'portal-error');
  assert.equal(await page.locator('#portal-view').innerText(),'');
  assert.equal(await page.locator('#portal-account').innerText(),'');
  assert.equal(await page.locator('#portal-password').inputValue(),'');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();key.fill(0);rmSync(directory,{recursive:true,force:true});}
});
