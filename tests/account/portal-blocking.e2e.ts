// Standalone blocking-lane journey. Run ONLY when the coordinator selects the effect:
//   SPINDLE_REVIEW_CHROMIUM=/path/to/chrome node build/tests/account/portal-blocking.e2e.js
// Default effect `portal`: actual tracking server, invented account registered by this
// browser context (HttpOnly cookie), actual AccountClient.restore(), real /blocking/*
// requests with NO network interception of the backend. HARNESS DISCLOSURE: the
// central shell does not exist yet, so the compiled lane module is injected into the
// real authenticated /connections origin (bypassCSP is a harness affordance only).
// Effect `extension` (SPINDLE_BLOCKING_EFFECTS=extension) additionally loads the built
// extension into a fresh disposable profile and checks invented-site navigation.
// It needs DISPLAY, SPINDLE_BLOCKING_EXTENSION and SPINDLE_BLOCKING_PROFILE, an already
// enrolled native host and approved site access; this script never enrolls, grants
// permissions or changes native state. Exit 0 = PASS, 3 = HELD (reason in results.json).
import {chromium,type BrowserContext,type Page} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';

const executablePath=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executablePath)throw Error('Select cached Chromium explicitly (SPINDLE_REVIEW_CHROMIUM)');
const effect=process.env.SPINDLE_BLOCKING_EFFECTS??'portal';if(!['portal','extension'].includes(effect))throw Error('SPINDLE_BLOCKING_EFFECTS must be portal|extension');
const output=resolve(process.env.SPINDLE_BLOCKING_OUTPUT??join(process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch/spindle-readiness-20261028/portal-blocking','e2e-'+Date.now()));
const record=process.env.SPINDLE_BLOCKING_RECORD==='1';
await mkdir(output,{recursive:true});
const lane=await readFile(new URL('../../core/account/portal/blocking.js',import.meta.url),'utf8');
assert.ok(!/^import\s/m.test(lane),'lane module must have no runtime imports to be injected standalone');

const key=randomBytes(32),store=await mkdtemp(join(output,'store-'));
const server=await startTrackingServer(store,key,0);
// Invented site for the extension effect: every request that ARRIVES is counted; a block means none arrive.
const hits:string[]=[];
const site=createServer((req,res)=>{hits.push(String(req.headers.host)+req.url);res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Invented distracting site</h1>');});
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const sitePort=(site.address() as {port:number}).port,blockedHost='distracting.invented.test',siteUrl=`http://${blockedHost}:${sitePort}/`;
const results:Record<string,unknown>={effect,startedUtc:new Date().toISOString(),origin:server.origin,steps:[] as unknown[],disclosure:'invented account/site; lane module injected into real authenticated origin; backend not intercepted'};
const step=async(page:Page,name:string,extra:Record<string,unknown>={})=>{(results.steps as unknown[]).push({name,utc:new Date().toISOString(),...extra});await page.screenshot({path:join(output,name+'.png'),fullPage:true});if(record)await page.waitForTimeout(1500);};
const finish=async(outcome:string,code:number)=>{results.outcome=outcome;results.finishedUtc=new Date().toISOString();await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));console.log(outcome,output);process.exitCode=code;};

let context:BrowserContext|undefined;let browserClose:(()=>Promise<void>)|undefined;
try{
 const video=record?{recordVideo:{dir:join(output,'video'),size:{width:1280,height:900}}}:{};
 if(effect==='extension'){
  const extension=process.env.SPINDLE_BLOCKING_EXTENSION,profile=process.env.SPINDLE_BLOCKING_PROFILE;
  if(!extension||!profile||!process.env.DISPLAY)throw Error('extension effect needs DISPLAY, SPINDLE_BLOCKING_EXTENSION and a fresh SPINDLE_BLOCKING_PROFILE');
  context=await chromium.launchPersistentContext(profile,{executablePath,headless:false,bypassCSP:true,viewport:{width:1280,height:900},...video,
   args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--host-resolver-rules=MAP ${blockedHost} 127.0.0.1`]});
  browserClose=()=>context!.close();
 }else{
  const browser=await chromium.launch({executablePath,headless:true});browserClose=()=>browser.close();
  context=await browser.newContext({bypassCSP:true,viewport:{width:1280,height:900},...video});
 }
 const external:string[]=[],blockingCalls:{path:string;status:number}[]=[];
 context.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')&&u.origin!==server.origin&&u.hostname!==blockedHost)external.push(u.origin);});
 context.on('response',r=>{const u=new URL(r.url());if(u.origin===server.origin&&u.pathname.startsWith('/blocking/'))blockingCalls.push({path:u.pathname,status:r.status()});});
 const auth=await context.request.post(server.origin+'/register',{headers:{Origin:server.origin},data:{name:'invented-blocking-owner',password:'invented-password-123'}});
 assert.equal(auth.status(),200);
 const page=await context.newPage();
 await page.goto(server.origin+'/connections');await page.getByText('Signed in as invented-blocking-owner').waitFor();
 await page.addScriptTag({type:'module',content:lane+'\nwindow.__spindleBlockingLane={mountBlocking};'});
 await page.waitForFunction(()=>'__spindleBlockingLane' in window);
 await page.evaluate(async()=>{
  const w=window as any;const {AccountClient}=await import('/connections-client.js' as string);
  const client=new AccountClient(location.origin,fetch.bind(globalThis),true);await client.restore();
  const root=document.createElement('main');root.id='blocking-lane-root';document.body.replaceChildren(root);
  const shell=new AbortController();w.__blockingErrors=[];
  w.__blockingUnmount=w.__spindleBlockingLane.mountBlocking({root,client,signal:shell.signal,onError:(e:Error)=>w.__blockingErrors.push(String(e?.message??e))});
 });
 await page.locator('[data-blocking="unwired"],[data-blocking="policy"],[data-blocking="error"]').first().waitFor();
 results.blockingCalls=blockingCalls;results.external=external;
 assert.deepEqual(external,[],'no non-origin traffic');
 if(await page.locator('[data-blocking="unwired"]').count()){
  await step(page,'01-adapter-unwired',{status:blockingCalls});
  await finish('HELD_ADAPTER_UNWIRED: /blocking/status is not served by this backend yet',3);
 }else{
  await step(page,'01-signed-in-policy-view');
  const readiness=await page.locator('[data-blocking="readiness"]').innerText();results.readiness=readiness;
  await page.locator('[data-blocking="host-input"]').fill(blockedHost);
  await page.locator('[data-blocking="submit"]').click();
  await page.locator('[data-blocking="host"]',{hasText:blockedHost}).waitFor();
  await step(page,'02-whole-site-rule-saved');
  if(effect!=='extension'){await finish('PORTAL_ONLY: rule round-tripped through the real adapter; browser enforcement not exercised',0);}
  else{
   // Enforcement is the extension's; wait for its own report rather than assuming.
   await page.locator('[data-blocking="state"]',{hasText:'Active'}).waitFor({timeout:30000}).catch(()=>{});
   if(!/Chrome extension enrolled/.test(await page.locator('[data-blocking="readiness"]').innerText())||!(await page.locator('[data-blocking="state"]',{hasText:'Active'}).count())){
    await step(page,'03-not-ready');await finish('HELD_EXTENSION_NOT_READY: enrollment/native host/site access not established; no enrollment attempted',3);
   }else{
    const visit=async(name:string)=>{const tab=await context!.newPage();const before=hits.length;const error=await tab.goto(siteUrl).then(()=>null,(e:Error)=>e.message);await step(tab,name,{arrived:hits.length-before,error});await tab.close();return hits.length-before;};
    assert.equal(await visit('04-navigation-blocked'),0,'blocked navigation must never reach the invented server');
    await page.locator('[data-blocking="pause-5"]').click();await page.locator('[data-blocking="resume"]').waitFor();await step(page,'05-paused');
    assert.equal(await visit('06-paused-navigation-allowed'),1);
    await page.locator('[data-blocking="resume"]').click();await page.locator('[data-blocking="state"]',{hasText:'Active'}).waitFor({timeout:30000});
    assert.equal(await visit('07-resumed-blocked'),0);
    await page.locator('[data-blocking="remove"]').click();await page.locator('[data-blocking="empty"]').waitFor({timeout:30000});await step(page,'08-removed-recovery');
    assert.equal(await visit('09-after-remove-allowed'),1);
    await finish('PASS_EXTENSION_VM: Linux/Xvfb Chromium with built extension; NOT Mac/Windows installed acceptance',0);
   }
  }
 }
 results.errors=await page.evaluate(()=>(window as any).__blockingErrors);
 await page.evaluate(()=>(window as any).__blockingUnmount());
 await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));
}finally{await browserClose?.();await server.close();site.close();key.fill(0);await rm(store,{recursive:true,force:true});}
