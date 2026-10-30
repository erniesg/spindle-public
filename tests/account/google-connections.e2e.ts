// Actual shared AccountClient in Chromium + Node, real encrypted backend, mocked Google HTTP only.
// No consent entry, external navigation, native capture, personal data or provider calls.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const output=resolve(process.env.SPINDLE_GOOGLE_REVIEW_OUTPUT??'.local/shared-google/browser');await mkdir(output,{recursive:true});
const executablePath=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executablePath)throw Error('Select cached Chromium explicitly');
const key=randomBytes(32),password='invented-password-123';let identity='invented-personal@example.test',partial=false,folderMetadataCalls=0,failureMode='ok';
const trace:{operation:string;status:number;code?:string;fixture?:string}[]=[],telemetry:unknown[]=[];
const http:typeof fetch=async input=>{
 const u=new URL(String(input));
 if(u.pathname==='/token'){
  if(failureMode==='network')throw Error('INVENTED_PRIVATE_PROVIDER_SENTINEL');
  if(failureMode==='token400')return new Response('INVENTED_PRIVATE_PROVIDER_SENTINEL',{status:400});
  return Response.json({access_token:'INVENTED_ACCESS_SENTINEL',...(failureMode==='refreshMissing'?{}:{refresh_token:'INVENTED_REFRESH_SENTINEL'}),scope:failureMode==='driveOnly'?scopes.drive:[scopes.mail,...(partial?[]:[scopes.drive])].join(' ')});
 }
 if(u.pathname==='/revoke')return new Response('',{status:503});
 if(u.pathname.endsWith('/profile'))return failureMode==='profile403'?new Response('INVENTED_PRIVATE_PROVIDER_SENTINEL',{status:403}):Response.json({emailAddress:identity});
 if(u.pathname==='/drive/v3/files/invented-selected-folder'){folderMetadataCalls++;assert.deepEqual(u.searchParams.get('fields')?.split(',').sort(),['id','mimeType','name','trashed','version'].sort());return Response.json({id:'invented-selected-folder',mimeType:'application/vnd.google-apps.folder',version:'v1',trashed:false});}
 throw Error('Unexpected mocked HTTP: no child lists or document contents allowed');
};
const app=await startTrackingServer(join(output,'store'),key,0,undefined,{clientId:'invented-web-client',clientSecret:'INVENTED_WEB_SECRET_SENTINEL',http,telemetry:event=>telemetry.push(event)});
const desktop=new AccountClient(app.origin);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1100,height:1000},recordVideo:{dir:join(output,'video'),size:{width:1100,height:1000}}});
const errors:string[]=[];
try{
 // Invented auth via API before a page exists: recording never includes credential entry.
 const auth=await context.request.post(app.origin+'/register',{headers:{Origin:app.origin},data:{name:'invented-owner',password}});assert.equal(auth.status(),200);
 await desktop.signin('invented-owner',password);
 await context.route('**/*',route=>new URL(route.request().url()).origin===app.origin?route.continue():route.abort());
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('p');banner.textContent='SIMULATED GOOGLE · invented responses/identity · actual encrypted backend + Chromium · no owner consent';banner.style.cssText='background:#fff3ce;padding:12px;border:1px solid #8a6300;font:16px system-ui';document.body.prepend(banner);}));
 context.on('response',response=>{const path=new URL(response.url()).pathname;const operation:Record<string,string>={'/google/begin':'begin','/google/list':'status','/google/disconnect':'disconnect'};if(operation[path])trace.push({operation:operation[path],status:response.status()});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(app.origin+'/connections');await page.getByText('Signed in as invented-owner').waitFor();
 const complete=async(authorizationUrl:string)=>{const u=new URL(authorizationUrl),callback=new URL(u.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:u.searchParams.get('state')!,code:'invented-code'}).toString();const result=await context.request.get(callback.href);assert.equal(result.status(),200);assert.ok(!(await result.text()).includes('SENTINEL'));assert.notEqual((await context.request.get(callback.href)).status(),200);};
 const link=page.getByRole('link',{name:'Continue to Google (opens a new tab)'});
 const ready=()=>page.waitForFunction(()=>!document.getElementById('refresh')?.hasAttribute('disabled'));
 const openHistory=async()=>{const history=page.locator('#attempt-history');if(await history.count()&&!await history.getAttribute('open'))await history.locator('summary').click();};
 const callbackUrl=async(denied=false)=>{const auth=new URL((await link.getAttribute('href'))!),url=new URL(auth.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:auth.searchParams.get('state')!,...(denied?{error:'access_denied',error_description:'INVENTED_PRIVATE_PROVIDER_SENTINEL'}:{code:'invented-code'})}).toString();return url;};
 // Browser callback navigations no longer render a page: 303 straight back into the app with a fixed outcome only.
 const returned=async(href:string,outcome:'connected'|'failed')=>{const response=await page.goto(href),first=response?.request().redirectedFrom();assert.equal(first&&new URL(first.url()).pathname,'/oauth/callback');assert.equal((await first!.response())?.status(),303);assert.equal(page.url(),app.origin+'/portal#connections/'+outcome);assert.equal(response?.status(),200);assert.ok(!(await page.content()).includes('SENTINEL'));};
 await ready();await page.evaluate(()=>{const b=document.getElementById('connect')!;b.click();b.click();});await link.waitFor();await ready();
 const pendingHref=await link.getAttribute('href');await page.getByRole('button',{name:'Refresh status'}).click();await ready();assert.equal(await link.getAttribute('href'),pendingHref);assert.equal((await desktop.googleConnections()).connections.length,1);assert.equal(trace.filter(t=>t.operation==='begin').length,1);
 const pendingId=(await desktop.googleConnections()).connections[0].id;
 for(const [mode,code,status] of [['denied','GOOGLE_CONSENT_DENIED',400],['driveOnly','GOOGLE_IDENTITY_GRANT_REQUIRED',403],['profile403','GOOGLE_PROFILE_DENIED',403],['token400','GOOGLE_TOKEN_REJECTED',400],['network','GOOGLE_NETWORK_UNAVAILABLE',502],['refreshMissing','GOOGLE_REFRESH_CREDENTIAL_REQUIRED',400]] as const){
  failureMode=mode;if(mode!=='denied'){await openHistory();await page.locator('article').getByRole('button',{name:'Reconnect',exact:true}).click();await link.waitFor();await ready();}
  const callback=await callbackUrl(mode==='denied');await returned(callback.href,'failed');trace.push({operation:'callback',code,status,fixture:mode});const attempt=(await desktop.googleConnections()).connections[0].lastAttempt as any;assert.equal(attempt?.code,code);assert.equal(attempt?.httpStatus,status);await page.waitForTimeout(1100);await page.screenshot({path:join(output,mode+'-callback.png'),fullPage:true});
  const replay=await context.request.get(callback.href);assert.equal(replay.status(),409);trace.push({operation:'callback',status:409,code:'GOOGLE_FLOW_EXPIRED_OR_USED',fixture:'replay'});
  await page.goto(app.origin+'/connections');await ready();await page.getByText('Not connected attempts are saved in collapsed Attempt history.',{exact:false}).waitFor();assert.equal((await desktop.googleConnections()).connections[0].id,pendingId);assert.equal(await page.locator('article').count(),1);await page.getByRole('button',{name:'Refresh status'}).click();await ready();await openHistory();assert.ok((await page.locator('article').innerText()).includes(code));
  await page.reload();await ready();await openHistory();assert.ok((await page.locator('article').innerText()).includes(code));await page.waitForTimeout(1100);await page.screenshot({path:join(output,mode+'-recovery.png'),fullPage:true});
 }
 // Expiry/used recovery is a local clock fixture, never a provider call or real-flow replay.
 failureMode='ok';await page.locator('article').getByRole('button',{name:'Reconnect',exact:true}).click();await link.waitFor();await ready();const expired=await callbackUrl(),now=Date.now;
 try{Date.now=()=>now()+300001;await returned(expired.href,'failed');trace.push({operation:'callback',status:409,code:'GOOGLE_FLOW_EXPIRED_OR_USED',fixture:'expiry'});}finally{Date.now=now;}
 await page.goto(app.origin+'/connections');await ready();await page.reload();await ready();await openHistory();assert.ok((await page.locator('article').innerText()).includes('GOOGLE_FLOW_EXPIRED_OR_USED'));await page.screenshot({path:join(output,'expired-recovery.png'),fullPage:true});
 await page.locator('article').getByRole('button',{name:'Disconnect',exact:true}).click();await ready();assert.equal((await desktop.googleConnections()).connections[0].status,'disconnected');await page.screenshot({path:join(output,'pending-disconnected.png'),fullPage:true});
 await openHistory();await page.locator('article').getByRole('button',{name:'Reconnect',exact:true}).click();await link.waitFor();await ready();await returned((await callbackUrl()).href,'connected');trace.push({operation:'callback',status:200,code:'GOOGLE_CONNECTED',fixture:'verified-invented-identity'});await page.waitForTimeout(1100);await page.screenshot({path:join(output,'mock-success-callback.png'),fullPage:true});await page.goto(app.origin+'/connections');await ready();
 await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('heading',{name:'invented-personal@example.test'}).waitFor();assert.equal((await desktop.googleConnections()).connections[0].accountId,identity);
 await page.waitForTimeout(2200);
 identity='invented-work@example.test';partial=true;const second=await desktop.connectGoogle();await complete(second.authorizationUrl);await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('heading',{name:identity}).waitFor();assert.equal(await page.locator('article').count(),2);await page.waitForTimeout(2200);
 await page.screenshot({path:join(output,'multiple-accounts-partial-grant.png'),fullPage:true});
 const first=page.locator('article').filter({hasText:'invented-personal@example.test'});await first.getByRole('textbox').fill('invented-selected-folder');await first.getByRole('button',{name:'Save selected folders'}).click();await page.getByText('Selected folders saved. No files were read.').waitFor();assert.deepEqual((await desktop.googleConnections()).connections.find(c=>c.accountId==='invented-personal@example.test')?.roots,['invented-selected-folder']);await page.waitForTimeout(2200);
 partial=false;await first.getByRole('button',{name:'Check saved folder access (metadata only)'}).click();await page.getByText('Access confirmed for 1 selected folder(s). No child files or document contents were read.').waitFor();assert.equal(folderMetadataCalls,1);await page.screenshot({path:join(output,'folder-metadata-only.png'),fullPage:true});
 // Failed reconnect retains the previously verified identity/credential, separately from attempt failure.
 failureMode='profile403';const working=page.locator('article').filter({hasText:'invented-personal@example.test'});await working.getByRole('button',{name:'Reconnect',exact:true}).click();await link.waitFor();await ready();const failedReconnect=await context.request.get((await callbackUrl()).href);assert.equal(failedReconnect.status(),403);trace.push({operation:'callback',status:403,code:'GOOGLE_PROFILE_DENIED',fixture:'working-reconnect'});await page.getByRole('button',{name:'Refresh status'}).click();await ready();assert.equal((await desktop.googleConnections()).connections[0].status,'connected');await page.getByText('Previous verified connection is still active.',{exact:false}).waitFor();await page.screenshot({path:join(output,'working-connection-failed-reconnect.png'),fullPage:true});failureMode='ok';
 // Reconnect from browser uses the same engine and identity, without a separate identity client.
 partial=false;const secondCard=page.locator('article').filter({hasText:'invented-work@example.test'});await secondCard.getByRole('button',{name:'Reconnect',exact:true}).click();await link.waitFor();await complete((await link.getAttribute('href'))!);await page.getByRole('button',{name:'Refresh status'}).click();await page.waitForFunction(()=>[...document.querySelectorAll('article')].every(a=>!a.textContent?.includes('Missing grants')));await page.waitForTimeout(2200);
 const other=await browser.newContext();try{const auth=await other.request.post(app.origin+'/register',{headers:{Origin:app.origin},data:{name:'invented-other',password}}),csrf=(await auth.json()).csrf;const listed=await other.request.post(app.origin+'/google/list',{headers:{Origin:app.origin,'X-CSRF-Token':csrf},data:{}});assert.deepEqual((await listed.json()).connections,[]);const denied=await other.request.post(app.origin+'/google/disconnect',{headers:{Origin:app.origin,'X-CSRF-Token':csrf},data:{connectionId:second.connectionId}});assert.equal(denied.status(),404);}finally{await other.close();}
 await first.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText('Local access stopped. Provider revocation: uncertain.').waitFor();await page.waitForTimeout(2200);assert.equal((await desktop.googleConnections()).connections.find(c=>c.accountId==='invented-personal@example.test')?.status,'disconnected');
 await page.screenshot({path:join(output,'disconnect-uncertain.png'),fullPage:true});await page.reload();await page.getByText('Signed in as invented-owner').waitFor();assert.equal(await page.locator('article').count(),2);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1800);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(output,'connections-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1100,height:1000});await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Sign in to Spindle',exact:true}).waitFor();await page.waitForTimeout(1800);assert.deepEqual(errors,[]);
 assert.ok(!JSON.stringify([trace,telemetry]).includes('SENTINEL'));assert.ok(!JSON.stringify(telemetry).includes('@'));
 await writeFile(join(output,'sanitized-trace.json'),JSON.stringify({proof:'Fixture Google responses only; actual browser/HTTP/encrypted backend. No earlier owner cause is reconstructed.',requests:trace,boundaries:telemetry},null,2));
 await writeFile(join(output,'journey.json'),JSON.stringify({failureRecovery:true,denied:true,driveOnlyIdentityDenied:true,profile403:true,token400:true,network:true,refreshMissing:true,expiry:true,replay:true,refreshPreservesFailure:true,continueLinkPreserved:true,repeatedBeginSingleRow:true,failedReconnectRetainsAuthority:true,pendingDisconnect:true,proof:'actual Chromium web UI and actual Node AccountClient API seam; mocked Google HTTP; no installed desktop/live Google claim',chromium:browser.version(),webToNode:true,nodeToWeb:true,multipleIdentities:true,partialGrant:true,rootSelection:true,folderMetadataOnly:true,folderMetadataCalls,reconnect:true,disconnectUncertain:true,cookieOwnerIsolation:true,reload:true,mobile390:true,noExternalBrowserRequests:true,pageErrors:errors},null,2));
}finally{await context.close();await browser.close();await app.close();key.fill(0);await rm(join(output,'store'),{recursive:true,force:true});}
console.log('PASS actual browser/shared AccountClient Google connections journey (mocked Google; Node is not installed desktop)');
