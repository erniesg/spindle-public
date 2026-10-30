// Focused actual Chromium/HTTP/encrypted-store proof. Invented legacy data; no external Google traffic.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import type {PrivateGoogleConnection} from '../../core/tracking/google.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const output=resolve(process.env.SPINDLE_GOOGLE_REVIEW_OUTPUT??'.local/legacy-recovery/browser');await mkdir(output,{recursive:true});
const executablePath=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executablePath)throw Error('Select cached Chromium explicitly');
const directory=join(output,'store'),key=randomBytes(32);let providerCalls=0;
const config={clientId:'invented',clientSecret:'invented',http:(async()=>{providerCalls++;throw Error('No provider access permitted');}) as typeof fetch};
let app=await startTrackingServer(directory,key,0,undefined,config);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1100,height:1000},recordVideo:{dir:join(output,'video'),size:{width:1100,height:1000}}});
const legacy:PrivateGoogleConnection[]=Array.from({length:12},(_,i)=>({id:'legacy'+String(i+1).padStart(2,'0')+'-invented',incarnation:'invented-incarnation-'+i,roots:['invented-root-'+i],rootRevision:7+i}));
const verified:PrivateGoogleConnection={id:'invented-verified-row',incarnation:'invented-verified-incarnation',identity:'verified@example.test',credential:JSON.stringify({accountId:'verified@example.test',refreshToken:'INVENTED_REFRESH',grants:[scopes.mail,scopes.drive]}),roots:['invented-verified-root'],rootRevision:4};
const trace:{path:string;status:number}[]=[],errors:string[]=[];
try{
 // Invented registration precedes any page/recording. Never inspect or export auth cookies.
 const auth=await context.request.post(app.origin+'/register',{headers:{Origin:app.origin},data:{name:'invented-owner',password:'invented-password-123'}});assert.equal(auth.status(),200);
 const port=Number(new URL(app.origin).port);await app.close();
 const store=new EncryptedStore<{accounts:{id:string;google?:PrivateGoogleConnection[]}[];sessions:Record<string,unknown>}>(directory,key,()=>{throw Error('Fixture must already exist');});
 await store.transaction(s=>{s.accounts[0].google=structuredClone([...legacy,verified]);});await store.settle();
 const before=await store.transaction(s=>s,false);
 app=await startTrackingServer(directory,key,port,undefined,config);
 await context.route('**/*',route=>new URL(route.request().url()).origin===app.origin?route.continue():route.abort());
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('p');banner.textContent='SIMULATED GOOGLE · invented legacy restart · no owner data or provider calls';banner.style.cssText='position:fixed;top:0;left:0;right:0;margin:0;z-index:10;background:#fff3ce;padding:10px;text-align:center;font:16px system-ui';document.body.prepend(banner);}));
 context.on('response',response=>{const path=new URL(response.url()).pathname;if(path.startsWith('/google/'))trace.push({path,status:response.status()});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>document.getElementById('signed')?.hidden===false&&!document.getElementById('refresh')?.hasAttribute('disabled'));
 const list=async()=>{const response=await context.request.post(app.origin+'/session',{headers:{Origin:app.origin},data:{}});assert.equal(response.status(),200);const {csrf}=await response.json();const rows=await context.request.post(app.origin+'/google/list',{headers:{Origin:app.origin,'X-CSRF-Token':csrf},data:{}});assert.equal(rows.status(),200);return (await rows.json()).connections;};
 await page.goto(app.origin+'/connections');await ready();
 const first=page.locator('article[data-connection-id="'+legacy[0].id+'"]'),recovery='No active authorization. The earlier provider cause is unknown. Not connected. Use Reconnect on this row when ready.';
 const checkInactive=async()=>{
  assert.equal(await page.locator('article').count(),13);assert.equal(await page.getByText(recovery,{exact:true}).count(),12);
  assert.match(await page.locator('#notice').innerText(),/collapsed Attempt history/);
  assert.equal(await page.locator('#attempt-history').getAttribute('open'),null);assert.equal(await page.locator('#main-connections article').count(),1);
  const rows=await list();assert.deepEqual(rows.slice(0,12).map((r:any)=>({id:r.id,roots:r.roots,rootRevision:r.rootRevision})),legacy.map(({id,roots,rootRevision})=>({id,roots,rootRevision})));
  for(const row of rows.slice(0,12)){assert.equal(row.status,'disconnected');assert.equal(row.recovery,'no_active_authorization');assert.equal(row.lastAttempt,undefined);assert.equal(row.accountId,undefined);}
  assert.equal(rows[12].status,'connected');assert.equal(rows[12].accountId,verified.identity);assert.equal(rows[12].recovery,undefined);
  assert.equal(providerCalls,0);assert.equal(trace.filter(r=>r.path==='/google/begin').length,0);
 };
 await checkInactive();await page.locator('#attempt-history summary').click();await first.scrollIntoViewIfNeeded();await page.waitForTimeout(1800);await page.screenshot({path:join(output,'legacy-restart.png')});
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await ready();await checkInactive();
 // The unchanged /session bootstrap re-encrypts its snapshot; compare logical state here.
 // The direct list regression separately checks exact encrypted bytes (no migration writes).
 await page.reload();await ready();await checkInactive();assert.deepEqual(await store.transaction(s=>s,false),before,'restart/list/UI refresh/reload preserve all state');
 await page.locator('#attempt-history summary').click();await first.scrollIntoViewIfNeeded();await page.waitForTimeout(1500);await page.screenshot({path:join(output,'legacy-refresh.png')});
 assert.equal(await first.getByRole('button',{name:'Save selected folders',exact:true}).isDisabled(),true);assert.equal(await first.getByRole('button',{name:'Check saved folder access (metadata only)',exact:true}).isDisabled(),true);
 // Exactly one explicit mock reconnect; do not follow the external authorization link or dispatch a callback.
 await first.getByRole('button',{name:'Reconnect',exact:true}).click();await ready();await page.getByRole('link',{name:'Continue to Google (opens a new tab)'}).waitFor();
 let rows=await list();assert.equal(rows.length,13);assert.equal(rows[0].id,legacy[0].id);assert.equal(rows[0].status,'pending');assert.equal(rows[0].lastAttempt.status,'pending');assert.equal(rows[0].recovery,undefined);
 await first.scrollIntoViewIfNeeded();await page.waitForTimeout(1800);await page.screenshot({path:join(output,'same-row-pending.png')});
 await first.getByRole('button',{name:'Disconnect',exact:true}).click();await ready();rows=await list();assert.equal(rows.length,13);assert.equal(rows[0].status,'disconnected');assert.equal(rows[0].lastAttempt.status,'disconnected');assert.equal(rows[0].revocation,'uncertain');assert.equal(rows[0].recovery,undefined);
 assert.equal(await page.getByRole('link',{name:'Continue to Google (opens a new tab)'}).count(),0);
 await page.locator('#attempt-history summary').click();await first.scrollIntoViewIfNeeded();await page.waitForTimeout(1800);await page.screenshot({path:join(output,'same-row-disconnected.png')});
 const after=await store.transaction(s=>s,false);assert.deepEqual(after.sessions,before.sessions);assert.deepEqual(after.accounts[0].google!.slice(1),before.accounts[0].google!.slice(1));
 assert.deepEqual(after.accounts[0].google!.map(({id,roots,rootRevision})=>({id,roots,rootRevision})),before.accounts[0].google!.map(({id,roots,rootRevision})=>({id,roots,rootRevision})));
 assert.equal(trace.filter(r=>r.path==='/google/begin').length,1);assert.equal(providerCalls,0);assert.deepEqual(errors,[]);
 await writeFile(join(output,'journey.json'),JSON.stringify({proof:'Actual Chromium/HTTP/production encrypted store; invented legacy rows and verified credential; no real Google or installed/native acceptance',chromium:browser.version(),legacyRows:12,verifiedRows:1,seedReopen:true,listRefreshReloadReadOnly:true,noInventedAttemptCauseOrTimestamp:true,sameRowExplicitReconnects:1,livePendingLease:true,pendingDisconnect:true,idsRootsSessionsPreserved:true,verifiedCredentialUntouched:true,providerCalls,noExternalBrowserRequests:true,pageErrors:errors,trace},null,2));
}finally{await context.close();await browser.close();await app.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
console.log('PASS focused legacy restart/refresh/reconnect/disconnect (invented Google only)');
