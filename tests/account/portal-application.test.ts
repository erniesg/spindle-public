import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationArtifactBinding} from '../../core/preparation/artifact-binding.js';
import type {PreparationPortal} from '../../core/preparation/browser-review.js';
import {mountApplication,applicationErrorMessage,applicationArtifactGroups,applicationAuthFailure} from '../../core/account/portal/application.js';
import {inventedPdf,inventedPng} from '../portal/fixtures.js';
import {fictionalPortalTarget} from '../../core/preparation/fictional-portal.js';
import type {PreparationBrowserContinuation} from '../../core/preparation/portal-production.js';

// FIXTURE DOM: a minimal element tree so the view runs under node:test. It is not a
// browser; the real Chromium journey is tests/account/portal-application.e2e.ts.
type Listener={fn:(e:unknown)=>void;once?:boolean};
class FakeElement {
 children:(FakeElement|string)[]=[];parent?:FakeElement;attributes=new Map<string,string>();dataset:Record<string,string>={};listeners=new Map<string,Listener[]>();
 className='';hidden=false;disabled=false;readOnly=false;value='';checked=false;type='';href='';download='';src='';alt='';target='';rel='';title='';placeholder='';rows=0;maxLength=0;
 constructor(readonly tagName:string,readonly ownerDocument:FakeDocument){}
 get textContent():string{return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 set textContent(v:string){this.replaceChildren(v);}
 append(...nodes:(FakeElement|string)[]){for(const n of nodes){if(n instanceof FakeElement){n.parent?.children.splice(n.parent.children.indexOf(n),1);n.parent=this;}this.children.push(n);}}
 replaceChildren(...nodes:(FakeElement|string)[]){for(const c of this.children)if(c instanceof FakeElement)c.parent=undefined;this.children=[];this.append(...nodes);}
 setAttribute(k:string,v:string){this.attributes.set(k,v);}
 getAttribute(k:string){return this.attributes.get(k)??null;}
 addEventListener(type:string,fn:(e:unknown)=>void,options?:{signal?:AbortSignal;once?:boolean}){if(options?.signal?.aborted)return;const entry={fn,once:options?.once};(this.listeners.get(type)??this.listeners.set(type,[]).get(type)!).push(entry);options?.signal?.addEventListener('abort',()=>{const list=this.listeners.get(type)!;list.splice(list.indexOf(entry),1);});}
 dispatch(type:string){for(const l of [...this.listeners.get(type)??[]]){if(l.once)this.listeners.get(type)!.splice(this.listeners.get(type)!.indexOf(l),1);l.fn({type});}}
 click(){if(!this.disabled)this.dispatch('click');}
 listenerCount(){return [...this.listeners.values()].reduce((n,l)=>n+l.length,0)+this.elements().reduce((n,e)=>n+[...e.listeners.values()].reduce((m,l)=>m+l.length,0),0);}
 elements():FakeElement[]{return this.children.flatMap(c=>typeof c==='string'?[]:[c,...c.elements()]);}
 matches(selector:string){return selector.split(',').map(s=>s.trim()).some(s=>s.startsWith('.')?this.className.split(' ').includes(s.slice(1)):s.startsWith('[data-')?Object.hasOwn(this.dataset,s.slice(6,-1).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())):this.tagName===s);}
 querySelectorAll(selector:string){return this.elements().filter(e=>e.matches(selector));}
 querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
}
class FakeDocument {createElement(tag:string){return new FakeElement(tag,this);}}
const find=(root:FakeElement,selector:string,text?:string|RegExp)=>{const found=root.querySelectorAll(selector).find(e=>text===undefined||(typeof text==='string'?e.textContent.includes(text):text.test(e.textContent)));assert.ok(found,`missing ${selector} ${text??''}\n${root.textContent}`);return found;};
// Waits for the condition AND for the view's single in-flight action to finish.
async function until(check:()=>boolean,what:string,root?:FakeElement){for(let i=0;i<400;i++){if(check()&&(!root||root.querySelector('.application')?.getAttribute('aria-busy')==='false'))return;await new Promise(r=>setTimeout(r,5));}assert.fail('timed out waiting for '+what);}

// Real account HTTP server, client, AgentStore and EvidenceStore. Invented prepared task
// stored directly (no model, Google or browser calls happen in these tests).
async function fixture(options:{configured?:boolean;paused?:boolean;preparation?:boolean;continuation?:boolean;transport?:typeof fetch}={}){
 const root=process.env.RUCKSACK_SCRATCH_ROOT??join(homedir(),'.local/state/rucksack/scratch/spindle-account-tests');mkdirSync(root,{recursive:true});
 const directory=mkdtempSync(join(root,'portal-application-')),key=Buffer.alloc(32,75),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
 const portal:PreparationPortal={destination:'http://127.0.0.1:43198/',submissionUrl:'http://127.0.0.1:43198/applications',receiptUrl:'http://127.0.0.1:43198/receipts/invented',encoding:'multipart'};
 let calls=0;
 // FIXTURE continuation: trusted fictional target/mapping, but no browser, model or receipt parser is ever reachable.
 const continuation:PreparationBrowserContinuation={mode:'developer_fictional',destination:'http://127.0.0.1:43198/',allowLoopback:true,browserTimeoutMs:1000,timeoutMs:1000,maxTurns:1,
  target:(t,s,n)=>fictionalPortalTarget('http://127.0.0.1:43198',{fields:[{fieldId:'name',name:'applicant_name'},{fieldId:'reference',name:'contact_email'},{fieldId:'programme',name:'programme'}]},t,s,n),
  browser:async()=>{calls++;throw Error('Unexpected browser');},readReceipt:async()=>{calls++;throw Error('Unexpected receipt read');},provider:()=>{calls++;throw Error('Unexpected model');},close:async()=>{}};
 const server=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http:async()=>{calls++;throw Error('Unexpected Google call');}},options.preparation===false?undefined:{tasks,store,workspaceId:'invented-workspace',buildIdentity:'invented-application-view',processingPaused:options.paused??true,browserPortal:options.configured===false||options.continuation?undefined:portal,...(options.continuation?{browserContinuation:continuation}:{}),provider:()=>{calls++;throw Error('Unexpected model');},tools:()=>{calls++;throw Error('Unexpected execution');}});
 const client=new AccountClient(server.origin,options.transport);
 const close=async()=>{await server.close();tasks.close();store.close();rmSync(directory,{recursive:true,force:true});};
 try{
  await client.signin('invented-application-owner','invented-password-123',true);
  if(options.preparation===false)return {client,server,tasks,store,close,calls:()=>calls} as never;
  const ns={workspaceId:'invented-workspace',accountId:client.account!.id};
  const source=store.put(ns,Buffer.from('Invented acceptance email: participant Mira, reference 000045'),'text/plain',[],{provider:'user',providerId:'invented-source',providerVersion:'1'});
  const oldPdf=store.put(ns,Buffer.from(inventedPdf().replace('%PDF-1.4','%PDF-1.4\n%old')),'application/pdf',[source.artifact.id]),pdf=store.put(ns,Buffer.from(inventedPdf()),'application/pdf',[source.artifact.id]),photo=store.put(ns,inventedPng(),'image/png',[source.artifact.id]);
  const task=tasks.admit({...ns,messageId:'invented-application',outcome:'Register for the invented workshop'},128);
  tasks.update(task.id,t=>{
   t.status='blocked';t.nextAction='Review the prepared registration';t.checklist={revision:1,reason:'invented',items:[{id:'read',title:'Read acceptance email',state:'done',dependsOn:[]},{id:'fill',title:'Fill registration form',state:'done',dependsOn:['read']}]} as never;
   t.applicationRevision={applicationId:t.id,revision:2,contentHash:'invented-revision'};
   const fields=[{id:'name',label:'Full name',value:'Mira Corrected',corrected:true,unresolved:false,citations:[{artifactId:source.artifact.id,sourceId:source.source!.id,sourceVersion:'1'}]},{id:'reference',label:'Participant reference',value:'000045',unresolved:false,citations:[]}];
   t.preparation={connectionId:'invented-connection',rootId:'invented-root',incarnation:'invented-incarnation',rootRevision:1,googleAccountId:'invented@example.test',requestId:'invented-request',request:'Register for the invented workshop',revision:2,processingConsent:true,saveOutputs:false,sources:[source.source!],sourceNames:{'invented-source':'Acceptance email'},artifactIds:[source.artifact.id,oldPdf.artifact.id,pdf.artifact.id,photo.artifact.id],artifactRevisions:{[oldPdf.artifact.id]:1,[pdf.artifact.id]:2,[photo.artifact.id]:2},fields,revisions:[{revision:2,fieldId:'name',value:'Mira Corrected'}],uploads:[],modelBudget:{limitUsd:.3,maximumDecisionCalls:16,maximumVisionCalls:3,decisionCalls:0,visionCalls:0,reservedUsd:0}};
   const before={...t.preparation,revision:1,fields:fields.map(f=>f.id==='name'?{...f,value:'Mira Original',corrected:false}:f)};
   t.preparation.artifactBindings={[oldPdf.artifact.id]:preparationArtifactBinding(before,oldPdf.artifact.sha256,['name']),[pdf.artifact.id]:preparationArtifactBinding(t.preparation,pdf.artifact.sha256,['name']),[photo.artifact.id]:preparationArtifactBinding(t.preparation,photo.artifact.sha256,['name'])};
  });
  return {client,server,tasks,store,taskId:task.id,ns,source,oldPdf,pdf,photo,portal,close,calls:()=>calls};
 }catch(error){await close();throw error;}
}
function mount(client:AccountClient){
 const doc=new FakeDocument(),root=doc.createElement('main'),controller=new AbortController(),errors:unknown[]=[];
 const unmount=mountApplication({root:root as unknown as HTMLElement,client,signal:controller.signal,onError:e=>errors.push(e)});
 return {root,controller,errors,unmount};
}
const tracked=()=>{const created:string[]=[],revoked:string[]=[];const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
 URL.createObjectURL=(b:Blob)=>{const u=create(b);created.push(u);return u;};URL.revokeObjectURL=(u:string)=>{revoked.push(u);revoke(u);};
 return {created,revoked,restore(){URL.createObjectURL=create;URL.revokeObjectURL=revoke;}};};

test('signed-in workspace lists the real task, shows current answers, citations, verified previews and survives remount',async()=>{
 const f=await fixture(),urls=tracked();try{
  let view=mount(f.client);
  await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  find(view.root,'[data-application-task]','Register for the invented workshop').click();
  await until(()=>view.root.querySelectorAll('[data-application-field]').length===2,'fields',view.root);
  const review=find(view.root,'.application-review');
  assert.equal(review.dataset.applicationRevision,'2');assert.match(review.textContent,/Needs attention[\s\S]*Next: Review the prepared registration/);assert.match(review.textContent,/Read acceptance email/);
  const name=find(view.root,'[data-application-field]','Full name');assert.equal(find(name,'input').value,'Mira Corrected');assert.match(name.textContent,/Corrected by you/);
  assert.match(find(view.root,'.application-history').textContent,/Revision 2 · Correction name: Mira Corrected/);
  // Current versus historical outputs come from the backend's binding check.
  const files=find(view.root,'.application-files');
  assert.deepEqual(files.querySelectorAll('.is-current').map(e=>e.dataset.applicationArtifact).sort(),[f.pdf.artifact.id,f.photo.artifact.id].sort());
  assert.equal(find(files,'.application-historical').querySelectorAll('[data-application-artifact]')[0]!.dataset.applicationArtifact,f.oldPdf.artifact.id);
  // Citation opens the exact source snapshot as inert text.
  find(name,'.application-citation','Acceptance email').click();
  await until(()=>!!view.root.querySelector('.application-preview-text'),'citation preview',view.root);
  assert.match(find(view.root,'.application-source').textContent,/SHA-256 verified[\s\S]*participant Mira/);
  // Photo preview: exact bytes behind a blob URL, revoked when replaced.
  find(files.querySelectorAll('[data-application-artifact]').find(e=>e.dataset.applicationArtifact===f.photo.artifact.id)!,'.application-preview').click();
  await until(()=>!!view.root.querySelector('.application-preview-image'),'photo preview',view.root);
  const img=find(view.root,'.application-preview-image'),download=find(view.root,'.application-download');
  assert.equal(img.src,download.href);assert.match(download.download,/\.png$/);assert.match(find(view.root,'.application-source').textContent,/SHA-256 verified PNG image · 69 B/);
  assert.deepEqual(new Uint8Array(await (await fetch(img.src)).arrayBuffer()),new Uint8Array(inventedPng()));
  assert.equal(urls.revoked.length,1,'citation URL revoked when photo replaced it');
  find(files.querySelectorAll('[data-application-artifact]').find(e=>e.dataset.applicationArtifact===f.pdf.artifact.id)!,'.application-preview').click();
  await until(()=>!!view.root.querySelector('.application-preview-pdf'),'pdf preview',view.root);assert.match(find(view.root,'.application-download').download,/\.pdf$/);
  // Unmount stops listeners, revokes every Blob URL and leaves no stale view.
  view.unmount();assert.equal(view.root.children.length,0);assert.deepEqual([...urls.revoked].sort(),[...urls.created].sort());
  // Reload: a fresh mount reads the same persisted backend state.
  view=mount(f.client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list after remount',view.root);
  find(view.root,'[data-application-task]').click();await until(()=>view.root.querySelectorAll('[data-application-field]').length===2,'fields after remount',view.root);
  assert.equal(find(view.root,'[data-application-field]','Full name').querySelector('input')!.value,'Mira Corrected');
  view.controller.abort();assert.equal(view.root.children.length,0);
  assert.equal(f.calls(),0,'no Google, model or execution call');assert.deepEqual(view.errors,[]);
 }finally{urls.restore();await f.close();}
});

test('stale correction reloads the current revision, keeps the user text visible and never saves it',async()=>{
 const f=await fixture({paused:false});try{
  const view=mount(f.client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  find(view.root,'[data-application-task]').click();await until(()=>view.root.querySelectorAll('[data-application-field]').length===2,'fields',view.root);
  // Another device corrects first: the server revision moves on behind this view.
  f.tasks.update(f.taskId,t=>{t.preparation!.revision=3;t.preparation!.fields[1]!.value='000046';t.applicationRevision={applicationId:t.id,revision:3,contentHash:'invented-other-device'};});
  const row=find(view.root,'[data-application-field]','Participant reference'),input=find(row,'input');
  input.value='000099';input.dispatch('input');find(row,'.application-save').click();
  await until(()=>find(view.root,'.application-review').dataset.applicationRevision==='3','reload after conflict',view.root);
  assert.match(find(view.root,'.application-notice').textContent,/changed since you opened it/);
  const after=find(view.root,'[data-application-field]','Participant reference');
  assert.equal(find(after,'input').value,'000046');assert.match(after.textContent,/Your unsaved text was: 000099/);
  assert.equal(f.tasks.get(f.taskId).preparation!.fields[1]!.value,'000046');assert.equal(f.calls(),0);
  view.unmount();
 }finally{await f.close();}
});

test('paused processing holds corrections; submission stays explicitly unavailable; destination check is read-only',async()=>{
 for(const configured of [true,false]){const f=await fixture({configured});try{
  const view=mount(f.client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  assert.match(find(view.root,'.application-paused').textContent,/Preparation is temporarily unavailable/);assert.equal(find(view.root,'.application-paused').hidden,false);
  find(view.root,'[data-application-task]').click();await until(()=>view.root.querySelectorAll('[data-application-field]').length===2,'fields',view.root);
  const save=find(view.root,'.application-save');assert.equal(save.disabled,true);assert.equal(find(view.root,'[data-application-field]').querySelector('input')!.readOnly,true);
  const approve=find(view.root,'.application-approve');assert.equal(approve.disabled,true);assert.match(approve.textContent,/unavailable/);
  const before=JSON.stringify(f.tasks.get(f.taskId));
  find(view.root,'.application-destination').click();await until(()=>!!view.root.querySelector('.application-destination-result'),'destination',view.root);
  const result=find(view.root,'.application-destination-result').textContent;
  if(configured)assert.match(result,new RegExp('Revision 2 would go to '+f.portal.destination.replaceAll('.','\\.')));else assert.match(result,/No trusted submission destination/);
  assert.equal(JSON.stringify(f.tasks.get(f.taskId)),before,'read-only');assert.equal(f.calls(),0);view.unmount();
 }finally{await f.close();}}
});

test('empty, other-account and unconfigured states are truthful; abort drops late replies',async()=>{
 const f=await fixture({paused:false});try{
  const other=new AccountClient(f.server.origin);await other.signin('invented-other-owner','invented-password-123',true);
  const view=mount(other);await until(()=>!!view.root.querySelector('.application-empty'),'empty state',view.root);
  assert.match(find(view.root,'.application-tasks').textContent,/No application tasks for this account yet/);
  assert.equal(view.root.querySelector('[data-application-task]'),null,'another account never sees this task');
  assert.match(find(view.root,'.application-request').textContent,/Connect Google and choose a source folder first/);view.unmount();
  // Abort mid-flight: nothing paints after the shell cancels.
  const late=mount(f.client);late.controller.abort();await new Promise(r=>setTimeout(r,100));assert.equal(late.root.children.length,0);assert.deepEqual(late.errors,[]);
 }finally{await f.close();}
 const bare=await fixture({preparation:false});try{
  const view=mount(bare.client);await until(()=>!!view.root.querySelector('.application-unsupported'),'unsupported',view.root);
  assert.match(view.root.textContent,/not available yet/);assert.equal(find(view.root,'.application-review').hidden,true);assert.equal(find(view.root,'.application-source').hidden,true);assert.equal(find(view.root,'.application-setup-link').href,'/connections');view.unmount();
 }finally{await bare.close();}
});

test('fixed protocol messages only; sign-out hands authority back to the shell',async()=>{
 for(const status of [403,503])assert.equal(applicationAuthFailure(Object.assign(Error('unavailable'),{status,code:'CSRF_DENIED'})),false);
 assert.equal(applicationAuthFailure(Object.assign(Error('expired'),{status:401})),true);
 assert.match(applicationErrorMessage(Object.assign(Error('x'),{code:'STALE_PREPARATION_REVISION'})),/changed since you opened it/);
 assert.equal(applicationErrorMessage(Error('<img src=x onerror=alert(1)>')),'This action is not available right now. Your account and retained work are unchanged; nothing was retried automatically.');
 assert.deepEqual(applicationArtifactGroups({sources:[{snapshotArtifactId:'s'}] as never,artifacts:[{id:'s',mimeType:'text/plain',sha256:'',bytes:1},{id:'a',mimeType:'image/png',sha256:'',bytes:1,current:true},{id:'b',mimeType:'application/pdf',sha256:'',bytes:1,current:false},{id:'c',mimeType:'application/json',sha256:'',bytes:1}]}).current.map(a=>a.id),['a']);
 const f=await fixture();try{
  const view=mount(f.client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  // The server session ends while this tab still holds its identity (expiry/other-tab logout).
  await f.client.request('/logout',{});find(view.root,'[data-application-task]').click();
  await until(()=>view.errors.length===1,'shell notified',view.root);assert.match(String(view.errors[0]),/SIGNIN_REQUIRED/);view.unmount();
 }finally{await f.close();}
});

test('a status reply arriving after the shell aborts never paints the detached view',async()=>{
 const f=await fixture();try{
  // FIXTURE TRANSPORT: real server, but the status reply is held and delivered even after abort.
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let held=false;
  const client=new AccountClient(f.server.origin,async(input,init)=>{if(String(input).endsWith('/preparation/status')){held=true;await gate;return fetch(input,{...init,signal:undefined});}return fetch(input,init);});
  await client.signin('invented-application-owner','invented-password-123');
  const view=mount(client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  const review=find(view.root,'.application-review');find(view.root,'[data-application-task]').click();
  await until(()=>held,'status request held');view.controller.abort();release();await new Promise(r=>setTimeout(r,150));
  assert.equal(review.dataset.applicationRevision,undefined);assert.equal(review.querySelectorAll('[data-application-field]').length,0);assert.deepEqual(view.errors,[]);
 }finally{await f.close();}
});

test('configured approval shows the exact server-owned review and sends only the displayed fingerprint/revision/request id; receipt check is read-only',async()=>{
 const sent:{path:string;body:any}[]=[];
 const transport:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path.startsWith('/preparation/browser-'))sent.push({path,body:JSON.parse(String(init?.body))});return fetch(input,init);};
 const f=await fixture({paused:false,continuation:true,transport});try{
  f.tasks.update(f.taskId,t=>{t.status='ready';t.preparation!.fields.push({id:'programme',label:'Programme',value:'Invented Weaving Workshop',unresolved:false,citations:[]});});
  const view=mount(f.client);await until(()=>!!view.root.querySelector('[data-application-task]'),'task list',view.root);
  find(view.root,'[data-application-task]').click();await until(()=>view.root.querySelectorAll('[data-application-field]').length===3,'fields',view.root);
  const approve=find(view.root,'.application-approve');assert.equal(approve.disabled,true,'needs a displayed review first');assert.match(approve.textContent,/Approve and submit this exact review/);
  find(view.root,'.application-destination').click();await until(()=>!!view.root.querySelector('.application-review-plan'),'review plan',view.root);
  const plan=find(view.root,'.application-review-plan'),text=plan.textContent;
  for(const value of ['http://127.0.0.1:43198/applications','applicant_name ← Full name','Mira Corrected','Corrected by you','contact_email ← Participant reference','000045','programme ← Programme','Invented Weaving Workshop','idempotencyKey (set by Spindle)','spindle-'+f.taskId,'statement ← statement.pdf',f.pdf.artifact.sha256,'photo ← photo.png',f.photo.artifact.sha256])assert.ok(text.includes(value),value+' in '+text);
  assert.ok(!text.includes(f.oldPdf.artifact.sha256),'earlier-revision PDF is never offered');
  assert.deepEqual(sent[0],{path:'/preparation/browser-review',body:{taskId:f.taskId,expectedRevision:2,fields:[],files:[]}});
  const fingerprint=plan.dataset.applicationFingerprint!;assert.match(fingerprint,/^[a-f0-9]{64}$/);
  const approveNow=find(view.root,'.application-approve');assert.equal(approveNow.disabled,false);
  approveNow.click();await until(()=>sent.length===2&&/Google connection/.test(find(view.root,'.application-notice').textContent),'approval refused at binding',view.root);
  find(view.root,'.application-approve').click();await until(()=>sent.length===3,'retry',view.root);
  const [first,retry]=[sent[1]!,sent[2]!];assert.equal(first.path,'/preparation/browser-approve');
  assert.deepEqual(Object.keys(first.body).sort(),['expectedRevision','fingerprint','requestId','taskId']);
  assert.equal(first.body.fingerprint,fingerprint);assert.equal(first.body.expectedRevision,2);assert.equal(retry.body.requestId,first.body.requestId,'a retry replays the same owner decision');
  // A retained uncertain submission offers only the read-only receipt check, never approve.
  f.tasks.update(f.taskId,t=>{t.status='blocked';t.browser={approvalHistory:{version:1,requests:[]},writes:{},recovery:'clean',submission:{intent:{id:'invented-intent',sessionId:'s',destination:'http://127.0.0.1:43198/',revision:t.applicationRevision!,inputHash:'h',receiptUrl:'http://127.0.0.1:43198/receipts/x',state:'uncertain'},approvalId:'a',reviewArtifact:f.pdf.artifact,callId:'c',state:'uncertain',artifacts:[],uncertaintyCount:0}} as never;});
  find(view.root,'.application-refresh').click();await until(()=>!!view.root.querySelector('.application-reconcile'),'receipt check',view.root);
  assert.match(find(view.root,'.application-receipt').textContent,/Outcome unknown[\s\S]*never resubmits/);assert.equal(find(view.root,'.application-approve').disabled,true);
  find(view.root,'.application-reconcile').click();await until(()=>sent.length===4,'reconcile sent',view.root);
  assert.deepEqual(sent[3],{path:'/preparation/browser-reconcile',body:{taskId:f.taskId}});
  assert.equal(f.calls(),0,'no browser, model, receipt parser or Google HTTP reached');view.unmount();
 }finally{await f.close();}
});
