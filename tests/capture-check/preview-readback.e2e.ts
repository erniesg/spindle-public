// Synthetic owner + real Chromium/production renderer. No native capture claim.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PreviewSession } from '../../core/preview/session.js';
import {pomodoroAsset} from '../../core/pomodoro/assets.js';
const html=await readFile('build/core/preview/index.html','utf8');
const script=await readFile(process.env.SPINDLE_PREVIEW_TEST_UI??'build/core/preview/ui.js','utf8');
async function asset(path:string){
 if(path==='/')return {contentType:'text/html',body:html};
 if(path==='/ui.js')return {contentType:'text/javascript',body:script};
 if(path.startsWith('/pomodoro/')){const value=await pomodoroAsset(path.replace('/pomodoro/','/pomodoro/app/'));if(value)return {contentType:value.type,body:value.body};}
 return undefined;
}
const browser=await chromium.launch({headless:true,...(process.env.SPINDLE_CHROMIUM_EXECUTABLE?{executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE}:{})});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII=';
try{
 for(const scenario of ['clear-inflight','revoke-rendered','revoke-inflight','focus-rendered','focus-inflight','pause-current-restore'] as const){
  const page=await browser.newPage();const session=new PreviewSession();
  session.start({pixels:true,rich:true,retain:true});
  session.focus({epoch:session.epoch,revision:1,at:0,key:'chrome',app:'com.google.Chrome',title:'',clock:'synthetic',browser:true});
  const context={challenge:session.challenge(),private:false,focused:true,document:'invented-doc',url:'https://invented.example',title:'Invented saved browser',text:'REVOKED_CONTEXT_MUST_NOT_RETURN'};
  assert.equal(session.browser(context),true);assert.equal(session.browserImage({...context,challenge:session.challenge(),gesture:true,image:png},session.lastAt),true);
  if(scenario.startsWith('focus-')){
   for(const at of [100,200]){const c={...context,challenge:session.challenge(),document:'doc-'+at,url:'https://invented.example/'+at};assert.equal(session.browser(c,at),true);assert.equal(session.browserImage({...c,challenge:session.challenge(),gesture:true,image:png},at),true);}
  }
  const saved=session.snapshot();
  let release!:()=>void,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  await page.route('http://spindle-preview.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const file=await asset(path);if(file){await route.fulfill(file);return;}
   if(path.startsWith('/pomodoro/')){await route.fulfill({status:401,json:{code:'SIGNIN_REQUIRED'}});return;}
   if(path==='/state'){if(scenario==='pause-current-restore'&&!session.recording)await entered;await route.fulfill({json:{...session.snapshot(),platform:'synthetic',provider:'synthetic-test',lastCode:'TEST',pair:'not-a-real-code'}});return;}
   if(path==='/restore'){
    const responseGeneration=session.generation;
    started();if(!scenario.endsWith('-rendered'))await new Promise<void>(resolve=>{release=resolve;});
    // A previously authorized response may already be in transit when revoke occurs.
    await route.fulfill({json:{saved,generation:responseGeneration}});return;
   }
   if(path==='/clear')session.clear();
   if(path==='/pause')session.pause(1);
   await route.fulfill({json:{ok:true}});
  });
  await page.goto('http://spindle-preview.test/#synthetic-token');
  await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Recording'));
  if(scenario==='pause-current-restore')await page.locator('#pause').click();
  await page.locator('#restore').click();await entered;
  if(scenario==='pause-current-restore'){
   await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Paused'));
   release();await page.waitForTimeout(300);
   assert.equal(await page.locator('#saved img').count(),1,'current-owner Restore after Pause must survive intervening poll');
   await page.close();continue;
  }
  if(scenario.endsWith('-rendered')){
   const target=scenario==='focus-rendered'?saved.visits.find(v=>v.start===100)!:saved.visits[0]!;
   const article=page.locator('#saved article').filter({hasText:target.id.slice(0,8)});await article.locator('img').waitFor();
   assert.equal(await article.locator('img').getAttribute('src'),'data:image/png;base64,'+target.image);
   assert.equal(await page.locator('#saved img').count(),saved.visits.filter(v=>v.image).length);
   assert.match(await article.innerText(),/REVOKED_CONTEXT/);
   if(scenario==='focus-rendered')session.focus({epoch:session.epoch,revision:2,at:50,key:null,app:'',title:'',clock:'synthetic',browser:false});else session.revokeBrowser();
  }else if(scenario==='clear-inflight'){
   await page.locator('#clear').click();release();
  }else{
   if(scenario==='focus-inflight')session.focus({epoch:session.epoch,revision:2,at:50,key:null,app:'',title:'',clock:'synthetic',browser:false});else session.revokeBrowser();
   await page.waitForTimeout(1000); // Observe owner revision before the old response arrives.
   release();
  }
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#saved img').count(),0,scenario+' must discard saved pixels');
  assert.ok(!(await page.locator('#saved').textContent())?.includes('REVOKED_CONTEXT'),scenario+' must discard saved text');
  await page.close();
 }
 for(const quit of ['pomodoro-quit','quit']){
  const page=await browser.newPage(),owner=new PreviewSession();owner.start({pixels:true,rich:true,retain:true});
  owner.focus({epoch:owner.epoch,revision:1,at:0,key:'window',app:'invented',title:'Invented quit readback',clock:'synthetic'});
  owner.sample({epoch:owner.epoch,revision:1,at:1,title:'Invented quit readback',text:'QUIT_CONTEXT_MUST_NOT_REMAIN',image:png,status:'synthetic'});
  const snapshot=owner.snapshot();let hold=false,release:()=>void=()=>{},started:()=>void=()=>{};
  const entered=new Promise<void>(resolve=>{started=resolve;});
  await page.route('http://spindle-preview.test/**',async route=>{
   const path=new URL(route.request().url()).pathname,file=await asset(path);if(file){await route.fulfill(file);return;}
   if(path.startsWith('/pomodoro/')){await route.fulfill({status:401,json:{code:'SIGNIN_REQUIRED'}});return;}
   if(path==='/state'){if(hold){started();await new Promise<void>(resolve=>{release=resolve;});}await route.fulfill({json:{...snapshot,platform:'synthetic',provider:'synthetic-test',lastCode:'TEST',pair:'synthetic'}});return;}
   await route.fulfill({json:path==='/restore'?{saved:snapshot,generation:owner.generation}:{ok:true}});
  });
  await page.goto('http://spindle-preview.test/#synthetic');await page.locator('#visits img').waitFor();await page.locator('#restore').click();await page.locator('#saved img').waitFor();
  await page.locator('#correction-dialog').evaluate(dialog=>(dialog as HTMLDialogElement).show());
  hold=true;await entered;await page.locator('#'+quit).click();await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Stopped')||document.getElementById('pomodoro-access-status')?.textContent?.includes('closed'));
  assert.equal(await page.locator('#visits img').count(),0,quit+' clears visible capture');assert.equal(await page.locator('#saved img').count(),0,quit+' clears retained readback');assert.equal(await page.locator('#correction-dialog').evaluate(dialog=>(dialog as HTMLDialogElement).open),false,quit+' closes correction');assert.equal(await page.locator('#pomodoro').evaluate(root=>root.childElementCount),0,quit+' disposes timer');
  release();await page.waitForTimeout(300);assert.equal(await page.locator('#visits img').count(),0,quit+' rejects late poll after shutdown');assert.ok(!(await page.locator('body').innerText()).includes('QUIT_CONTEXT_MUST_NOT_REMAIN'));await page.close();
 }
 const page=await browser.newPage(),native=new PreviewSession();native.start({pixels:true,rich:true,retain:true});
 native.focus({epoch:native.epoch,revision:1,at:0,key:'window',app:'photos',title:'Photos',clock:'synthetic'});
 native.sample({epoch:native.epoch,revision:1,at:10,title:'Invented loaded image',image:png,status:'ocr-language-unavailable',capture:{pixels:'captured',ocr:'ocr-language-unavailable',image:'image-retained-reduced',sourceWidth:3840,sourceHeight:2160,imageWidth:1920,imageHeight:1080,ocrWidth:2666,ocrHeight:1500}});
 await page.route('http://spindle-preview.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const file=await asset(path);if(file){await route.fulfill(file);return;}
  if(path.startsWith('/pomodoro/')){await route.fulfill({status:401,json:{code:'SIGNIN_REQUIRED'}});return;}
  await route.fulfill({json:{...native.snapshot(),platform:'synthetic',provider:'synthetic-test',lastCode:'TEST',pair:'synthetic'}});
 });
 await page.goto('http://spindle-preview.test/#synthetic');
 await page.locator('#visits h2').filter({hasText:'Invented loaded image'}).waitFor();
 assert.match(await page.locator('#visits').innerText(),/OCR: ocr language unavailable/);
 assert.match(await page.locator('#visits').innerText(),/Screenshot reduced to 1920×1080 from 3840×2160/);
 assert.equal(await page.locator('#visits img').count(),1,'OCR failure must still render the retained image');await page.close();
 console.log('PASS production inspector: Clear/revoke/restore and delayed-native-focus Saved-copy plus both Quit/late-poll fences, refreshed titles, independent OCR failures and disclosed screenshot reduction. Synthetic owner, not native proof.');
}finally{await browser.close();}
