/** Real local document/script/CSS/font HTTP responses and CSP; invented API fixture only.
 * No Google/model/production journey or output-quality acceptance. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {startTrackingServer} from '../../core/tracking/server.js';
import {resolve} from 'node:path';
import {chromium,type Browser,type Page} from 'playwright-core';
import {PDFDocument} from 'pdf-lib';
const account={id:'11111111-1111-4111-8111-111111111111',name:'invented-ui'},csrf='a'.repeat(64);
const media=process.env.SPINDLE_UI_TEST_MEDIA;if(media)await mkdir(media,{recursive:true});
const pdf=await PDFDocument.create();pdf.addPage().drawText('Invented UI fixture. Not a prepared product output.');const pdfBytes=Buffer.from(await pdf.save());
// Real document policies from this build's HTTP server, not a hand-copied permissive fixture.
const scratch=process.env.RUCKSACK_SCRATCH_ROOT??resolve(homedir(),'.local/state/rucksack/scratch');await mkdir(scratch,{recursive:true});const localDirectory=await mkdtemp(resolve(scratch,'recipient-csp-'));
const local=await startTrackingServer(localDirectory,Buffer.alloc(32,19),0),origin=local.origin;
const themeProof:unknown[]=[],negativeProof:unknown[]=[];
const policies=new Map<string,string>();for(const path of ['/connections','/mail']){const response=await fetch(local.origin+path);assert.equal(response.status,200);policies.set(path,response.headers.get('content-security-policy')??'');await response.body?.cancel();}
const browser:Browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',headless:true,chromiumSandbox:true});
async function fixture(options:{googleStatus?:number;mailOff?:boolean;expired?:boolean;preparationOff?:boolean}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),calls:{path:string;body:any}[]=[],assets=new Map<string,number>(),outside:string[]=[];let denyCheck=true;
 await context.addInitScript(()=>{(window as any).__csp=[];addEventListener('securitypolicyviolation',e=>{(window as any).__csp.push({directive:e.effectiveDirective,uri:e.blockedURI});});});
 let connection={id:'invented-connection',accountId:'invented@example.test',status:'connected',grants:[],roots:[] as string[],rootRevision:1,outputReadiness:{pickerConfigured:false,grantPresent:false}};
 const task={taskId:'invented-task',revision:1,state:'ready',request:'Prepare the invented form',connectionId:connection.id,rootId:'invented-folder',saveOutputs:false,processingConsent:true,execution:{state:'ready',phase:'review'},sources:[],fields:[],artifacts:[{id:'invented-output',mimeType:'application/pdf',bytes:pdfBytes.length,current:true}],outputs:[],models:{},budget:{},session:{},actions:[]};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;if(url.origin!==origin){outside.push(request.url());await route.abort();return;}
  const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  // Only APIs below are intercepted. Documents, browser modules, CSS and fonts use the real server.
  if(['/connections','/mail','/connections.js','/mail.js','/connections-client.js'].includes(path)||path.startsWith('/portal/'))return route.continue();
  const body=request.postDataJSON();calls.push({path,body});
  if(path==='/session')return options.expired?json({code:'SIGNIN_REQUIRED'},401):json({account,csrf});
  if(path==='/preparation/config')return options.preparationOff?json({configured:false,processingPaused:true,access:'connection-only'}):json({configured:true,processingPaused:false});
  if(path==='/google/list')return options.googleStatus?json({code:options.googleStatus===503?'GOOGLE_NOT_CONFIGURED':'GOOGLE_ROOT_DENIED'},options.googleStatus):json({connections:[connection]});
  if(path==='/google/roots'){connection={...connection,roots:body.roots,rootRevision:connection.rootRevision+1};return json(connection);}
  if(path==='/google/drive/check')return denyCheck?json({code:'GOOGLE_ROOT_DENIED'},403):json({providerId:body.rootId,providerVersion:'1',mimeType:'application/vnd.google-apps.folder'});
  if(path==='/preparation/list')return json({tasks:[],limit:20});
  if(path==='/preparation/request')return json({taskId:task.taskId,revision:1,state:'ready'});
  if(path==='/preparation/status')return json(task);
  if(path==='/preparation/artifact')return route.fulfill({contentType:'application/pdf',body:pdfBytes});
  if(path==='/mail/config'&&options.mailOff)return json({code:'MAIL_NOT_CONFIGURED'},503);
  return json({code:'NOT_AVAILABLE'},404);
 });
 const page=await context.newPage();page.on('response',response=>{const u=new URL(response.url());if(u.origin===origin)assets.set(u.pathname,response.status());});page.setDefaultTimeout(7000);return {page,calls,context,assets,outside,allowCheck:()=>{denyCheck=false;}};
}
async function theme(page:Page,assets:Map<string,number>){
 await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.locator('.portal-shell').evaluate(el=>getComputedStyle(el).display),'grid','real document CSP must allow the workspace stylesheet');
 assert.match(await page.locator('.portal-brand').evaluate(el=>getComputedStyle(el).fontFamily),/Instrument Serif/);
 const fonts=await page.evaluate(()=>[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family));assert.ok(fonts.some(f=>f.includes('Instrument Serif')));assert.ok(fonts.some(f=>f.includes('DM Sans')));
 for(const path of ['/portal/styles.css','/portal/fonts.css','/portal/fonts/instrument.woff2','/portal/fonts/dm-sans-normal.woff2'])assert.equal(assets.get(path),200,path+' loaded from actual HTTP');
 const violations=await page.evaluate(()=>(window as any).__csp.filter((v:any)=>/style|font/.test(v.directive)));assert.deepEqual(violations,[],'no style/font CSP violations before deliberate negatives');
 themeProof.push({path:new URL(page.url()).pathname,display:await page.locator('.portal-shell').evaluate(el=>getComputedStyle(el).display),brandFont:await page.locator('.portal-brand').evaluate(el=>getComputedStyle(el).fontFamily),loadedFontFaces:fonts,assets:Object.fromEntries([...assets].filter(([p])=>p.endsWith('.css')||p.endsWith('.woff2'))),styleFontViolations:violations});
}
try{
 assert.equal(policies.get('/mail'),"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'all other mail directives unchanged');
 assert.equal(policies.get('/connections'),"default-src 'none'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https://www.googleapis.com https://content.googleapis.com; img-src blob:; frame-src https://docs.google.com https://drive.google.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'all other Google directives unchanged');
 const f=await fixture();try{
  await f.page.goto(origin+'/connections');await f.page.getByText('Signed in as invented-ui').waitFor();
  await theme(f.page,f.assets);
  assert.equal(await f.page.locator('#connect').isVisible(),true);assert.equal(await f.page.locator('#advanced-connections').getAttribute('open'),null);
  await f.page.locator('#preparation-request').fill('Prepare the invented form');await f.page.locator('#preparation-processing').check();assert.equal(await f.page.locator('#run-preparation').isDisabled(),true);
  await f.page.locator('#source-folder-link').fill('https://evil.example/drive/folders/invented-folder');await f.page.locator('#use-source-folder').click();await f.page.getByText('Paste the folder link from Google Drive, not a folder ID or another website.').waitFor();assert.equal(f.calls.filter(c=>c.path==='/google/roots').length,0);
  await f.page.locator('#source-folder-link').fill('https://drive.google.com/drive/folders/invented-folder?usp=sharing');await f.page.locator('#use-source-folder').click();await f.page.getByText('This action is not available right now.',{exact:false}).waitFor();assert.equal(await f.page.locator('#signed').isVisible(),true);assert.equal(await f.page.locator('#run-preparation').isDisabled(),true);assert.doesNotMatch(await f.page.locator('#source-status').innerText(),/Folder checked/);
  f.allowCheck();await f.page.locator('#use-source-folder').click();await f.page.getByText('Folder checked and selected.',{exact:false}).waitFor();assert.equal(await f.page.locator('#run-preparation').isEnabled(),true);assert.match(await f.page.locator('#source-status').innerText(),/Folder checked/);
  assert.equal(await f.page.locator('#preparation-request').inputValue(),'Prepare the invented form');assert.equal(f.calls.filter(c=>c.path==='/preparation/request').length,0);
  await f.page.locator('#run-preparation').click();await f.page.getByRole('button',{name:'Open prepared document',exact:true}).waitFor();assert.equal(f.calls.filter(c=>c.path==='/preparation/request').length,1);const admission=f.calls.find(c=>c.path==='/preparation/request')!;assert.equal(admission.body.rootId,'invented-folder');assert.equal(admission.body.processingConsent,true);
  await f.page.getByRole('button',{name:'Open prepared document',exact:true}).click();await f.page.getByRole('link',{name:'Download prepared output',exact:true}).waitFor();assert.match(await f.page.getByRole('link',{name:'Download prepared output',exact:true}).getAttribute('href')??'',/^blob:/);
  if(media)await f.page.screenshot({path:resolve(media,'mock-prepare-review-desktop.png'),fullPage:true});await f.page.setViewportSize({width:390,height:844});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);if(media)await f.page.screenshot({path:resolve(media,'mock-prepare-review-mobile.png'),fullPage:true});
  assert.deepEqual(f.outside,[],'no outside Google/model/network calls');
  await f.page.evaluate(()=>{const style=document.createElement('link');style.rel='stylesheet';style.href='https://untrusted.example/not-allowed.css';const script=document.createElement('script');script.src='https://untrusted.example/not-allowed.js';document.head.append(style,script);});
  await f.page.waitForFunction(()=>(window as any).__csp.some((v:any)=>v.directive.startsWith('style-src')&&v.uri.includes('untrusted.example'))&&(window as any).__csp.some((v:any)=>v.directive.startsWith('script-src')&&v.uri.includes('untrusted.example')));
  assert.deepEqual(f.outside,[],'untrusted style/script blocked by actual CSP before network');negativeProof.push({violations:await f.page.evaluate(()=>(window as any).__csp),outsideNetworkRequests:f.outside});
 }finally{await f.context.close();}
 for(const googleStatus of [503,403]){const f=await fixture({googleStatus});try{await f.page.goto(origin+'/connections');await f.page.locator('#notice').filter({hasText:googleStatus===503?'still signed in':'not available right now'}).waitFor();assert.equal(await f.page.locator('#signed').isVisible(),true);assert.equal(await f.page.locator('#auth').isVisible(),false);assert.equal(await f.page.locator('#run-preparation').isDisabled(),true);assert.doesNotMatch(await f.page.locator('body').innerText(),/Restore your Spindle session|GOOGLE_NOT_CONFIGURED|GOOGLE_ROOT_DENIED/);}finally{await f.context.close();}}
 const closed=await fixture({preparationOff:true});try{closed.allowCheck();await closed.page.goto(origin+'/connections');await closed.page.locator('#source-folder-controls').waitFor({state:'visible'});await closed.page.locator('#source-folder-link').fill('https://drive.google.com/drive/folders/invented-folder');await closed.page.locator('#use-source-folder').click();await closed.page.getByText('Folder checked and selected.',{exact:false}).waitFor();assert.equal(await closed.page.locator('#run-preparation').isDisabled(),true);assert.equal(await closed.page.locator('#connect').isEnabled(),true);assert.doesNotMatch(await closed.page.locator('body').innerText(),/connection-only|owned-pilot|scopeId/);assert.equal(closed.calls.filter(c=>c.path==='/preparation/request').length,0);}finally{await closed.context.close();}
 const off=await fixture({mailOff:true});try{await off.page.goto(origin+'/mail');await off.page.locator('#notice').filter({hasText:'still signed in'}).waitFor();await theme(off.page,off.assets);assert.deepEqual(off.outside,[]);assert.equal(await off.page.locator('#signed').isVisible(),true);assert.equal(await off.page.locator('#auth').isVisible(),false);assert.equal(await off.page.locator('#draft').isDisabled(),true);assert.equal(await off.page.locator('#send').isDisabled(),true);assert.doesNotMatch(await off.page.locator('body').innerText(),/MAIL_NOT_CONFIGURED|GOOGLE_NOT_CONFIGURED/);assert.equal(off.calls.filter(c=>c.path==='/mail/send').length,0);if(media)await off.page.screenshot({path:resolve(media,'mock-mail-unavailable.png'),fullPage:true});}finally{await off.context.close();}
 const expired=await fixture({expired:true});try{await expired.page.goto(origin+'/connections');await expired.page.locator('#auth').waitFor({state:'visible'});assert.equal(await expired.page.locator('#signed').isVisible(),false);}finally{await expired.context.close();}
 console.log(JSON.stringify({scope:'REAL local HTTP document/CSS/font CSP + INVENTED APIs only; NOT production/provider acceptance',policies:Object.fromEntries(policies),themeProof,negativeProof},null,2));
 console.log('PASS REAL local HTTP CSP/documents/modules/CSS/WOFF2+computed theme/FontFaceSet; no style/font violations; external style/script CSP-blocked BEFORE network; other directives unchanged. Invented API browser fixture: primary connect; safe Drive link; mocked drive/check denial blocks preparation; mocked check success then single request/artifact download; configured:false keeps connect available/preparation disabled; 503/403 preserve sign-in; mail OFF/owner-only Send; 401 expires; mobile fits. NOT public/provider/preparation acceptance.');
}finally{await browser.close();await local.close();await rm(localDirectory,{recursive:true,force:true});}
