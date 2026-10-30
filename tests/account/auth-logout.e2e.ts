// Actual Chromium AccountClient + HttpOnly cookies + encrypted backend. Invented API auth only.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
const output=resolve(process.env.SPINDLE_AUTH_REVIEW_OUTPUT??'.local/auth-repair/browser');await mkdir(output,{recursive:true});
const executablePath=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executablePath)throw Error('Select cached Chromium explicitly');
const key=randomBytes(32),dir=await mkdtemp(join(output,'store-'));
let providerCalls=0;
const server=await startTrackingServer(dir,key,0,undefined,{clientId:'invented',clientSecret:'invented',http:async()=>{providerCalls++;throw Error('No provider HTTP allowed');}});
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const records:unknown[]=[];
try{
 for(const stage of ['/logout','/session']){
  const label=stage.slice(1),context=await browser.newContext({viewport:{width:1100,height:800},recordVideo:{dir:join(output,'video'),size:{width:1100,height:800}}});
  try{
   const auth=await context.request.post(server.origin+'/register',{headers:{Origin:server.origin},data:{name:'invented-a-'+label,password:'invented-password-123'}});assert.equal(auth.status(),200);
   await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
   const page=await context.newPage();await page.goto(server.origin+'/connections');await page.getByText('Signed in as invented-a-'+label).waitFor();
   await page.waitForTimeout(1000);
   await page.evaluate(async({stage,label})=>{
    const modulePath='/connections-client.js';const {AccountClient}=await import(modulePath);
    const w=window as any;w.authArrived=false;w.authHold=false;w.authRequests=[];
    const transport:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;w.authRequests.push(path);const response=await fetch(input,init);if(w.authHold&&path===stage){w.authHold=false;w.authArrived=true;await new Promise<void>(r=>w.authRelease=r);}return response;};
    const client=new AccountClient(location.origin,transport,true);await client.restore();w.authClient=client;
    w.authHold=true;w.authSigning=client.signin('invented-b-'+label,'invented-password-123',true).then(()=>null,(e:Error)=>e.message);
   },{stage,label});
   await page.waitForFunction(()=>(window as any).authArrived);
   await page.evaluate(()=>{const w=window as any;w.authLogout=w.authClient.signout();});
   const result=await page.evaluate(async()=>{const w=window as any;w.authRelease();await w.authLogout;return {signinError:await w.authSigning,localAccount:w.authClient.account??null,requests:w.authRequests};});
   // A cookie can be installed before delivery of the /session response. Check actual browser authority.
   const session=await context.request.post(server.origin+'/session',{headers:{Origin:server.origin},data:{}});
   const google=await context.request.post(server.origin+'/google/list',{headers:{Origin:server.origin,'X-CSRF-Token':'0'.repeat(64)},data:{}});
   await page.reload();const restored=await page.getByText('Signed in as invented-b-'+label).count();
   const record={stage,...result,sessionStatus:session.status(),googleStatus:google.status(),restoredAfterReload:restored>0,providerCalls,chromium:browser.version()};records.push(record);
   await writeFile(join(output,'results.json'),JSON.stringify(records,null,2));
   await page.screenshot({path:join(output,label+'-after-reload.png'),fullPage:true});await page.waitForTimeout(1200);
   assert.equal(result.localAccount,null);assert.ok(result.signinError,'cancelled signin must reject');assert.equal(session.status(),401);assert.equal(google.status(),401);assert.equal(restored,0);assert.equal(providerCalls,0);
   await page.getByRole('heading',{name:'Sign in to Spindle',exact:true}).waitFor();
  }finally{await context.close();}
 }
 console.log('PASS both actual Chromium logout windows, API denial and reload; invented data, no Google HTTP');
}finally{await browser.close();await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
