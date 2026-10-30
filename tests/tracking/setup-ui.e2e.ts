// Production renderer in Chromium, with simulated desktop control responses.
// UI replay ONLY, not native setup/key/permission or HTTP account acceptance.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {pomodoroAsset} from '../../core/pomodoro/assets.js';
const output='.local/cross-device-sync/setup-ui';await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
let setup:unknown=null,start:Record<string,unknown>|undefined,signin:Record<string,unknown>|undefined,deny=false;
const latestStart=()=>start;
try{
 await page.route('http://spindle-preview.test/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/'||path==='/ui.js'){await route.fulfill({contentType:path==='/'?'text/html':'text/javascript',body:await readFile('build/core/preview/'+(path==='/'?'index.html':'ui.js'),'utf8')});return;}
  if(path.startsWith('/pomodoro/')){const asset=await pomodoroAsset(path.replace('/pomodoro/','/pomodoro/app/'));await route.fulfill(asset?{contentType:asset.type,body:asset.body}:{status:401,json:{code:'SIGNIN_REQUIRED'}});return;}
  if(path==='/state'){await route.fulfill({json:{generation:1,platform:'synthetic',recording:false,provider:'simulated',lastCode:'UI_REPLAY',settingsReady:true,timerOrigin:setup?'https://shared.example':null,pair:'simulated-pairing-not-a-credential',visits:[]}});return;}
  if(path==='/tracking/status'){await route.fulfill({json:{setup,historyStatus:'disabled',client:setup?{account:'invented-ui',deviceName:'Invented Mac',deviceId:'simulated-device',pending:2,awaitingHistory:0,lastSync:null,error:'SYNC_FAILED'}:null}});return;}
  if(path==='/tracking/signin'){
   signin=request.postDataJSON() as Record<string,unknown>;
   if(deny){await route.fulfill({status:409,json:{code:'ACCOUNT_SWITCH_REQUIRES_NEW_STORE'}});return;}
   setup={origin:signin.origin,name:signin.name,deviceName:signin.deviceName};
  }
  if(path==='/tracking/devices'){await route.fulfill({json:{devices:[{id:'simulated-device',name:'Invented Mac',lastUploadAt:null}]}});return;}
  if(path==='/start')start=request.postDataJSON() as Record<string,unknown>;
  await route.fulfill({json:{ok:true}});
 });
 await page.goto('http://spindle-preview.test/#simulated-local-control');await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Paused'));
 assert.equal(await page.locator('#tracking-upload').isChecked(),false);
 await page.locator('#tracking-origin').fill('https://shared.example');await page.locator('#tracking-name').fill('invented-ui');await page.locator('#tracking-device').fill('Invented Mac');await page.locator('#tracking-password').fill('invented-only-password');await page.locator('#tracking-signin').click();
 await page.waitForFunction(()=>document.getElementById('tracking-message')?.textContent?.startsWith('Connected'));
 assert.equal(await page.locator('#tracking-password').inputValue(),'');assert.equal(signin?.password,'invented-only-password');assert.equal(await page.locator('#tracking-upload').isChecked(),false);assert.equal(latestStart(),undefined);
 await page.reload();await page.waitForFunction(()=>(document.getElementById('tracking-origin') as HTMLInputElement)?.value==='https://shared.example');
 assert.equal(await page.locator('#pomodoro-origin').inputValue(),'https://shared.example');assert.match(await page.locator('#tracking-status').innerText(),/2 pending.*never.*SYNC_FAILED/);
 await page.locator('#tracking-devices').click();await page.waitForFunction(()=>document.getElementById('tracking-device-list')?.textContent?.includes('remote pending/error unknown'));
 await page.locator('#start').click();await page.waitForTimeout(100);assert.equal(latestStart()?.upload,false);
 await page.locator('#tracking-upload').check();await page.locator('#retain').check();await page.locator('#start').click();await page.waitForTimeout(100);assert.equal(latestStart()?.upload,true);assert.equal(latestStart()?.retentionMs,86400000);
 deny=true;await page.locator('#tracking-name').fill('invented-other');await page.locator('#tracking-password').fill('invented-only-password');await page.locator('#tracking-signin').click();await page.waitForFunction(()=>document.getElementById('tracking-message')?.textContent?.includes('ACCOUNT_SWITCH_REQUIRES_NEW_STORE'));await page.waitForTimeout(900);
 assert.match(await page.locator('#tracking-message').innerText(),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);assert.equal(await page.locator('#tracking-password').inputValue(),'');
 await page.locator('#tracking-upload').uncheck();await page.locator('#retain').uncheck();await page.locator('#tracking-name').fill('invented-ui');await page.screenshot({path:output+'/setup-ui-replay.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS Chromium production setup renderer: explicit signin, password cleared, origin restored, pending/error/remote unknown state, no auto recording/upload, explicit upload body and visible account-change refusal. Simulated control responses; UI replay only.');
}finally{await browser.close();}
