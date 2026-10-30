// Actual retained MIME/Task + private HTTP + clean sandboxed Chromium. SCRIPTED provider/HTTP, not LLM/mail acceptance.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {createTaskMailTools} from '../../core/agent/mail-host.js';
import {startTaskReview} from '../../core/assistant/app.js';
import {mailSendGrants} from '../../core/connectors/google/outgoing.js';
import {inventedPdf} from '../portal/fixtures.js';
const output=resolve(process.env.SPINDLE_TASK_MAIL_REVIEW_OUTPUT??'.local/task-mail-review');mkdirSync(output,{recursive:true});
const ns={workspaceId:'invented-private-workspace',accountId:'invented-owner-uuid'},sender='selected@example.test';
const tasks=new AgentStore(join(output,'tasks.sqlite')),store=new EvidenceStore(join(output,'evidence'));let posts=0,modelTurns=0;
const pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[],{provider:'user',providerId:'invented-source',providerVersion:'1'});
const mail=createTaskMailTools({tasks,store,namespace:ns,sender,send:{connectionId:'invented-connection',connectionEpoch:'epoch',grant:mailSendGrants.send,oauth:{connectorAccess:async()=>({accountId:sender,connectionEpoch:'epoch',assertCurrent:async()=>{},token:async()=> 'INVENTED'})},assertCurrent:async()=>{},http:async()=>{posts++;throw Error('Invented lost ACK');}}});
const task=tasks.admit({...ns,messageId:'invented-owner-review',outcome:'Prepare the invented workshop email for review'},30);
const content={to:[{address:'recipient@example.test',name:'Invented workshop team'}],cc:[{address:'copy@example.test'}],bcc:[{address:'private-copy@example.test'}],subject:'Invented workshop draft',text:'Invented reference 000045. This is retained partial work, not an actual sent message.',html:'<script>window.__mailExecuted=true</script><img src="https://unrelated.example/pixel">',attachments:[{artifactId:pdf.artifact.id,sha256:pdf.artifact.sha256,name:'invented-proposal.pdf'}]};
const invoke=async(name:string,args:unknown)=>new AgentRuntime(tasks,mail.tools).run(task.id,{id:'scripted-fixture-NOT-LLM',async next(){modelTurns++;return {kind:'tool',name,args};}},1,{...mail.execution,scope:{sources:[pdf.source!],destinations:[],grants:[]}});
await invoke('mail.draft.create',{content,provenanceIds:[]});const first=mail.status(task.id).drafts;const ref=Object.values(first)[0]!;
let app=await startTaskReview(tasks,ns,store,undefined,(id,after)=>mail.review(id,after));
const browser=await chromium.launch({executablePath:process.env.SPINDLE_REVIEW_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',headless:true,chromiumSandbox:true});
const context=await browser.newContext({viewport:{width:1280,height:950},recordVideo:{dir:join(output,'raw-video'),size:{width:1280,height:950}}});
const page=await context.newPage();const errors:string[]=[],outside:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).origin!==app.origin)outside.push(new URL(r.url()).origin);});
const label=async()=>page.evaluate(()=>{if(document.getElementById('invented-evidence'))return;const p=document.createElement('p');p.id='invented-evidence';p.textContent='INVENTED · scripted provider/HTTP · actual local Task/MIME/UI · not real mail/LLM';p.style.cssText='background:#fff0bf;padding:8px';document.getElementById('task-mail-review')!.prepend(p);});
const show=async()=>{await page.locator('#task-mail-review').waitFor({state:'visible'});await label();await page.locator('#task-mail-review').scrollIntoViewIfNeeded();};
const timeline:Record<string,number>={};const started=Date.now();const mark=(name:string)=>{timeline[name]=(Date.now()-started)/1000;};
let videoPath='',releaseDelayed=()=>{};
try{
 await page.goto(`${app.origin}/?task=${task.id}#${app.token}`);await page.getByText('Invented reference 000045.',{exact:false}).waitFor();await show();mark('partialStart');
 assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('body').innerText().then(t=>t.includes(app.token)),false);assert.equal(tasks.get(task.id).status,'working');assert.equal(posts,0);
 await page.locator('#task-mail-review').screenshot({path:join(output,'01-partial-draft.png')});await page.waitForTimeout(1200);
 await page.getByText('HTML alternative (shown as text, not executed)',{exact:true}).click();assert.equal(await page.locator('#task-mail-review img').count(),0);assert.equal(await page.evaluate(()=>Object.hasOwn(window,'__mailExecuted')),false);assert.deepEqual(outside,[]);await page.getByText('HTML alternative (shown as text, not executed)',{exact:true}).click();
 // A real fixture tool dispatch loses its ACK; viewing it must not run a model or rePOST.
 mail.approve(task.id,ref,'invented-owner-send');await invoke('mail.send',{draft:ref});const turnsBeforeReview=modelTurns;
 await page.getByRole('button',{name:'Refresh saved drafts'}).click();await page.getByText('Draft revision 1: Unknown send result — do not retry.',{exact:true}).waitFor();await show();mark('unknown');await page.locator('#task-mail-review').screenshot({path:join(output,'02-unknown-send.png')});await page.waitForTimeout(1600);assert.equal(posts,1);assert.equal(modelTurns,turnsBeforeReview);
 // Scripted LOCAL edit through the existing registered tool, NOT a shipped owner-correction UI.
 tasks.update(task.id,t=>{t.status='working';t.generation++;});await invoke('mail.draft.edit',{draft:ref,content:{...content,text:'Invented reference 000099. New local draft; the prior send is still unknown.'},provenanceIds:[]});
 await page.getByRole('button',{name:'Refresh saved drafts'}).click();await page.getByText('Invented reference 000099.',{exact:false}).waitFor();await show();mark('revision2');await page.locator('#task-mail-review').screenshot({path:join(output,'03-current-draft-prior-unknown.png')});await page.waitForTimeout(1600);
 assert.ok(await page.getByText('Local draft · revision 2',{exact:true}).isVisible());assert.ok(await page.getByText('Draft revision 1: Unknown send result — do not retry.',{exact:true}).isVisible());assert.equal(posts,1);
 await page.setViewportSize({width:390,height:844});await show();mark('phone');await page.locator('#task-mail-review').screenshot({path:join(output,'04-phone.png')});await page.getByText('Draft revision 1: Unknown send result — do not retry.',{exact:true}).scrollIntoViewIfNeeded();await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 mark('mediaEnd');
 // Delay an actual saved-draft read, then switch to a different persisted task.
 const second=tasks.admit({...ns,messageId:'second-invented',outcome:'Inspect a second task with no email draft'},8);await page.waitForFunction(()=>document.querySelectorAll('#tasks a').length===2);
 let received!:()=>void,release!:()=>void;const pending=new Promise<void>(r=>{received=r;}),gate=new Promise<void>(r=>{release=r;});releaseDelayed=release;let held=false;
 await page.route('**/api/task-mail?**',async route=>{if(held||new URL(route.request().url()).searchParams.get('taskId')!==task.id)return route.continue();held=true;const response=await route.fetch();received();await gate;await route.fulfill({response});});
 await page.getByRole('button',{name:'Refresh saved drafts'}).click();await pending;await page.locator('#tasks a').filter({hasText:second.requestedOutcome}).click();await page.getByText('No saved email draft yet.',{exact:false}).waitFor();release();await page.waitForTimeout(300);assert.equal(await page.locator('#task-mail-review').innerText().then(t=>t.includes('000099')),false);await page.unrouteAll({behavior:'wait'});
 assert.equal(posts,1);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
 videoPath=await page.video()!.path();
 const record={at:new Date().toISOString(),source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).trim(),proof:'INVENTED/SCRIPTED provider and HTTP; actual Task/MIME, private capability HTTP and sandboxed Chromium; NOT actual LLM/Gmail/owner correction/SharedGoogle account UI',scenario:'BeforeReady draft read→lost ACK status read→scripted local edit currentrev2/priorrev1unknown→phone→stale selection response denied',timeline,viewport:'1280x950 and390x844',chromium:browser.version(),browserSandbox:true,modelTurns,fixtureSendPosts:posts,extraPostsFromReview:0,htmlExecuted:false,externalPageRequests:outside.length,errors,rawVideo:videoPath,authNotPublished:true};writeFileSync(join(output,'result.json'),JSON.stringify(record,null,2)+'\n');
}finally{releaseDelayed();await context.close();await browser.close();await app.close();tasks.close();store.close();}
console.log('PASS private saved-mail readback/uncertainty/revision labels/phone/inert HTML/stale selection; fixture only');
