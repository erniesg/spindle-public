import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser,type BrowserContext} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {SharedGoogleConfig} from '../../core/tracking/google.js';

const executable=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executable)throw Error('SPINDLE_REVIEW_CHROMIUM required; no download');
const output=resolve(process.env.SPINDLE_GOOGLE_REVIEW_OUTPUT!);await mkdir(output,{recursive:false});
const directory=await mkdtemp(join(tmpdir(),'gout-ui-')),key=Buffer.alloc(32,57),calls:string[]=[];
// writeGrant models accepting the single full consent (Gmail compose + full Drive, which implies drive.file).
let writeGrant=false,sdkLoads=0;
const config:SharedGoogleConfig={clientId:'invented-client',clientSecret:'INVENTED_SECRET',http:async input=>{
 const u=new URL(String(input));calls.push(u.pathname);
 if(u.pathname==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:[scopes.mail,scopes.drive,...(writeGrant?['https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive']:[])].join(' ')});
 if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
 if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
 throw Error('Unexpected fake Google request');
}};
const server=await startTrackingServer(directory,key,0,undefined,config),client=new AccountClient(server.origin);
let browser:Browser|undefined,context:BrowserContext|undefined;
async function consent(url:string){const auth=new URL(url),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);}
try{
 await client.signin('invented-owner','invented-password-123',true);const flow=await client.connectGoogle();await consent(flow.authorizationUrl);await client.selectGoogleRoots(flow.connectionId,['root']);calls.length=0;
 browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});
 context=await browser.newContext({viewport:{width:1100,height:1100},recordVideo:{dir:join(output,'video')}});const page=await context.newPage();
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===server.origin)return route.continue();
  if(url.href==='https://apis.google.com/js/api.js'){sdkLoads++;return route.fulfill({contentType:'text/javascript',body:`globalThis.gapi={load:(_name,o)=>o.callback()};globalThis.google={picker:{ViewId:{FOLDERS:'folders'},Action:{PICKED:'picked'},DocsView:class{setIncludeFolders(){return this}setSelectFolderEnabled(){return this}},PickerBuilder:class{setAppId(){return this}setDeveloperKey(){return this}setOAuthToken(){return this}setOrigin(){return this}addView(){return this}setCallback(cb){this.cb=cb;return this}build(){const cb=this.cb;return {setVisible(v){if(v)setTimeout(()=>cb({action:'picked',docs:[{id:'root'}]}),0)},dispose(){}}}}}};`});}
  return route.abort();
 });
 await page.request.post(server.origin+'/signin',{headers:{Origin:server.origin},data:{name:'invented-owner',password:'invented-password-123'}});
 await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('p');banner.textContent='INVENTED DATA / FAKE GOOGLE + PICKER · source UI proof only, NOT live acceptance';document.body.prepend(banner);}));
 await page.goto(server.origin+'/connections');await page.locator('#signed[aria-busy="false"]').waitFor();
 const card=page.locator('[data-connection-id="'+flow.connectionId+'"]'),picker=card.getByRole('button',{name:'Authorize saved folder in Google Picker (temporary browser token)',exact:true}),grant=card.getByRole('button',{name:'Allow new outputs in Google (drive.file)',exact:true});
 const assertDisabled=async(control:typeof picker,expected:boolean)=>assert.equal(await control.isDisabled(),expected);
 const refresh=async()=>{await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.locator('#signed[aria-busy="false"]').waitFor();};
 await assertDisabled(picker,true);await assertDisabled(grant,true);assert.match(await card.innerText(),/operator.*configur/i);assert.match(await card.innerText(),/Local preparation can continue/);await assertDisabled(page.locator('#run-preparation'),false);assert.equal(await page.locator('#preparation-save').isChecked(),false);assert.deepEqual(calls,[]);assert.equal(sdkLoads,0);
 await page.screenshot({path:join(output,'configuration-required.png'),fullPage:true});
 config.picker={appId:'123456789',developerKey:'INVENTED_BROWSER_KEY_123456789'};await refresh();
 await assertDisabled(picker,true);await assertDisabled(grant,false);assert.match(await card.innerText(),/Allow new outputs/);assert.match(await card.innerText(),/Local preparation can continue/);assert.deepEqual(calls,[]);assert.equal(sdkLoads,0);
 await grant.click();await page.getByRole('link',{name:'Continue to Google for new-output permission',exact:true}).waitFor();const auth=await page.getByRole('link',{name:'Continue to Google for new-output permission',exact:true}).getAttribute('href');assert.equal(new URL(auth!).searchParams.get('include_granted_scopes'),'true');assert.deepEqual(new URL(auth!).searchParams.get('scope')!.split(' '),[scopes.mail,scopes.drive,'https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive']);assert.deepEqual(calls,[]);
 await page.screenshot({path:join(output,'grant-required.png'),fullPage:true});
 writeGrant=true;await consent(auth!);calls.length=0;await refresh();await assertDisabled(picker,false);await assertDisabled(grant,true);assert.match(await card.innerText(),/not.*parent authorization/i);assert.deepEqual(calls,[]);
 await page.screenshot({path:join(output,'picker-available-not-parent-proof.png'),fullPage:true});
 // Stale readiness is advisory: the authenticated endpoint still reports precise configuration recovery.
 delete config.picker;await picker.click();await page.getByText(/Ask the operator to configure/).first().waitFor();assert.match(await page.locator('#notice').innerText(),/Local preparation can continue/);assert.deepEqual(calls,[]);assert.equal(sdkLoads,0);
 config.picker={appId:'123456789',developerKey:'INVENTED_BROWSER_KEY_123456789'};await refresh();await picker.click();await page.getByText('Google confirms this exact folder is app-authorized and allows new children. Resume the retained preparation to save outputs.',{exact:true}).waitFor();assert.equal(sdkLoads,1);assert.deepEqual(calls,['/token','/token','/drive/v3/files/root']);
 await writeFile(join(output,'result.json'),JSON.stringify({status:'PASS',proof:'actual sandboxed Chromium + authenticated account API; invented Google/Picker, no external dispatch',configurationDisabled:true,grantRecovery:true,availableIsNotParentProof:true,staleReadinessTypedRecovery:true,explicitPickerAndParentCheck:true,localPreparationAvailable:true},null,2)+'\n');
 console.log('PASS output readiness UI / sandboxed Chromium / invented Google and Picker only');
}finally{await context?.close();await browser?.close();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
