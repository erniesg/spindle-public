// Browser journey + recording for the portal classification and study->leisure controls.
// FUNCTIONAL UI PILOT, not native/Mac/installed acceptance and not a real-model run:
//  - the SERVED portal (/portal, its real app.js, AccountClient and HttpOnly cookies) on a
//    temporary tracking server, driven through the ordinary sign-up / view-consent UI;
//  - uploads come from an invented TrackingClient ("simulated device"), so the history is
//    scripted, not a native capture;
//  - the model is a real TextProvider on a SCRIPTED transport (no network, no credential, no paid call).
// No request is routed, fulfilled or mocked in the browser. Set SPINDLE_DEMO_CORE to a built core/
// directory URL (the base commit's build) with SPINDLE_DEMO_MODE=before to capture the old UI.
//
//   SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome SPINDLE_PORTAL_DEMO_OUTPUT=/private/scratch/dir \
//     node --max-old-space-size=256 build/tests/account/portal-demo.e2e.js
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium,type Page} from 'playwright-core';
import {observation,scripted} from './portal-demo-fixture.js';
import {AccountClient} from '../../core/account/client.js';
import type {startTrackingServer as StartServer} from '../../core/tracking/server.js';
import type {TrackingClient as Collector} from '../../core/tracking/client.js';

const output=process.env.SPINDLE_PORTAL_DEMO_OUTPUT;
if(!output||!process.env.SPINDLE_CHROMIUM_EXECUTABLE)throw Error('Set SPINDLE_CHROMIUM_EXECUTABLE and SPINDLE_PORTAL_DEMO_OUTPUT (private scratch directory).');
const mode=process.env.SPINDLE_DEMO_MODE==='before'?'before':'after';
const out=resolve(output),here=dirname(fileURLToPath(import.meta.url));
const core=process.env.SPINDLE_DEMO_CORE??pathToFileURL(resolve(here,'../../core')+'/').href;
const {startTrackingServer}=await import(new URL('tracking/server.js',core).href) as {startTrackingServer:typeof StartServer};
const {TrackingClient}=await import(new URL('tracking/client.js',core).href) as {TrackingClient:typeof Collector};
await mkdir(join(out,'video'),{recursive:true});

const script=scripted();
const server=await startTrackingServer(join(out,'server'),randomBytes(32),0,undefined,undefined,undefined,undefined,undefined,mode==='after'?script.config:undefined);
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE,headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1500},recordVideo:{dir:join(out,'video'),size:{width:1280,height:800}}});
const page=await context.newPage();
const receipt:Record<string,unknown>={label:`${mode}: VM Chromium + served portal on a temporary tracking server; simulated device uploads; SCRIPTED model transport; not native/installed acceptance`,mode,steps:[] as string[]};
const step=async(name:string)=>{const n=(receipt.steps as string[]).length+1;await page.screenshot({path:join(out,`${mode}-${String(n).padStart(2,'0')}-${name}.png`),fullPage:true});(receipt.steps as string[]).push(name);};
const text=(selector:string)=>page.locator(selector).first().innerText();
try{
 const requests:string[]=[];page.on('request',r=>{if(new URL(r.url()).origin===server.origin)requests.push(`${r.method()} ${new URL(r.url()).pathname}`);});
 const account='invented-demo-'+randomBytes(3).toString('hex'),password='invented-password-'+randomUUID();
 await page.goto(server.origin+'/portal');
 await page.fill('#portal-name',account);await page.fill('#portal-password',password);await page.click('#portal-register');
 await page.click('#portal-sync-view');
 await page.waitForSelector('.tracking-sync:text("Up to date")');
 // Invented uploads from a separate simulated device on the same account.
 const device=new TrackingClient(server.origin,join(out,'device'),randomBytes(32));
 await device.signin(account,password,'Invented Mac (simulated device)');
 const deviceId=(await device.inspect()).deviceId!,now=Date.now();
 const upload=async(ago:number,title:string,words:string,seconds=20)=>{await device.enqueue(observation(deviceId,now-ago,seconds,words,title));while((await device.sync()).pending);await device.settle();};
 await upload(900000,'Invented cell biology chapter','Invented permitted reading about invented cell biology notes and diagrams');
 await upload(800000,'Invented history essay','Invented permitted reading about an invented harbour town and its trade routes');
 await upload(700000,'Invented tiny note','ok');
 await page.click('.tracking-refresh');
 await page.waitForFunction(()=>document.querySelectorAll('.tracking-entry').length===3);
 await step('history-before-controls');
 if(mode==='before'){
  assert.equal(await page.locator('.tracking-classification').count(),0);
  await page.click('[data-view="blocking"]');await page.waitForSelector('.blocking-view');await step('blocking-before');
  receipt.result='pass';
 }else{
  // Labels are off until the owner turns local processing on; the AI card says so and sends nothing.
  await page.waitForSelector('.tracking-classification [data-action="processing"]');
  assert.match(await text('.tracking-entry-label-text'),/Labels are off/);
  assert.match(await text('.tracking-classify-model'),/nebius · invented\/classifier \(text only\)/);
  assert.match(await text('.tracking-classify-quota'),/Service classification quota: 0\/2 this minute · 0\/12 this day window/);
  assert.equal(await page.locator('[data-auto="toggle"]').isDisabled(),true,'automatic stays disabled without consent');
  await step('labels-off-consent-needed');
  await page.click('[data-action="processing"]');
  await page.waitForSelector('[data-action="processing"]:text("Turn off label processing")');
  await page.check('[data-field="title"]');await page.check('[data-field="text"]');
  await page.click('[data-action="grant"]');
  await page.waitForSelector('[data-action="revoke"]');
  assert.equal(script.calls.length,0,'consent alone sends nothing');
  await step('consent-granted-text-fields');
  // The short item cannot be sent; the reason is shown.
  const tiny=page.locator('.tracking-entry',{hasText:'Invented tiny note'});
  assert.match(await tiny.locator('.tracking-classify-why').innerText(),/Too little allowed text/);
  assert.equal(await tiny.locator('[data-action="classify"]').isDisabled(),true);
  const first=page.locator('.tracking-entry',{hasText:'Invented cell biology chapter'});
  await first.locator('[data-action="classify"]').click();
  await first.locator('.tracking-entry-note:text("AI suggestion saved")').waitFor();
  assert.equal(script.calls.length,1);
  await first.locator('.tracking-entry-label-text:text("AI suggestion: Learning")').waitFor();
  assert.match(await first.locator('.tracking-entry-label-text').innerText(),/AI suggestion: Learning · nebius · invented\/classifier · not yet your label/);
  await step('ai-suggestion-not-yet-mine');
  await first.locator('[data-action="confirm"]').click();

  await first.locator('.tracking-entry-label-text:text("Your label: Learning")').waitFor();
  assert.equal(await first.locator('[data-action="classify"]').count(),0,'a user label is never replaced by AI');
  await step('confirmed-as-my-label');
  // Error path through the real server: consent revoked elsewhere, this page is stale, the server refuses.
  const other=new AccountClient(server.origin);await other.signin(account,password);
  await other.request('/classification/consent',{enabled:false});
  const second=page.locator('.tracking-entry',{hasText:'Invented history essay'});
  await second.locator('[data-action="classify"]').click();
  await second.locator('.tracking-entry-note:text("refused")').waitFor();
  assert.equal(script.calls.length,1,'the server refused; nothing was sent');
  await step('server-refused-stale-consent');
  await page.waitForSelector('[data-action="grant"]:text("Allow AI")');
  // Automatic mode: explicit consent first, then only a newly uploaded text item.
  await page.check('[data-field="text"]');await page.click('[data-action="grant"]');await page.waitForSelector('[data-action="revoke"]');
  await page.check('[data-auto="toggle"]');
  await upload(60000,'Invented new lecture notes','Invented permitted reading about newly uploaded invented lecture notes on harbour history');
  await page.click('.tracking-refresh');
  const fresh=page.locator('.tracking-entry',{hasText:'Invented new lecture notes'});
  await fresh.locator('.tracking-entry-label-text:text("AI suggestion")').waitFor();
  assert.equal(script.calls.length,2,'one automatic call for the new item only');
  assert.match(await second.locator('.tracking-entry-label-text').innerText(),/No label yet/);
  await step('automatic-new-item-only');
  // Study -> leisure on the blocking view: off by default, honest zero, no pretend spend.
  await page.click('[data-view="blocking"]');await page.waitForSelector('[data-blocking="earned-toggle"]');
  assert.match(await text('[data-blocking="earned-toggle"]'),/Turn on study/);
  assert.match(await text('[data-blocking="earned-basis"]'),/not verified learning/);
  await step('study-leisure-off');
  await page.click('[data-blocking="earned-toggle"]');await page.waitForSelector('[data-blocking="earned-zero"]');
  assert.equal(await page.locator('[data-blocking="earned-redeem"]').isDisabled(),true);
  assert.match(await text('[data-blocking="earned-instruction"]'),/paired companion/);
  await step('study-leisure-on-zero-no-adapter');
  const earned=await other.request('/earned-leisure/read',{}) as {enabled:boolean};assert.equal(earned.enabled,true);
  await page.click('#portal-signout');await page.waitForSelector('#portal-auth:not([hidden])');
  await step('signed-out');
  assert.ok(requests.some(r=>r==='POST /classification/classify'));
  receipt.providerCalls=script.calls.length;
  receipt.result='pass';
 }
 receipt.routes=[...new Set(requests)].sort();
}catch(error){receipt.result='fail';receipt.error=error instanceof Error?error.message:String(error);await step('failure').catch(()=>{});throw error;}
finally{
 const video=page.video();await context.close();await browser.close();
 receipt.video=video?await video.path():null;
 await server.close();await rm(join(out,'server'),{recursive:true,force:true});await rm(join(out,'device'),{recursive:true,force:true});
 await writeFile(join(out,`${mode}-receipt.json`),JSON.stringify(receipt,null,1));
}
