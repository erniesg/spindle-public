// Production extension + authenticated Native Messaging/Root IPC, invented pages.
// ONLY the vendor transport is a deterministic native-Jev protocol fixture.
// This is not live semantic quality, native capture or installed Win/Mac proof.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,type BrowserContext,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {runTimerOnly} from '../../core/preview/timer-only.js';
import {PurposeClassifier,JEV_ENDPOINT} from '../../core/blocking/classifier.js';
import {CallBudget} from '../../core/models/provider.js';
import {JEV_MODEL,JEV_SCOPE_REVISION,SCORE_LEVELS,parseJevComparison} from '../../core/blocking/jev.js';
interface Fixture {purpose:string;cases:{id:string;path:string;title:string;description:string;text:string;expected:string}[]}
const fixture=JSON.parse(await readFile(resolve('tests/fixtures/jev-gating.json'),'utf8')) as Fixture;
const output=resolve(process.env.SPINDLE_JEV_OUTPUT??'.local/issue78-jev/browser');await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(output,'run-')),home=join(directory,'home'),config=join(home,'.config');await mkdir(config,{recursive:true});
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const requests:{path:string;document:boolean;cookie:boolean}[]=[];
const pages=createServer((req,res)=>{
 const page=fixture.cases.find(p=>p.path===req.url);
 requests.push({path:req.url??'',document:req.headers['sec-fetch-dest']==='document'||String(req.headers.accept??'').includes('application/xhtml+xml'),cookie:!!req.headers.cookie});
 if(!page){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(page.title)}</title><meta name="description" content="${escape(page.description)}"></head><body><h1>${escape(page.title)}</h1><p>${escape(page.text)}</p><form><input type="password" value="INVENTED_FORM_SECRET"></form><script>/* INVENTED_SCRIPT_SECRET */</script></body></html>`);
});await new Promise<void>(r=>pages.listen(0,'127.0.0.1',r));
const port=(pages.address() as {port:number}).port,resource=(id:string)=>`http://gating.example:${port}${fixture.cases.find(item=>item.id===id)!.path}`;
const modelRequests:{resource:string;bodySha256:string;label:string}[]=[];
const modelBudget=new CallBudget(.1,10); // Synthetic accounting ONLY; no real provider transport/key.
let holdNext=false,release:(()=>void)|undefined,dispatch:()=>void=()=>{},heldValidPositive=false;
const classifier=new PurposeClassifier(modelBudget,async()=>'invented-offline-key',async(url,options)=>{
 assert.equal(url,JEV_ENDPOINT);const body=JSON.parse(options?.body as string),path=new URL(body.state.resource).pathname;
 assert.equal(body.model,JEV_MODEL);assert.equal('policyVersion'in body.state,false);assert.equal('accountId'in body.state,false);
 assert.equal(JSON.stringify(body.state).includes('INVENTED_FORM_SECRET'),false);assert.equal(JSON.stringify(body.state).includes('INVENTED_SCRIPT_SECRET'),false);
 assert.ok(body.state.pageText.length>0);const label=path===fixture.cases[0].path?'relevant':path===fixture.cases[1].path?'unrelated':'insufficient';
 modelRequests.push({resource:body.state.resource,bodySha256:createHash('sha256').update(options?.body as string).digest('hex'),label});
 const level=label==='relevant'?4:label==='unrelated'?0:2;
 const response=Response.json({model:JEV_MODEL,answers:{relevance_choice:{type:'choice',choice:label,confidence:.99,probabilities:{relevant:label==='relevant'?.99:.005,unrelated:label==='unrelated'?.99:.005,insufficient:label==='insufficient'?.99:.005}},
  relevance_score:{type:'score',score:level,confidence:.99,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[i,v])),probabilities:Object.fromEntries(SCORE_LEVELS.map((_,i)=>[i,i===level?1:0]))},
  explains_concept:{type:'noul',noul:label==='relevant'?.99:label==='unrelated'?.01:.5}},usage:{input_tokens:300,output_tokens:60}});
 if(holdNext){holdNext=false;const positive=parseJevComparison(await response.clone().json());assert.ok(positive);assert.equal(positive.choice.label,'relevant');assert.equal(positive.score.value,4);assert.equal(positive.noul.probability,.99);
  return new Promise<Response>(resolve=>{release=()=>{heldValidPositive=true;resolve(response);};dispatch();});}dispatch();return response;
});
// The agreed additive Root injection seam. Old two-argument hosts ignore this
// option and MUST fail the journey, not be described as integrated success.
type Host=Awaited<ReturnType<typeof runTimerOnly>>;
const startHost=runTimerOnly as (directory:string,noOpen:boolean,options:{purposeClassifier:PurposeClassifier})=>Promise<Host>;
let backend:Awaited<ReturnType<typeof startTrackingServer>>|undefined,host:Host|undefined;
let context:BrowserContext|undefined,passed=false;
const executablePath=process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const launch=()=>chromium.launchPersistentContext(join(directory,'profile'),{executablePath,headless:false,viewport:{width:1280,height:900},env:{...process.env,HOME:home,XDG_CONFIG_HOME:config,CHROME_CONFIG_HOME:config},args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP gating.example 127.0.0.1',`--disable-extensions-except=${resolve('build/browser-extension/preview')}`,`--load-extension=${resolve('build/browser-extension/preview')}`]});
async function blocked(page:Page,url:string){
 let failure='';try{await page.goto(url,{waitUntil:'domcontentloaded'});}catch(error){failure=String(error);}
 assert.match(failure,/ERR_BLOCKED_BY_CLIENT/,'browser DNR must reject navigation, not merely omit a fixture heading');
 // Chrome commits its error document after rejecting goto. This wait only
 // settles display; the network error and server request counts are the oracle.
 await page.waitForTimeout(100);
}
async function waitOutput(controls:Page,pattern:RegExp){await controls.waitForFunction(source=>new RegExp(source).test(document.querySelector('output')?.textContent??''),pattern.source);}
try{
 backend=await startTrackingServer(join(directory,'account'),randomBytes(32));
 host=await startHost(join(directory,'control'),true,{purposeClassifier:classifier});
 context=await launch();const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'",launcher=join(directory,'native-host.sh');
 await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('build/core/preview/browser-host.js'))} "$@" --control-directory ${quote(join(directory,'control'))}\n`,{mode:0o700});
 const hosts=join(directory,'profile/NativeMessagingHosts');await mkdir(hosts,{recursive:true,mode:0o700});
 await writeFile(join(hosts,'ai.berlayar.spindle.preview.json'),JSON.stringify({name:'ai.berlayar.spindle.preview',description:'Run-owned invented purpose gating check',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}),{mode:0o600});
 const desktop=await context.newPage();await desktop.goto(host.url);await desktop.locator('#pomodoro-origin').fill(backend.origin);
 await desktop.locator('[name=account]').fill('invented-jev-gating');await desktop.locator('[name=password]').fill('invented-only-password');await desktop.locator('[name=register]').check();await desktop.getByRole('button',{name:'Sign in',exact:true}).click();
 await desktop.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='online');assert.equal(await desktop.locator('#capture-controls').isVisible(),false);
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.locator('#code').fill(await desktop.locator('#pomodoro-pair').innerText());await options.getByRole('button',{name:'Pair this profile',exact:true}).click();await options.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('Paired'));
 // Never enable timer access or recording. Purpose processing has its own grant.
 assert.equal(await desktop.locator('#pomodoro-extension-access').isChecked(),false);
 let controls=await context.newPage();await controls.goto(`chrome-extension://${id}/blocking.html`);
 const opened=context.waitForEvent('page');let targetId=await controls.evaluate(async()=>{const tab=await chrome.tabs.create({url:'about:blank',active:false});if(tab.id===undefined)throw Error('FIXTURE_TAB_NOT_CREATED');return tab.id;});
 let target=await opened;await controls.reload();
 await controls.locator('#host').fill('gating.example');await controls.locator('#purpose').fill(fixture.purpose);await controls.locator('form button').click();
 // Explicit native Chrome site grant in this new disposable profile only. No
 // manifest/global/user-profile privilege injection; no recording of this entry.
 await controls.waitForTimeout(700);execFileSync('python3',['-c',`import ctypes
x=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong];t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong];x.XFlush.argtypes=[ctypes.c_void_p];t.XTestFakeMotionEvent(d,-1,823,286,0);t.XTestFakeButtonEvent(d,1,1,0);t.XTestFakeButtonEvent(d,1,0,0);x.XFlush(d)`]);
 await waitOutput(controls,/^Active:/);await blocked(target,resource('lesson'));await controls.bringToFront();
 async function choose(id:string){
  await controls.locator('#tab').selectOption(String(targetId));await controls.locator('#resource').fill(resource(id));
 }
 await choose('lesson');await controls.locator('#jev-review').click();await waitOutput(controls,/processing consent/i);assert.equal(requests.length,0);assert.equal(modelRequests.length,0);
 await controls.locator('#processing-consent').check();await controls.locator('#jev-review').click();await waitOutput(controls,/Jev eligibility passed/);await target.locator('h1').waitFor();assert.equal(await target.locator('h1').innerText(),fixture.cases[0].title);assert.equal(modelRequests.length,1);
 assert.equal(requests.filter(r=>r.document&&r.path===fixture.cases[0].path).length,1,'navigation counter must distinguish the admitted document from the producer fetch');
 await controls.screenshot({path:join(output,'allow.png')});
 // Real browser restart: dynamic whole-site policy stays, automatic session
 // authority does not. Same owned profile/host account; no copied tokens.
 await context.close();context=await launch();controls=await context.newPage();await controls.goto(`chrome-extension://${id}/blocking.html`);
 const reopened=context.waitForEvent('page');targetId=await controls.evaluate(async()=>{const tab=await chrome.tabs.create({url:'about:blank',active:false});if(tab.id===undefined)throw Error('FIXTURE_TAB_NOT_CREATED');return tab.id;});
 target=await reopened;await controls.reload();await waitOutput(controls,/^Active:/);
 const before=requests.filter(r=>r.document).length;await blocked(target,resource('lesson'));assert.equal(requests.filter(r=>r.document).length,before);
 for(const item of fixture.cases.slice(1)){
  await blocked(target,resource(item.id));await controls.bringToFront();await choose(item.id);await controls.locator('#processing-consent').check();await controls.locator('#jev-review').click();await waitOutput(controls,/resource remains blocked/);
  assert.equal(requests.filter(r=>r.document&&r.path===item.path).length,0);await controls.screenshot({path:join(output,item.id+'.png')});
 }
 assert.equal(modelRequests.length,3);console.log('PASS three-case OFFLINE model-protocol pilot: real browser allow/deny/ambiguous + full browser restart + no-consent denial. NOT live Jev quality.');
 // Expand negatives only after the representative three-case pilot is inspected.
 if(process.env.SPINDLE_JEV_NEGATIVES==='1'){
  await controls.bringToFront();await choose('lesson');holdNext=true;const started=new Promise<void>(resolve=>{dispatch=resolve;});await controls.locator('#jev-review').click();await started;
  await target.goto('about:blank');assert.ok(release,'must release the actual held valid positive');release();await waitOutput(controls,/resource remains blocked|Source, navigation|Stale/);
  const rules=await (context.serviceWorkers()[0]??await context.waitForEvent('serviceworker')).evaluate(async()=>chrome.declarativeNetRequest.getSessionRules());assert.equal(rules.length,0);assert.equal(heldValidPositive,true);await blocked(target,resource('lesson'));
  await controls.locator('#processing-consent').uncheck();assert.equal(modelRequests.length,4);
 }
 await writeFile(join(output,'result.json'),JSON.stringify({result:'PASS',source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),browser:context.browser()?.version(),modelQuestionRevision:JEV_SCOPE_REVISION,method:'Actual production extension/worker/NativeMessaging/Root IPC, capture-free signed-in session, separate purpose grants and real DNR; vendor transport ONLY is deterministic fixture',notProven:'Actual Jev semantic quality/vendor HTTP and installed Windows/Mac/native capture',cases:fixture.cases.map(p=>({id:p.id,expected:p.expected})),modelRequests,requests,heldValidPositive,noGlobalRegistration:true,noPaidCalls:true},null,2));passed=true;
}finally{
 if(!passed&&context){for(const [i,page]of context.pages().entries())await page.screenshot({path:join(output,`failure-${i}.png`)}).catch(()=>{});}
 await context?.close();await host?.close();await backend?.close();await new Promise<void>(r=>pages.close(()=>r()));
 // Preserve all run-owned fixtures, sources and evidence for review; no raw
 // credential/profile data is uploaded. Cleanup registration only with the profile.
}
