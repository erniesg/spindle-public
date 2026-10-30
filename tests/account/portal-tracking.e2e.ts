// Standalone browser journey + recording for the tracking lane. NOT native Mac,
// installed, permission or multi-device acceptance. Real tracking server, real
// Chromium, real AccountClient with HttpOnly browser cookies; no request is
// routed, fulfilled or mocked. The host document is the server's own JSON
// reply for an unknown path; the sign-in form is a labelled test harness
// standing in for the coordinator's shared shell. Device uploads come from an
// invented TrackingClient ("simulated uploader"), not a Mac collector.
//
// Run (coordinator-scheduled, one browser):
//   NODE_OPTIONS=--max-old-space-size=512 npm run build
//   SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome SPINDLE_PORTAL_TRACKING_OUTPUT=/private/scratch/dir \
//     node --max-old-space-size=256 build/tests/account/portal-tracking.e2e.js
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import type {Operation} from '../../core/tracking/types.js';

const output=process.env.SPINDLE_PORTAL_TRACKING_OUTPUT;
if(!output||!process.env.SPINDLE_CHROMIUM_EXECUTABLE)throw Error('Set SPINDLE_CHROMIUM_EXECUTABLE and SPINDLE_PORTAL_TRACKING_OUTPUT (private scratch directory).');
const out=resolve(output),here=dirname(fileURLToPath(import.meta.url)),built=resolve(here,'../../core/account');
await mkdir(join(out,'video'),{recursive:true});
// Classic-script bundle of the compiled client and lane module (no network, no bundler).
const strip=(js:string)=>js.replace(/^import .*$/gm,'').replace(/^export /gm,'');
const bundle=`(()=>{${strip(await readFile(join(built,'client.js'),'utf8'))}\n${strip(await readFile(join(built,'portal/tracking.js'),'utf8'))}
const harness=()=>{
 document.documentElement.replaceChildren();const body=document.createElement('body');document.documentElement.append(body);
 const style=document.createElement('style');style.textContent='body{font:15px/1.45 system-ui;margin:24px;max-width:1100px;color:#222}.harness{border:2px dashed #b55;padding:10px;margin-bottom:16px}.portal-grid{display:grid;grid-template-columns:3fr 2fr;gap:16px}.portal-card{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin-bottom:16px}.portal-muted{color:#666}.portal-error{color:#a00}.portal-badge{border:1px solid #999;border-radius:10px;padding:0 8px;margin-left:8px;font-size:12px}.tracking-step-top,.tracking-entry-top{display:flex;justify-content:space-between}.tracking-device{display:flex;flex-direction:column;margin-bottom:8px}code{background:#f2f2f2;padding:0 3px}';
 const note=document.createElement('div');note.className='harness';note.textContent='E2E HARNESS — stands in for the shared shell; harness styling only. Invented account and simulated uploads.';
 const form=document.createElement('form');const name=document.createElement('input');name.id='h-name';name.placeholder='Account name';
 const pass=document.createElement('input');pass.id='h-pass';pass.type='password';pass.placeholder='Password';
 const create=document.createElement('button');create.id='h-create';create.textContent='Create account';create.type='button';
 const signin=document.createElement('button');signin.id='h-signin';signin.textContent='Sign in';signin.type='button';
 const signout=document.createElement('button');signout.id='h-signout';signout.textContent='Sign out';signout.type='button';
 const state=document.createElement('p');state.id='h-state';form.append(name,pass,create,signin,signout,state);note.append(form);
 const root=document.createElement('main');root.id='portal';body.append(style,note,root);
 const client=new AccountClient(location.origin,fetch,true);let controller,dispose=()=>{};
 const mount=()=>{dispose();controller=new AbortController();state.textContent='Signed in as '+client.account.name;dispose=mountTracking({root,client,signal:controller.signal,onError:e=>{state.textContent='Shell notified: '+e.message;}});};
 const go=register=>client.signin(name.value,pass.value,register).then(mount,e=>{state.textContent='Sign-in failed: '+e.message;}).finally(()=>{pass.value='';});
 create.onclick=()=>go(true);signin.onclick=()=>go(false);
 signout.onclick=async()=>{controller?.abort();await client.signout().catch(()=>{});state.textContent='Signed out';};
 client.restore().then(mount,()=>{state.textContent='Not signed in';});
};
document.readyState==='loading'?addEventListener('DOMContentLoaded',harness):harness();})();`;

const server=await startTrackingServer(join(out,'server'),randomBytes(32));
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE,headless:true});
const context=await browser.newContext({viewport:{width:1200,height:1000},recordVideo:{dir:join(out,'video'),size:{width:1200,height:1000}}});
const receipt:Record<string,unknown>={label:'VM Chromium + real local tracking server; simulated uploader; not native Mac/installed/multi-device acceptance',origin:'loopback',steps:[]};
const step=async(name:string)=>{await page.screenshot({path:join(out,`${(receipt.steps as string[]).length+1}-${name}.png`),fullPage:true});(receipt.steps as string[]).push(name);};
const page=await context.newPage();
try{
 await context.addInitScript({content:bundle});
 const requests:string[]=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await page.goto(server.origin+'/portal-tracking-harness');
 await page.waitForSelector('#h-state:text("Not signed in")');
 const account='invented-portal-'+randomBytes(3).toString('hex'),password='invented-password-'+randomUUID();
 await page.fill('#h-name',account);await page.fill('#h-pass',password);await page.click('#h-create');
 await page.waitForSelector('.tracking-sync:text("Up to date")');
 assert.equal(await page.locator('.tracking-step[data-state="unavailable"]').count(),1);
 assert.match(await page.locator('.tracking-history-empty').innerText(),/No history yet/);
 await step('created-account-empty');
 // Invented uploads from a separate simulated device client on the same account/service.
 const device=new TrackingClient(server.origin,join(out,'device'),randomBytes(32));
 await device.signin(account,password,'Invented Mac (simulated uploader)');
 const deviceId=(await device.inspect()).deviceId!,now=Date.now(),wall=now-1800000;
 const apps=['invented-editor','invented-notes','invented-browser'];
 for(let n=0;n<20;n++){
  const visitId=`visit-${n}`,start=n*60000,end=start+45000,browserVisit=n%3===2;
  const op:Operation={id:randomUUID(),deviceId,recordingId:'invented-recording',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-recording',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:wall,monotonicAnchor:0,observedAt:end,expiresAt:now+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:end,coverage:'observed'},visit:{id:visitId,key:'invented/window',app:apps[n%3]!,title:n===4?'<script>alert("invented")</script>':`Invented sample ${n}`,start,end,clock:'invented-clock',revision:1,browser:browserVisit,text:'invented',textSource:browserVisit?'dom:invented':'native',url:'',image:'',availability:'native-text',sampledAt:start,framePTS:null,expiresAt:now+900000}}};
  await device.enqueue(op);
 }
 while((await device.sync()).pending);await device.settle();
 await page.click('.tracking-refresh');
 await page.waitForFunction(()=>document.querySelectorAll('.tracking-entry').length===20);
 assert.equal(await page.locator('.tracking-device-name').innerText(),'Invented Mac (simulated uploader)');
 assert.equal(await page.locator('script:text("invented")').count(),0);
 assert.ok((await page.locator('.tracking-history').innerText()).includes('<script>alert("invented")</script>'));
 await step('history-after-sync');
 await page.click('.tracking-range[data-range="week"]');
 await page.waitForSelector('.tracking-range[data-range="week"][aria-pressed="true"]');
 await page.waitForSelector('.tracking-person-time');
 await step('week-summary');
 // Reload: HttpOnly cookie restore through the real client; history comes from the backend again.
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.tracking-entry').length===20);
 await step('after-reload');
 await page.click('#h-signout');await page.waitForSelector('#h-state:text("Signed out")');
 assert.equal(await page.locator('.tracking-view').count(),0);
 await step('signed-out');
 assert.ok(requests.every(p=>['/portal-tracking-harness','/register','/signin','/session','/devices','/history','/sessions','/logout'].includes(p)),'only existing account routes: '+[...new Set(requests)].join(','));
 receipt.routes=[...new Set(requests)].sort();receipt.result='pass';
}catch(error){receipt.result='fail';receipt.error=error instanceof Error?error.message:String(error);await step('failure').catch(()=>{});throw error;}
finally{
 const video=page.video();await context.close();await browser.close();
 receipt.video=video?await video.path():null;
 await server.close();await rm(join(out,'server'),{recursive:true,force:true});await rm(join(out,'device'),{recursive:true,force:true});
 await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,1));
}
