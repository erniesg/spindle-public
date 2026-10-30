import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright-core';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import {inventedPdf,inventedPng} from '../portal/fixtures.js';

/* Application workspace journey, ~45 s recording. Run only when the coordinator schedules Chromium:
 *   npm run build && SPINDLE_REVIEW_CHROMIUM=/path/to/chromium \
 *   SPINDLE_APPLICATION_OUTPUT=$RUCKSACK_SCRATCH_ROOT/portal-application/run-N node build/tests/account/portal-application.e2e.js
 * REAL: account server, HttpOnly cookie sign-in through the existing /connections form, CSRF,
 * /preparation list/status/artifact/correct/browser-review, SQLite + evidence stores, Chromium.
 * FIXTURE (labelled in the recording): invented prepared task/files stored directly; no model,
 * Google or submission. PRE-SHELL HARNESS: until coordinator60's shell mounts this lane, Playwright
 * serves only two static same-origin scripts (/application-harness.js, /application-view.js) and a
 * harness stylesheet. No backend/auth request is intercepted, mocked or seeded; that is asserted. */
const executable=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executable)throw Error('Existing SPINDLE_REVIEW_CHROMIUM required');
const output=resolve(process.env.SPINDLE_APPLICATION_OUTPUT??'');if(!process.env.SPINDLE_APPLICATION_OUTPUT)throw Error('Private SPINDLE_APPLICATION_OUTPUT directory required');
mkdirSync(output,{recursive:false});
const pace=Number(process.env.SPINDLE_APPLICATION_PACE_MS??1400);
const name='invented-application-owner',password='invented-password-123';

const scratch=process.env.RUCKSACK_SCRATCH_ROOT??join(homedir(),'.local/state/rucksack/scratch/spindle-account-tests');mkdirSync(scratch,{recursive:true});
const directory=mkdtempSync(join(scratch,'portal-application-e2e-')),key=Buffer.alloc(32,76),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
let unexpected=0;
const server=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http:async()=>{unexpected++;throw Error('Unexpected Google call');}},{tasks,store,workspaceId:'invented-workspace',buildIdentity:'invented-application-e2e',processingPaused:false,browserPortal:{destination:'http://127.0.0.1:43197/',submissionUrl:'http://127.0.0.1:43197/applications',receiptUrl:'http://127.0.0.1:43197/receipts/invented',encoding:'multipart'},provider:()=>{unexpected++;throw Error('Unexpected model');},tools:()=>{unexpected++;throw Error('Unexpected execution');}});
// Harness-only styling adapted from the chosen workshop tokens (read-only reference); the shell owns real CSS.
const harnessCss=`body{margin:0;background:#f7f7f7;color:#222423;font:15px/1.5 'DM Sans',Arial,sans-serif}
.application-harness-banner{margin:0;padding:6px 24px;background:#fff8e1;border-bottom:1px solid #e1e3e1;font-size:13px;color:#65665f}
.application{max-width:1240px;margin:0 auto;padding:20px 24px}.application-eyebrow{margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#65665f}
.application-title{margin:2px 0 6px;font:400 34px/1.1 'Instrument Serif',Georgia,serif}.application-layout{display:grid;grid-template-columns:260px minmax(0,1fr) 320px;gap:16px;align-items:start}
.portal-card{background:#fff;border:1px solid #e1e3e1;border-radius:12px;padding:16px;margin-bottom:16px}.application-heading{margin:0 0 8px;font:400 22px/1.2 'Instrument Serif',Georgia,serif}
.application-subheading{margin:18px 0 8px;font-size:14px}.portal-muted{color:#65665f;font-size:13px}.portal-error{color:#a3341f;font-size:13px}.portal-status{font-size:13px;color:#2f5d3a}
.portal-badge{display:inline-block;padding:1px 8px;margin-right:6px;border-radius:999px;background:#f1f1ef;font-size:12px}.application-badge-ready,.application-badge-verified{background:#e6f2e8}.application-badge-warning,.application-badge-blocked{background:#fbefd5}.application-badge-corrected{background:#e9eef8}
button{font:inherit;font-size:13px;min-height:32px;padding:4px 12px;margin:2px 6px 2px 0;border-radius:999px;border:1px solid #c9cbc8;background:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:default}
.application-save,.application-approve{background:#292d2a;color:#fff;border-color:#292d2a}.application-task-list,.application-file-list,.application-source-list,.application-timeline{list-style:none;padding:0;margin:0}
.application-task-open{width:100%;text-align:left;border-radius:8px}.application-task-open[aria-current=true]{border:2px solid #292d2a}.application-field{padding:10px 0;border-top:1px solid #e1e3e1}
.application-field-label{display:block;font-weight:600;font-size:13px}.application-field-input{width:100%;box-sizing:border-box;font:inherit;padding:6px 10px;border:1px solid #c9cbc8;border-radius:7px;margin:4px 0}
.application-file,.application-source-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0}.is-historical{opacity:.7}.application-preview-image{max-width:100%;image-rendering:pixelated;min-height:120px;border:1px solid #e1e3e1;border-radius:7px}
.application-preview-text{white-space:pre-wrap;background:#f7f7f7;padding:10px;border-radius:7px;font-size:12px}.application-step.is-done::before{content:'✓ '}textarea,select{width:100%;box-sizing:border-box;font:inherit}`;
let browser:Browser|undefined,context:BrowserContext|undefined;
const fulfilled:string[]=[],api:string[]=[];
try{
 // Create the invented account through the ordinary API, then store an invented prepared task for it.
 const setup=new AccountClient(server.origin);await setup.signin(name,password,true);
 const ns={workspaceId:'invented-workspace',accountId:setup.account!.id};
 const source=store.put(ns,Buffer.from('INVENTED acceptance email\nParticipant: Mira Tan\nReference: 000045\nPlease register by 28 Oct.'),'text/plain',[],{provider:'user',providerId:'invented-email',providerVersion:'1'});
 const oldPdf=store.put(ns,Buffer.from(inventedPdf().replace('%PDF-1.4','%PDF-1.4\n%revision-1')),'application/pdf',[source.artifact.id]),pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[source.artifact.id]),photo=store.put(ns,inventedPng(),'image/png',[source.artifact.id]);
 const task=tasks.admit({...ns,messageId:'invented-application-e2e',outcome:'Register for the invented design workshop'},128);
 tasks.update(task.id,t=>{
  t.status='ready';t.nextAction='Review the prepared registration before any submission';
  t.checklist={revision:1,reason:'invented',items:[{id:'read',title:'Read the acceptance email',state:'done',dependsOn:[]},{id:'fill',title:'Fill the registration form',state:'done',dependsOn:['read']},{id:'photo',title:'Prepare the portrait photo',state:'done',dependsOn:['read']}]} as never;
  t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-e2e'};
  const cite=[{artifactId:source.artifact.id,sourceId:source.source!.id,sourceVersion:'1'}];
  const fields=[{id:'name',label:'Full name',value:'Mira Tan',corrected:true,unresolved:false,citations:cite},{id:'reference',label:'Participant reference',value:'000045',unresolved:false,citations:cite},{id:'phone',label:'Phone',value:'',unresolved:true,citations:[]}];
  t.preparation={connectionId:'invented-connection',rootId:'invented-root',incarnation:'invented',rootRevision:1,googleAccountId:'invented@example.test',requestId:'invented-request',request:'Register for the invented design workshop',revision:2,processingConsent:true,saveOutputs:false,sources:[source.source!],sourceNames:{'invented-email':'Acceptance email (invented)'},artifactIds:[source.artifact.id,oldPdf.artifact.id,pdf.artifact.id,photo.artifact.id],artifactRevisions:{[oldPdf.artifact.id]:1,[pdf.artifact.id]:2,[photo.artifact.id]:2},fields,revisions:[{revision:2,fieldId:'name',value:'Mira Tan'}],uploads:[],modelBudget:{limitUsd:.3,maximumDecisionCalls:16,maximumVisionCalls:3,decisionCalls:0,visionCalls:0,reservedUsd:0}};
  const before={...t.preparation,revision:1,fields:fields.map(f=>f.id==='name'?{...f,value:'Mira T.'}:f)};
  t.preparation.artifactBindings={[oldPdf.artifact.id]:preparationArtifactBinding(before,oldPdf.artifact.sha256,['name']),[pdf.artifact.id]:preparationArtifactBinding(t.preparation,pdf.artifact.sha256,['name']),[photo.artifact.id]:preparationArtifactBinding(t.preparation,photo.artifact.sha256,['name'])};
 });
 await setup.signout();

 browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});
 context=await browser.newContext({viewport:{width:1280,height:860},acceptDownloads:true,recordVideo:{dir:join(output,'video'),size:{width:1280,height:860}}});
 const view=readFileSync(new URL('../../core/account/portal/application.js',import.meta.url),'utf8');
 const harness=`import {AccountClient} from '/connections-client.js';import {mountApplication} from '/application-view.js';
const client=new AccountClient(location.origin,fetch,true);await client.restore();
const style=document.createElement('style');style.textContent=${JSON.stringify(harnessCss)};document.head.append(style);
for(const n of [...document.body.children])n.hidden=true;
const banner=document.createElement('p');banner.className='application-harness-banner';banner.textContent='Pre-shell harness · invented sample task · real account server, cookie session and /preparation API';
const root=document.createElement('main');document.body.append(banner,root);const controller=new AbortController();
mountApplication({root,client,signal:controller.signal,onError:e=>{banner.textContent='Shell would sign out: '+(e?.code||e?.message);}});`;
 await context.route(url=>['/application-harness.js','/application-view.js'].includes(url.pathname)&&url.origin===server.origin,route=>{fulfilled.push(new URL(route.request().url()).pathname);return route.fulfill({contentType:'text/javascript',body:new URL(route.request().url()).pathname==='/application-view.js'?view:harness});});
 const page=await context.newPage();
 page.on('request',r=>{const u=new URL(r.url());if(u.origin===server.origin&&!u.pathname.endsWith('.js')&&u.pathname!=='/connections')api.push(u.pathname);});
 const shot=async(label:string)=>{await page.waitForTimeout(pace);await page.screenshot({path:join(output,label+'.png')});};
 const mount=async(p:Page)=>{await p.addScriptTag({url:'/application-harness.js',type:'module'});await p.locator('.application-task-open').first().waitFor();};

 // 1. Ordinary sign-in through the existing account page (HttpOnly cookie + CSRF).
 await page.goto(server.origin+'/connections');await page.fill('#name',name);await page.fill('#password',password);
 await shot('01-signin');await page.click('#signin button:not([type=button])');await page.locator('#signed').waitFor();
 await mount(page);await shot('02-task-list');
 // 2. Select the task: answers, checklist, citations, current vs historical files.
 await page.click('.application-task-open');await page.locator('[data-application-field]').first().waitFor();await shot('03-review');
 assert.equal(await page.locator('.application-files .is-current').count(),2);assert.equal(await page.locator('.application-historical [data-application-artifact]').count(),1);
 // 3. Source citation → exact snapshot text; then photo and PDF previews.
 await page.locator('[data-application-field]').first().locator('.application-citation').click();await page.locator('.application-preview-text').waitFor();await shot('04-citation');
 await page.locator(`[data-application-artifact="${photo.artifact.id}"] .application-preview`).click();await page.locator('.application-preview-image').waitFor();
 assert.ok(await page.locator('.application-preview-image').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0));await shot('05-photo');
 // 4. Exact authenticated download: bytes must equal the stored artifact.
 await page.locator(`[data-application-artifact="${pdf.artifact.id}"] .application-preview`).click();await page.locator('.application-preview-pdf').waitFor();
 const [download]=await Promise.all([page.waitForEvent('download'),page.click('.application-download')]);const saved=join(output,'download-'+download.suggestedFilename());await download.saveAs(saved);
 assert.equal(createHash('sha256').update(readFileSync(saved)).digest('hex'),pdf.artifact.sha256);rmSync(saved);await shot('06-pdf-download');
 // 5. Reload: same cookie session, same persisted backend state.
 await page.reload();await page.locator('#signed').waitFor();await mount(page);await page.click('.application-task-open');await page.locator('[data-application-field]').first().waitFor();
 assert.equal(await page.locator('[data-application-field="name"] input').inputValue(),'Mira Tan');await shot('07-reloaded');
 // 6. Read-only destination check; submission explicitly unavailable.
 await page.click('.application-destination');await page.locator('.application-destination-result').waitFor();
 assert.equal(await page.locator('.application-approve').isDisabled(),true);await page.locator('.application-submission').scrollIntoViewIfNeeded();await shot('08-destination');
 // 7. Another device moves the revision; this tab's correction is refused, not overwritten.
 tasks.update(task.id,t=>{t.preparation!.revision=3;t.preparation!.fields[1]!.value='000046';t.applicationRevision={applicationId:t.id,revision:3,contentHash:'invented-other-device'};});
 await page.fill('[data-application-field="reference"] input','000099');await page.click('[data-application-field="reference"] .application-save');
 await page.locator('.application-conflict').waitFor();assert.equal(tasks.get(task.id).preparation!.fields[1]!.value,'000046');
 await page.locator('[data-application-field="reference"]').scrollIntoViewIfNeeded();await shot('09-conflict');

 assert.deepEqual([...new Set(fulfilled)].sort(),['/application-harness.js','/application-view.js'],'only static harness scripts were served by Playwright');
 for(const path of ['/session','/preparation/config','/preparation/list','/preparation/status','/preparation/artifact','/preparation/browser-review','/preparation/correct'])assert.ok(api.includes(path),'real backend request '+path);
 assert.equal(unexpected,0,'no Google, model or execution call');
 writeFileSync(join(output,'run.json'),JSON.stringify({kind:'spindle.portal-application.e2e.v1',label:'pre-shell harness; invented fixture task; real server/auth/API/Chromium',taskId:task.id,apiPaths:[...new Set(api)],fulfilledStatic:[...new Set(fulfilled)],pdfSha256:pdf.artifact.sha256,completedAt:new Date().toISOString()},null,2));
 await page.close();console.log('portal application e2e ok:',output);
}finally{await context?.close();await browser?.close();await server.close();tasks.close();store.close();key.fill(0);rmSync(directory,{recursive:true,force:true});}
