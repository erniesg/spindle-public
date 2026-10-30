import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';

// Actual Chromium + ordinary account UI/HTTP/encrypted store. Google alone is invented.
const executable=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executable)throw Error('SPINDLE_REVIEW_CHROMIUM required; no download');
const output=resolve(process.env.SPINDLE_GOOGLE_REVIEW_OUTPUT!);await mkdir(output,{recursive:false});
const directory=await mkdtemp(join(tmpdir(),'compose-ui-')),key=Buffer.alloc(32,63),compose='https://www.googleapis.com/auth/gmail.compose',driveFile='https://www.googleapis.com/auth/drive.file',fullDrive='https://www.googleapis.com/auth/drive';
let grants=[scopes.mail,scopes.drive,driveFile];const calls:string[]=[],requests:{path:string;body?:Record<string,unknown>}[]=[],errors:string[]=[];
const server=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-existing-client',clientSecret:'INVENTED_SECRET',http:async input=>{
 const path=new URL(String(input)).pathname;calls.push(path);
 if(path==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:grants.join(' ')});
 if(path.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
 throw Error('Unexpected provider request');
}}),client=new AccountClient(server.origin);let browser:Browser|undefined;
function callback(authorizationUrl:string,parameters:Record<string,string>){const auth=new URL(authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:auth.searchParams.get('state')!,...parameters}).toString();return url;}
try{
 await client.signin('invented-owner','invented-password-123',true);const initial=await client.connectGoogle();assert.equal((await fetch(callback(initial.authorizationUrl,{code:'invented-code'}))).status,200);await client.selectGoogleRoots(initial.connectionId,['root']);calls.length=0;
 browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});const context=await browser.newContext(),page=await context.newPage();
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
 await page.addInitScript(()=>{window.open=()=>null;});page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.method()==='POST')requests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
 await page.goto(server.origin+'/connections');await page.locator('#auth:not([hidden])').waitFor();await page.locator('#name').fill('invented-owner');await page.locator('#password').fill('invented-password-123');await page.locator('#signin button').first().click();
 const idle=()=>page.locator('#signed[aria-busy="false"]:not([hidden])').waitFor();await idle();
 const mail=page.locator('#enable-mail'),link=page.locator('#continue-google');assert.equal(await mail.isDisabled(),false);assert.match(await page.locator('#mail-status').innerText(),/not recorded/);assert.equal(requests.filter(r=>r.path==='/google/mail/begin').length,0);assert.deepEqual(calls,[]);
 await page.locator('#preparation-request').fill('INVENTED retained request: do not run');await page.locator('#preparation-save').check();
 async function begin(){await mail.click();await idle();await link.waitFor();const href=await link.getAttribute('href');assert.ok(href);return href;}
 const first=await begin(),auth=new URL(first);assert.equal(auth.searchParams.get('client_id'),'invented-existing-client');assert.equal(auth.searchParams.get('include_granted_scopes'),'true');assert.deepEqual(auth.searchParams.get('scope')!.split(' '),[scopes.mail,scopes.drive,compose,fullDrive],'one consent: compose plus full Drive (drive.file implied)');assert.deepEqual(calls,[]);
 await page.reload();await idle();assert.equal(await page.locator('#preparation-request').inputValue(),'INVENTED retained request: do not run');assert.equal(await page.locator('#preparation-save').isChecked(),true);assert.equal(await begin(),first,'reload plus explicit click reuses one live lease');
 assert.equal((await fetch(callback(first,{error:'access_denied'}))).status,400);await page.locator('#refresh-access').click();await idle();assert.match(await page.locator('#mail-status').innerText(),/not recorded/);assert.deepEqual(calls,[]);
 const partial=await begin();assert.equal((await fetch(callback(partial,{code:'invented-code',scope:compose}))).status,403);await page.locator('#refresh-access').click();await idle();assert.match(await page.locator('#mail-status').innerText(),/not recorded/);
 const final=await begin();grants=[...grants,compose,fullDrive];assert.equal((await fetch(callback(final,{code:'invented-code'}))).status,200);await page.locator('#refresh-access').click();await idle();
 assert.equal(await link.count(),0,'completed compose consent must remove its consumed Continue link even when Drive saving is unavailable');
 assert.equal(await mail.isDisabled(),true);assert.equal(await mail.innerText(),'Gmail permission recorded');assert.match(await page.locator('#mail-status').innerText(),/No email was drafted or sent/);assert.equal(await page.locator('#preparation-request').inputValue(),'INVENTED retained request: do not run');assert.equal(await page.locator('#preparation-save').isChecked(),true);
 const rows=(await client.googleConnections()).connections;assert.equal(rows.length,1);assert.equal(rows[0]!.id,initial.connectionId);assert.equal(rows[0]!.accountId,'invented@example.test');assert.deepEqual(rows[0]!.roots,['root']);assert.deepEqual(rows[0]!.grants,grants);
 assert.equal(requests.filter(r=>r.path==='/google/mail/begin').length,4);for(const request of requests.filter(r=>r.path==='/google/mail/begin'))assert.deepEqual(request.body,{connectionId:initial.connectionId});
 assert.ok(!requests.some(r=>/^\/mail\//.test(r.path)||['/preparation/request','/preparation/resume','/preparation/save'].includes(r.path)));assert.deepEqual(calls,['/token','/token','/gmail/v1/users/me/profile']);assert.deepEqual(errors,[]);
 await page.screenshot({path:join(output,'invented-grant-recorded.png'),fullPage:true});
 await writeFile(join(output,'result.json'),JSON.stringify({status:'PASS',proof:'Actual Chromium, normal sign-in/restore AccountClient, HTTP and encrypted persistence; invented Google only; NOT actual Google consent or live mail acceptance',sameClientAccountConnectionRoots:true,priorGrantsRetained:true,denialPartialReloadSafe:true,existingRequestAndSaveIntentRetained:true,noImplicitConsent:true,noDraftSendModelResume:true,providerPaths:calls,pageErrors:errors},null,2)+'\n');
 console.log('PASS compose UI: actual Chromium/ordinary sign-in + invented Google; no live consent/mail/model/resume');
}finally{await browser?.close();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
