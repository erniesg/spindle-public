import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';
import {EarnedControl} from '../../core/preview/earned-control.js';
const study=(deviceId:string,start:number):Operation=>{const visitId=randomUUID();return {id:randomUUID(),deviceId,recordingId:'invented-study',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-study',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:start,monotonicAnchor:0,observedAt:45000,expiresAt:start+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'under-15s',heartbeatAt:45000,coverage:'observed'},visit:{id:visitId,key:'invented-editor',app:'invented-editor',title:'Invented study',start:0,end:45000,clock:'owned-clock',revision:1,browser:false,text:'Reading an invented explanation of fractions.',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:start+3600000}}};};
// Real UI module in disposable Chromium with real encrypted client/account transactions.
// HTTP routing is scripted local transport; no native app or installed profile claim.
test('desktop reconciles committed opt-in/out and access after lost replies',async()=>{
 const originalFetch=globalThis.fetch;
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 const dir=await mkdtemp(join(tmpdir(),'earned-honesty-'));
 const server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));
 const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
 try{
  await client.signin('invented-honesty','invented-password-123','Invented device',true);
  const reader=new AccountClient(server.origin);await reader.signin('invented-honesty','invented-password-123');await reader.request('/processing',{local:true});
  const control=new EarnedControl(()=>'fixture-profile',()=>client);
  const page=await browser.newPage();let drop=false,failRead=false,reads=0,mutations=0;
  let holdAccess=false,accessPending=false,stateReads=0;
  let beginAccess=()=>{},allowCommit=()=>{},captureState=()=>{},releaseState=()=>{};
  let accessStarted=Promise.resolve(),commitAllowed=Promise.resolve(),stateCaptured=Promise.resolve(),stateReleased=Promise.resolve();
  function armAccessRace(){
   accessStarted=new Promise<void>(resolve=>{beginAccess=resolve;});
   commitAllowed=new Promise<void>(resolve=>{allowCommit=resolve;});
   stateCaptured=new Promise<void>(resolve=>{captureState=resolve;});
   stateReleased=new Promise<void>(resolve=>{releaseState=resolve;});
  }
  globalThis.fetch=async(...args)=>{
   const response=await originalFetch(...args);
   // Lose transport only AFTER the real account transaction has committed.
   if(drop&&String(args[0]).endsWith('/earned-leisure/opt-in'))throw Error('invented lost committed reply');
   return response;
  };
  await page.route('http://fixture.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:await readFile(new URL('../../core/preview/index.html',import.meta.url),'utf8')});
   if(path==='/ui.js')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../core/preview/ui.js',import.meta.url),'utf8')});
   if(path==='/pomodoro/desktop-ui.js')return route.fulfill({contentType:'text/javascript',body:'export function mountDesktopPomodoro(){return {client:{},dispose(){}}}'});
   if(path.endsWith('.js'))return route.fulfill({status:404,body:''});
   if(path==='/state'){
    stateReads++;const snapshot={generation:1,platform:'fixture',pair:'paired-'+stateReads,visits:[],earnedAccess:control.accessEnabled};
    if(holdAccess&&accessPending){captureState();await stateReleased;}
    return json(snapshot);
   }
   if(path==='/tracking/status')return json({client:{account:'invented',deviceId:'fixture',pending:0,awaitingHistory:0},historyStatus:'disabled'});
   if(path==='/auth/workos/status')return json({state:'idle'});
   if(path==='/earned/read'){reads++;return failRead?json({code:'EARNED_RESULT_UNKNOWN'},409):json(await control.local('read'));}
   if(path==='/earned/opt-in'){
    mutations++;const body=route.request().postDataJSON();
    try{return json(await control.local('opt-in',body));}
    catch(error){return json({code:error instanceof Error?error.message:'UNKNOWN'},409);}
   }
   if(path==='/earned/access'){
    if(holdAccess){accessPending=true;beginAccess();await commitAllowed;}
    const reply=await control.setAccess(route.request().postDataJSON().enabled);
    return drop?route.abort('failed'):json(reply);
   }
   return json({code:'FIXTURE_UNAVAILABLE'},404);
  });
  await page.goto('http://fixture.test/#fixture');
  await page.waitForFunction(()=>document.querySelector('#earned-balance')?.textContent?.includes('off'));
  drop=true;
  for(const enabled of [true,false]){
   if(!enabled){
    const op=study((await client.inspect()).deviceId,now);now+=45000;await client.enqueue(op);await client.sync();
    await reader.request('/corrections',{key:recordKey(op),evidenceRevision:1,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}});
    assert.equal((await client.earnedLeisure('read')).balance!.availableSeconds,45);
   }
   const before=reads;
   const readback=page.waitForResponse(response=>new URL(response.url()).pathname==='/earned/read');
   await page.locator('#earned-optin').setChecked(enabled);await page.locator('#earned-optin-apply').click();
   await readback;
   await page.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.includes('The action reply was unknown'));
   assert.ok(reads>before,'unknown mutation immediately reads authoritative balance');
   assert.equal(await page.locator('#earned-optin').isChecked(),enabled);
   assert.equal((await client.earnedLeisure('read')).enabled,enabled);
   if(!enabled)assert.match(await page.locator('#earned-balance').innerText(),/off/);
   if(!enabled)assert.equal((await client.earnedLeisure('read')).balance!.availableSeconds,0,'opt-out really drops the earned balance');
   assert.match(await page.locator('#earned-status').innerText(),/unknown/i);
   assert.doesNotMatch(await page.locator('#earned-status').innerText(),/Nothing was changed or spent/);
  }
  assert.equal(mutations,2,'no automatic mutation retry');
  failRead=true;
  await page.locator('#earned-optin').check();await page.locator('#earned-optin-apply').click();
  await page.waitForFunction(()=>document.querySelector('#earned-status')?.textContent?.includes('Current state is unavailable'));assert.match(await page.locator('#earned-status').innerText(),/unknown/i);failRead=false;
  await page.locator('#earned-access').check();await page.locator('#earned-access-apply').click();
  await page.waitForFunction(()=>!(document.querySelector('#earned-access-apply') as HTMLButtonElement).disabled);
  assert.equal(control.accessEnabled,true);
  await page.waitForFunction(()=>(document.querySelector('#earned-access') as HTMLInputElement).checked);
  control.revoke();await page.waitForFunction(()=>!(document.querySelector('#earned-access') as HTMLInputElement).checked);
  // A fresh authoritative state poll also discovers active access from false.
  await control.setAccess(true);
  await page.waitForFunction(()=>(document.querySelector('#earned-access') as HTMLInputElement).checked);
  control.revoke();await page.waitForFunction(()=>!(document.querySelector('#earned-access') as HTMLInputElement).checked);
  // Poll starts during the mutation and snapshots the PRE-COMMIT grant.
  // Deliver it only after the success reply has re-enabled the button.
  const delayedResults:{enabled:boolean;checked:boolean;status:string}[]=[];
  drop=false;
  for(const enabled of [true,false]){
   armAccessRace();holdAccess=true;accessPending=false;
   await page.locator('#earned-access').setChecked(enabled);await page.locator('#earned-access-apply').click();
   await accessStarted;assert.equal(await page.locator('#earned-access').isDisabled(),true,'pending action disables draft edits');await stateCaptured;
   assert.equal(control.accessEnabled,!enabled,'held poll really captured pre-commit access');
   allowCommit();
   await page.waitForFunction(()=>!(document.querySelector('#earned-access-apply') as HTMLButtonElement).disabled);
   assert.equal(control.accessEnabled,enabled,'real grant committed before stale poll delivery');
   assert.equal(await page.locator('#earned-access').isChecked(),enabled);
   const staleReply=page.waitForResponse(response=>new URL(response.url()).pathname==='/state');
   releaseState();const staleSnapshot=await (await staleReply).json() as {pair:string};
   await page.waitForFunction(pair=>document.querySelector('#pomodoro-pair')?.textContent===pair,staleSnapshot.pair);
   delayedResults.push({enabled,checked:await page.locator('#earned-access').isChecked(),status:await page.locator('#earned-status').innerText()});
   holdAccess=false;accessPending=false;const beforeIdle=stateReads;
   const idleSnapshot=await (await page.waitForResponse(response=>new URL(response.url()).pathname==='/state')).json() as {pair:string};
   await page.waitForFunction(pair=>document.querySelector('#pomodoro-pair')?.textContent===pair,idleSnapshot.pair);
   assert.ok(stateReads>beforeIdle,'next idle poll reads authoritative grant');
   assert.equal(await page.locator('#earned-access').isChecked(),enabled);
  }
  console.log('DELAYED_ACCESS_POLL_RESULTS',JSON.stringify(delayedResults));
  // Keep both-direction idle discovery and specific revoke proof after the races.
  await control.setAccess(true);await page.waitForFunction(()=>(document.querySelector('#earned-access') as HTMLInputElement).checked);
  control.revoke();await page.waitForFunction(()=>!(document.querySelector('#earned-access') as HTMLInputElement).checked);
  for(const result of delayedResults){
   assert.equal(result.checked,result.enabled,'poll started in-flight must not undo successful '+(result.enabled?'enable':'disable'));
   if(result.enabled)assert.doesNotMatch(result.status,/access ended/i);
  }
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('idle polls preserve unapplied access drafts and Apply submits the user choice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'earned-draft-'));
 const server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const client=new TrackingClient(server.origin,join(dir,'client'),randomBytes(32));
 const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
 try{
  await client.signin('invented-draft','invented-password-123','Invented device',true);
  const control=new EarnedControl(()=>'fixture-profile',()=>client);
  const page=await browser.newPage();let stateRevision=0,delayAccessReply=false;
  let markAccessCommit=()=>{},releaseAccessReply=()=>{},markRetirement=()=>{},allowRetirement=()=>{};
  const accessCommitted=new Promise<void>(resolve=>{markAccessCommit=resolve;});
  const accessReplyReleased=new Promise<void>(resolve=>{releaseAccessReply=resolve;});
  const retirementStarted=new Promise<void>(resolve=>{markRetirement=resolve;});
  const retirementAllowed=new Promise<void>(resolve=>{allowRetirement=resolve;});
  await page.route('http://draft.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:await readFile(new URL('../../core/preview/index.html',import.meta.url),'utf8')});
   if(path==='/ui.js')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../core/preview/ui.js',import.meta.url),'utf8')});
   if(path==='/pomodoro/desktop-ui.js')return route.fulfill({contentType:'text/javascript',body:'export function mountDesktopPomodoro(){return {client:{},dispose(){}}}'});
   if(path.endsWith('.js'))return route.fulfill({status:404,body:''});
   if(path==='/state')return json({generation:1,platform:'fixture',pair:'poll-'+(++stateRevision),visits:[],earnedAccess:control.accessEnabled});
   if(path==='/tracking/status')return json({client:{account:'invented',deviceId:'fixture',pending:0,awaitingHistory:0},historyStatus:'disabled'});
   if(path==='/auth/workos/status')return json({state:'idle'});
   if(path==='/earned/read')return json(await control.local('read'));
   if(path==='/earned/access'){
    const result=await control.setAccess(route.request().postDataJSON().enabled);
    if(delayAccessReply){markAccessCommit();await accessReplyReleased;}
    return json(result);
   }
   if(path==='/chrome/replace-pairing'){
    markRetirement();await retirementAllowed;control.revoke();return json({});
   }
   return json({code:'FIXTURE_UNAVAILABLE'},404);
  });
  await page.goto('http://draft.test/#fixture');
  await page.waitForFunction(()=>document.querySelector('#earned-balance')?.textContent?.includes('off'));
  const idlePoll=async()=>{
   const response=await page.waitForResponse(response=>new URL(response.url()).pathname==='/state');
   const snapshot=await response.json() as {pair:string};
   // The production poll paints this marker in the same response turn as access.
   await page.waitForFunction(pair=>document.querySelector('#pomodoro-pair')?.textContent===pair,snapshot.pair);
  };
  const results:{desired:boolean;draftAfterPoll:boolean;authorityBeforeApply:boolean;submitted:boolean;authorityAfterApply:boolean;statusBeforeApply:string}[]=[];
  for(const desired of [false,true]){
   await control.setAccess(!desired);await idlePoll();
   assert.equal(await page.locator('#earned-access').isChecked(),!desired,'clean checkbox starts at actual grant');
   await page.locator('#earned-access').setChecked(desired);
   await idlePoll();
   const draftAfterPoll=await page.locator('#earned-access').isChecked(),authorityBeforeApply=control.accessEnabled,statusBeforeApply=await page.locator('#earned-status').innerText();
   const sent=page.waitForRequest(request=>new URL(request.url()).pathname==='/earned/access');
   await page.locator('#earned-access-apply').click();const request=await sent;
   await page.waitForFunction(()=>!(document.querySelector('#earned-access-apply') as HTMLButtonElement).disabled);
   results.push({desired,draftAfterPoll,authorityBeforeApply,submitted:request.postDataJSON().enabled,authorityAfterApply:control.accessEnabled,statusBeforeApply});
  }
  console.log('UNAPPLIED_ACCESS_DRAFT_RESULTS',JSON.stringify(results));
  // A known page-initiated retirement invalidates prior-context replies, while
  // its request start must not claim the still-active grant has been revoked.
  await control.setAccess(false);await idlePoll();
  delayAccessReply=true;await page.locator('#earned-access').check();await page.locator('#earned-access-apply').click();
  await accessCommitted;assert.equal(control.accessEnabled,true);
  const retired=page.waitForResponse(response=>new URL(response.url()).pathname==='/chrome/replace-pairing');
  void retired.catch(()=>{}); // Cleanup must retain the primary assertion on a RED run.
  await page.locator('#chrome-replace-pairing').click();await retirementStarted;
  assert.equal(control.accessEnabled,true,'retirement has not committed yet');
  assert.match(await page.locator('#earned-status').innerText(),/unknown/i,'pending retirement must not claim revoked access');
  assert.doesNotMatch(await page.locator('#earned-status').innerText(),/access is off|access ended/i);
  allowRetirement();await retired;releaseAccessReply();
  await page.waitForFunction(()=>!(document.querySelector('#earned-access-apply') as HTMLButtonElement).disabled);
  assert.equal(control.accessEnabled,false);
  assert.equal(await page.locator('#earned-access').isChecked(),false,'late successful prior-context reply must not resurrect the retired draft');
  await idlePoll();assert.equal(await page.locator('#earned-access').isChecked(),false);

  for(const result of results){
   assert.equal(result.authorityBeforeApply,!result.desired,'editing never mutates the grant');
   assert.equal(result.draftAfterPoll,result.desired,'idle poll must preserve the unsubmitted user draft');
   assert.equal(result.submitted,result.desired,'Apply must submit the user choice');
   assert.equal(result.authorityAfterApply,result.desired,'actual grant follows the explicit Apply');
   if(result.authorityBeforeApply)assert.doesNotMatch(result.statusBeforeApply,/access ended|access is off/i,'unapplied revoke must not claim authority ended');
  }
 }finally{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
