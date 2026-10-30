import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EvidenceStore, digest } from '../../core/evidence/store.js';
import type { ToolContext, ToolResult } from '../../core/agent/contracts.js';
import { createBrowserFormTools, type BrowserFormOptions, type BrowserSubmissionIntent, type BrowserWriteRequest } from '../../core/tools/browser-forms.js';
import { startPortal, type PortalConfig } from '../../examples/application-portal/server.js';
import { inventedPdf, inventedPng } from '../portal/fixtures.js';

const executablePath=process.env.SPINDLE_WEB_CHROMIUM ?? '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const scratch=process.env.RUCKSACK_SCRATCH_ROOT ?? '/home/ubuntu/.local/state/rucksack/scratch';
const revision={applicationId:'invented-application',revision:1,contentHash:digest(Buffer.from('reviewed invented revision'))};
interface View { snapshotRef:string; fields:{ref:string;label:string;type:string;options:{value:string;label:string}[];required:boolean}[]; actions:{ref:string;label:string;form:{action:string;method:string}}[] }

async function fixture(config?:PortalConfig,loseResponseOnce=false,extraHtml='') {
 mkdirSync(scratch,{recursive:true}); const root=mkdtempSync(join(scratch,'browser-forms-test-'));
 const portal=await startPortal(join(root,'portal'),config,{loseResponseOnce});
 const intentPath=join(root,'intent.json'),reviewedDigestPath=join(root,'reviewed-digest');
 const store=new EvidenceStore(join(root,'evidence'));
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true}).catch(async error=>{await portal.close();store.close();rmSync(root,{recursive:true,force:true});throw error;});
 try {
 const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
 let page=await context.newPage();
 page.on('popup',popup=>void popup.close());
 await context.routeWebSocket('**/*',socket=>socket.close());
 let approval=true,current=true,confinement=true,leaseCurrent=true,writeClass='',posts=0;
 const blocked:string[]=[];
 // Real fixture confinement, independent of the tool. No profile, external requests or unrelated tabs.
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  const allowed=url.origin===portal.origin && ((request.method()==='GET' && (url.pathname==='/' || /^\/receipts\/[a-f0-9]{64}$/.test(url.pathname))) || (request.method()==='POST' && url.pathname==='/applications' && writeClass==='submit' && approval && current && leaseCurrent && existsSync(intentPath)));
  if(!allowed){blocked.push(url.pathname);return route.abort('blockedbyclient');}
  if(request.method()==='POST'){
   const body=request.postDataBuffer();if(!body)return route.abort('blockedbyclient');
   const submitted=await new Request(request.url(),{method:'POST',headers:{'content-type':request.headers()['content-type']!},body:new Uint8Array(body)}).formData();
   const fields:Record<string,string>={},files:{name:string;filename:string;type:string;bytes:number;sha256:string}[]=[];
   for(const [name,value] of submitted){
    if(name==='idempotencyKey')continue;
    if(typeof value==='string')fields[name]=value;
    else files.push({name,filename:value.name,type:value.type,bytes:value.size,sha256:digest(new Uint8Array(await value.arrayBuffer()))});
   }
   if(digest(Buffer.from(JSON.stringify({fields,files})))!==readFileSync(reviewedDigestPath,'utf8'))return route.abort('blockedbyclient');
   // Chromium can transparently replay a failed POST beneath route.continue().
   // Host transport dispatches once with retries/redirects disabled, then returns the response.
   posts++;
   try {const response=await route.fetch({maxRetries:0,maxRedirects:0});await route.fulfill({response});}
   catch {await route.abort('failed');}
  }else if(extraHtml&&url.pathname==='/'){
   const response=await route.fetch({maxRetries:0,maxRedirects:0});const headers={...response.headers()};delete headers['content-security-policy'];
   await route.fulfill({response,headers,body:(await response.text()).replace('</form>',extraHtml+'</form>')});
  }else await route.continue();
 });
 await page.goto(portal.origin+'/');
 const ctx:ToolContext={callId:randomUUID(),taskId:'task',runId:'run',accountId:'a',workspaceId:'w',budget:{limit:100,used:0},applicationRevision:revision,signal:new AbortController().signal,isCurrent:()=>current,scope:{sources:[],destinations:[portal.origin+'/'],grants:[]}};
 let saved:BrowserSubmissionIntent|undefined;
 const requests:BrowserWriteRequest[]=[];
 const options:BrowserFormOptions={store,session:()=>({id:'owned-page',page,destination:portal.origin+'/',revision}),constrained:()=>confinement,
  authorize:async request=>{requests.push(request);if(!approval)return undefined;writeClass=request.operation;return {id:'trusted-capability',isCurrent:()=>approval&&current&&leaseCurrent,close:async outcome=>{writeClass='';if(outcome==='uncertain'){await page.close();page=await context.newPage();page.on('popup',popup=>void popup.close());}}};},
  uploadName:a=>a.mimeType==='application/pdf'?'invented.pdf':'invented.png',
  submissions:{
   claim:async request=>{
    if(existsSync(intentPath))return {intent:JSON.parse(readFileSync(intentPath,'utf8')) as BrowserSubmissionIntent,dispatch:false};
    const identity=await page.getByLabel('Submission identity').inputValue();
    saved={id:'host-intent',sessionId:request.sessionId,destination:request.destination,revision:request.revision,inputHash:request.inputHash,receiptUrl:portal.origin+'/receipts/'+digest(Buffer.from(identity)),state:'uncertain'};
    // Derive receipt content from actual authorized browser state, not a canned answer map.
    const input=request.input as {action:{action:{action:string;method:string}};fields:{field:{name:string;type:string};value:{values?:string[];files?:{name:string;mimeType:string;bytes:number;sha256:string}[]}}[]};
    assert.equal(input.action.action.action,portal.origin+'/applications');assert.equal(input.action.action.method,'post');
    const fields:Record<string,string>={},files:{name:string;filename:string;type:string;bytes:number;sha256:string}[]=[];
    for(const item of input.fields){
     if(item.field.name==='idempotencyKey')continue; // This portal's documented reconciliation identity.
     if(item.value.files)for(const file of item.value.files)files.push({name:item.field.name,filename:file.name,type:file.mimeType,bytes:file.bytes,sha256:file.sha256});
     else fields[item.field.name]=item.value.values?.[0]??'';
    }
    writeFileSync(reviewedDigestPath,digest(Buffer.from(JSON.stringify({fields,files}))));
    writeFileSync(intentPath+'.tmp',JSON.stringify(saved));renameSync(intentPath+'.tmp',intentPath);
    return {intent:saved,dispatch:true};
   },
   current:async()=>existsSync(intentPath)?JSON.parse(readFileSync(intentPath,'utf8')) as BrowserSubmissionIntent:undefined,
   record:async(intent,state)=>{saved={...intent,state};writeFileSync(intentPath,JSON.stringify(saved));}
  },
  readReceipt:async(p,intent)=>{
   // Site-specific receipt parser only. No expected form-answer map or tool decisions here.
   const record=JSON.parse(await p.locator('pre').innerText()) as {reference:string;status:string;digest:string};
   if(record.status!=='submitted'||!intent.receiptUrl.endsWith(record.reference)||record.digest!==readFileSync(reviewedDigestPath,'utf8'))return undefined;
   return {receiptId:record.reference,contentHash:record.digest,destination:intent.destination,revision:intent.revision};
  },timeoutMs:3000};
 let tools=createBrowserFormTools(options);
 assert.deepEqual(tools.filter(t=>t.effect==='external_write').map(t=>t.name),['browser.fill','browser.upload','browser.submit']);
 async function call(name:string,args:unknown):Promise<ToolResult>{const tool=tools.find(t=>t.name===name);assert.ok(tool,`Registered tool ${name}`);return tool.invoke(args,{...ctx,callId:randomUUID()});}
 const inspect=async()=>{const r=await call('browser.inspect',{});assert.equal(r.status,'ok',JSON.stringify(r));return r.data as View;};
 const add=(bytes:Buffer,mimeType:string)=>{const s=store.put(ctx,bytes,mimeType,[],{provider:'user',providerId:randomUUID(),providerVersion:digest(bytes)});ctx.scope.sources.push(s.source!);return s.artifact;};
 return {root,portal,get page(){return page;},store,ctx,options,requests,blocked,call,inspect,add,get posts(){return posts;},get intent(){return saved;},setApproval:(v:boolean)=>{approval=v;},setCurrent:(v:boolean)=>{current=v;},setConfinement:(v:boolean)=>{confinement=v;},setLeaseCurrent:(v:boolean)=>{leaseCurrent=v;},recreate:()=>{tools=createBrowserFormTools(options);},close:async()=>{try{await browser.close();}finally{try{await portal.close();}finally{store.close();rmSync(root,{recursive:true,force:true});}}}};
 }catch(error){await browser.close();await portal.close();store.close();rmSync(root,{recursive:true,force:true});throw error;}
}

const browserTest={skip:!existsSync(executablePath)};
test('registered tools inspect changed labels/order and persist real PDF/image bytes through receipt revisit (scripted, not model acceptance)',browserTest,async()=>{
 for(const variant of [0,1]) {
  const config:PortalConfig={title:'Invented varied form',fields:variant?[{name:'contact_z',label:'Reply address',required:true,type:'email'},{name:'visitor_z',label:'Preferred visitor',required:true}]:[{name:'person_a',label:'Participant identity',required:true},{name:'reply_a',label:'Contact mailbox',required:true,type:'email'}],attachments:variant?[{name:'portrait_z',label:'Supporting illustration',required:true,type:'image/png',maxBytes:50000},{name:'essay_z',label:'Workshop narrative',required:true,type:'application/pdf',maxBytes:50000}]:[{name:'document_a',label:'Written proposal',required:true,type:'application/pdf',maxBytes:50000},{name:'picture_a',label:'Reference picture',required:true,type:'image/png',maxBytes:50000}]};
  const f=await fixture(config);
  try {
   const view=await f.inspect();assert.equal(view.fields.length,5);assert.ok(view.fields.every(x=>!x.ref.includes(x.label)));assert.equal(view.actions[0]!.form.action,f.portal.origin+'/applications');assert.equal(view.actions[0]!.form.method,'post');
   for(const field of view.fields) {
    if(field.label.startsWith('Submission identity'))continue;
    if(field.type==='file') {const a=field.label.includes('application/pdf')?f.add(Buffer.from(inventedPdf()),'application/pdf'):f.add(inventedPng(),'image/png');assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:field.ref,artifactId:a.id})).status,'ok');}
    else {
     const filled=await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:field.ref,value:field.type==='email'?'invented@example.test':'Invented Visitor'});assert.equal(filled.status,'ok');assert.equal(filled.evidence.length,1);
     const audit=f.store.read(f.ctx,filled.artifacts[0]!.id).toString();assert.ok(!audit.includes('Invented Visitor')&&!audit.includes('invented@example.test'));assert.match(audit,/inputHash/);assert.match(audit,/outputHash/);
    }
   }
   const submit=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(submit.status,'ok',JSON.stringify(submit));
   assert.equal(f.posts,1);assert.match(f.page.url(),/\/receipts\//);
   if(variant===0){const parser=f.options.readReceipt;f.options.readReceipt=async()=>undefined;assert.equal((await f.call('browser.verify_submission',{})).error?.code,'RECEIPT_UNVERIFIED');assert.equal(f.intent?.state,'uncertain');f.options.readReceipt=parser;}
   const verified=await f.call('browser.verify_submission',{});assert.equal(verified.status,'ok',JSON.stringify(verified));assert.equal(f.intent?.state,'verified');
   const filename=readdirSync(join(f.root,'portal')).find(x=>x.endsWith('.json'))!;
   const persisted=JSON.parse(readFileSync(join(f.root,'portal',filename),'utf8')) as {fields:Record<string,string>;files:{sha256:string;type:string}[]};
   assert.ok(Object.values(persisted.fields).includes('Invented Visitor'));assert.ok(Object.values(persisted.fields).includes('invented@example.test'));
   for(const file of persisted.files){const bytes=readFileSync(join(f.root,'portal',file.sha256+'.upload'));assert.equal(digest(bytes),file.sha256);assert.deepEqual(bytes,file.type==='application/pdf'?Buffer.from(inventedPdf()):inventedPng());}
   const record=verified.artifacts[0]!;const audit=f.store.read(f.ctx,record.id).toString();assert.ok(!audit.includes('Invented Visitor'));assert.match(audit,/inputHash/);assert.match(audit,/outputHash/);
  } finally {await f.close();}
 }
});

test('approval, scope, revision, currency, cancellation, lease and transport denial precede every effect',browserTest,async()=>{
 const f=await fixture();try {
  const view=await f.inspect(),field=view.fields.find(x=>x.type==='text')!;
  const args={snapshotRef:view.snapshotRef,fieldRef:field.ref,value:'Must not be filled'};
  f.setApproval(false);assert.equal((await f.call('browser.fill',args)).error?.code,'AUTHORITY_REQUIRED');
  const pdf=f.add(Buffer.from(inventedPdf()),'application/pdf');assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:view.fields.find(x=>x.type==='file')!.ref,artifactId:pdf.id})).error?.code,'AUTHORITY_REQUIRED');
  assert.equal((await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref})).error?.code,'AUTHORITY_REQUIRED');
  f.setApproval(true);f.ctx.applicationRevision={...revision,revision:2};assert.equal((await f.call('browser.fill',args)).error?.code,'REVISION_CHANGED');f.ctx.applicationRevision=revision;
  f.ctx.scope={...f.ctx.scope,destinations:[]};assert.equal((await f.call('browser.fill',args)).error?.code,'DESTINATION_DENIED');f.ctx.scope={...f.ctx.scope,destinations:[f.portal.origin+'/']};
  f.setCurrent(false);assert.equal((await f.call('browser.fill',args)).error?.code,'CANCELLED_OR_STALE');f.setCurrent(true);
  f.setLeaseCurrent(false);assert.equal((await f.call('browser.fill',args)).error?.code,'AUTHORITY_REVOKED');f.setLeaseCurrent(true);
  f.setConfinement(false);assert.equal((await f.call('browser.fill',args)).error?.code,'UNCONSTRAINED_SESSION');f.setConfinement(true);
  f.ctx.signal=AbortSignal.abort();assert.equal((await f.call('browser.fill',args)).error?.code,'CANCELLED_OR_STALE');
  assert.equal(await f.page.getByLabel('Applicant name').inputValue(),'');assert.equal(f.posts,0);assert.equal(f.intent,undefined);
 }finally{await f.close();}
});

test('read-only inspection works before an application revision exists, but all writes require a reviewed revision',browserTest,async()=>{
 const f=await fixture();try {
  f.ctx.applicationRevision=undefined;
  f.options.session=()=>({id:'owned-page',page:f.page,destination:f.portal.origin+'/',revision:f.ctx.applicationRevision});
  const view=await f.inspect();
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Not reviewed'})).error?.code,'REVISION_REQUIRED');assert.equal(await f.page.locator('input').first().inputValue(),'');
 }finally{await f.close();}
});

test('fill really triggers page autosave code; constrained host blocks its unauthorized POST',browserTest,async()=>{
 const f=await fixture(undefined,false,'<script>document.querySelector("input").addEventListener("input",e=>{fetch("/unexpected-save",{method:"POST",body:e.target.value}).catch(()=>{});});</script>');
 try {
  const view=await f.inspect(),field=view.fields[0]!;
  const failed=f.page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/unexpected-save'),timeout:3000});
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:field.ref,value:'Invented autosave input'})).status,'ok');
  assert.ok((await failed).failure()?.errorText);assert.deepEqual(f.blocked,['/unexpected-save']);assert.equal(f.posts,0);assert.equal(await f.page.locator('input').first().inputValue(),'Invented autosave input');
 }finally{await f.close();}
});

test('strict schemas refuse arbitrary selector, JS, paths and forged refs; scoped immutable upload is required',browserTest,async()=>{
 const f=await fixture();try {
  const view=await f.inspect(),text=view.fields.find(x=>x.type==='text')!,file=view.fields.find(x=>x.type==='file')!;
  for(const args of [{selector:'input',value:'x'},{snapshotRef:view.snapshotRef,fieldRef:text.ref,value:'x',evaluate:'alert(1)'},{snapshotRef:view.snapshotRef,fieldRef:text.ref,value:{path:'/etc/passwd'}}])assert.equal((await f.call('browser.fill',args)).error?.code,'INVALID_ARGUMENTS');
  assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,path:'/etc/passwd'})).error?.code,'INVALID_ARGUMENTS');
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:'input[name=name]',value:'x'})).error?.code,'UNKNOWN_REF');
  const foreign=f.store.put({workspaceId:'other',accountId:'other'},Buffer.from(inventedPdf()),'application/pdf');
  assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,artifactId:foreign.artifact.id})).error?.code,'ARTIFACT_DENIED');
  const ungranted=f.store.put(f.ctx,Buffer.from(inventedPdf()),'application/pdf');assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,artifactId:ungranted.artifact.id})).error?.code,'ARTIFACT_DENIED');
  assert.equal(f.requests.length,0);assert.equal(await f.page.getByLabel('Applicant name').inputValue(),'');
 }finally{await f.close();}
});

test('identical replacement, changed labels/actions and ambiguous form targets require fresh inspection',browserTest,async()=>{
 const f=await fixture();try {
  let view=await f.inspect();const args=()=>({snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'No stale fill'});
  await f.page.locator('input').first().evaluate(el=>el.replaceWith(el.cloneNode(true)));
  assert.equal((await f.call('browser.fill',args())).error?.code,'STALE_DOM');
  view=await f.inspect();await f.page.locator('input').first().evaluate(el=>el.setAttribute('required',''));
  await f.page.locator('button').evaluate(el=>el.setAttribute('formaction','https://example.invalid/'));
  assert.equal((await f.call('browser.fill',args())).error?.code,'STALE_DOM');
  await f.page.reload();await f.page.locator('form').evaluate(el=>el.appendChild(el.querySelector('button')!.cloneNode(true)));
  const ambiguous=await f.call('browser.inspect',{});assert.equal(ambiguous.error?.code,'AMBIGUOUS_ACTION');assert.equal(f.posts,0);
 }finally{await f.close();}
});

test('opaque refs support select, checkbox, textarea and input-submit without label/selector arguments',browserTest,async()=>{
 const f=await fixture();try {
  await f.page.locator('form').evaluate(form=>{
   form.insertAdjacentHTML('beforeend','<label>Session choice<select name="unpredictable_choice" required><option value="">Choose</option><option value="evening">After work</option><option value="closed" disabled>Unavailable</option></select></label><label>Invented consent<input type="checkbox" name="different_flag"></label><label>Workshop notes<textarea name="novel_notes"></textarea></label>');
   const button=form.querySelector('button')!;const input=document.createElement('input');input.type='submit';input.value='Send invented form';button.replaceWith(input);
  });
  const view=await f.inspect();assert.equal(view.actions[0]!.label,'Send invented form');assert.equal(view.actions[0]!.form.action,f.portal.origin+'/applications');
  const select=view.fields.find(x=>x.type==='select-one')!;assert.deepEqual(select.options.map(x=>x.label),['Choose','After work','Unavailable']);
  const args={snapshotRef:view.snapshotRef,fieldRef:select.ref};
  assert.equal((await f.call('browser.fill',{...args,value:'After work'})).error?.code,'INVALID_VALUE');
  assert.equal((await f.call('browser.fill',{...args,value:'closed'})).error?.code,'INVALID_VALUE');
  assert.equal((await f.call('browser.fill',{...args,value:'evening'})).status,'ok');
  const flag=view.fields.find(x=>x.type==='checkbox')!,notes=view.fields.find(x=>x.type==='textarea')!;
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:flag.ref,value:true})).status,'ok');
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:notes.ref,value:'Invented multiline\nnotes'})).status,'ok');
  assert.equal(await f.page.getByLabel('Session choice').inputValue(),'evening');assert.equal(await f.page.getByLabel('Invented consent').isChecked(),true);assert.equal(await f.page.getByLabel('Workshop notes').inputValue(),'Invented multiline\nnotes');
 }finally{await f.close();}
});

test('host compares actual values and fences DOM/currency changes during authorization before action',browserTest,async()=>{
 const f=await fixture();try {
  const view=await f.inspect(),args={snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'};
  const authorize=f.options.authorize;
  f.options.authorize=async(request,context)=>(request.input as {value?:unknown}).value===args.value?authorize(request,context):undefined;
  assert.equal((await f.call('browser.fill',{...args,value:'Unreviewed invented value'})).error?.code,'AUTHORITY_REQUIRED');
  f.options.authorize=async(request,context)=>{const lease=await authorize(request,context);await f.page.locator('input').first().evaluate(el=>el.setAttribute('name','changed_during_approval'));return lease;};
  assert.equal((await f.call('browser.fill',args)).error?.code,'STALE_DOM');assert.equal(await f.page.locator('input').first().inputValue(),'');
  await f.page.reload();const fresh=await f.inspect();
  f.options.authorize=async(request,context)=>{const lease=await authorize(request,context);f.setCurrent(false);return lease;};
  assert.equal((await f.call('browser.fill',{...args,snapshotRef:fresh.snapshotRef,fieldRef:fresh.fields[0]!.ref})).error?.code,'CANCELLED_OR_STALE');assert.equal(await f.page.locator('input').first().inputValue(),'');assert.equal(f.posts,0);
 }finally{await f.close();}
});

test('late host grants are closed after cancellation/deadline and cannot fill the page',browserTest,async()=>{
 for(const cancel of [true,false]){
  const f=await fixture();try {
   f.options.timeoutMs=500;f.recreate();const view=await f.inspect();
   const controller=new AbortController();f.ctx.signal=controller.signal;
   let grant!:(lease:Awaited<ReturnType<BrowserFormOptions['authorize']>>)=>void,started!:()=>void,closed!:()=>void;
   const ready=new Promise<void>(resolve=>{started=resolve;}),ended=new Promise<void>(resolve=>{closed=resolve;});
   f.options.authorize=()=>{started();return new Promise(resolve=>{grant=resolve;});};
   const pending=f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Never applied'});
   await ready;if(cancel)controller.abort();
   const result=await pending;assert.equal(result.error?.code,cancel?'CANCELLED_OR_STALE':'DEADLINE_EXCEEDED');
   grant({id:'late-grant',isCurrent:()=>true,close:async outcome=>{assert.equal(outcome,'not_dispatched');closed();}});await ended;
   assert.equal(await f.page.locator('input').first().inputValue(),'');assert.equal(f.posts,0);
  }finally{await f.close();}
 }
});

test('tampered immutable upload bytes fail closed and unbound receipts never become verified',browserTest,async()=>{
 const f=await fixture();try {
  const view=await f.inspect(),file=view.fields.find(x=>x.type==='file')!;
  const pdf=f.add(Buffer.from(inventedPdf()),'application/pdf');writeFileSync(join(f.root,'evidence','artifacts',pdf.id),'not the reviewed PDF');
  assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,artifactId:pdf.id})).error?.code,'ARTIFACT_DENIED');assert.equal(f.requests.length,0);
  assert.equal((await f.call('browser.verify_submission',{})).error?.code,'NO_SUBMISSION_INTENT');
  const other={id:'bad-intent',sessionId:'owned-page',destination:f.portal.origin+'/',revision,inputHash:digest(Buffer.from('x')),receiptUrl:'https://example.invalid/receipt',state:'uncertain' as const};
  f.options.submissions.current=async()=>other;
  assert.equal((await f.call('browser.verify_submission',{})).error?.code,'RECEIPT_DENIED');
  f.options.submissions.current=async()=>({...other,receiptUrl:f.portal.origin+'/receipts/'+digest(Buffer.from('missing'))});
  assert.equal((await f.call('browser.verify_submission',{})).error?.code,'RECEIPT_UNVERIFIED');assert.equal(f.posts,0);
 }finally{await f.close();}
});

test('page submit handler cannot send a changed unreviewed payload through the constrained host',browserTest,async()=>{
 const f=await fixture();try {
  await f.page.locator('form').evaluate(form=>form.addEventListener('submit',()=>{form.querySelector('input')!.value='Page-tampered invented value';}));
  const view=await f.inspect(),file=view.fields.find(x=>x.type==='file')!;
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'})).status,'ok');
  const pdf=f.add(Buffer.from(inventedPdf()),'application/pdf');assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,artifactId:pdf.id})).status,'ok');
  assert.equal((await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref})).error?.code,'SUBMISSION_UNCERTAIN');
  assert.equal(f.posts,0);assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,0);
  assert.equal((await f.call('browser.verify_submission',{})).error?.code,'RECEIPT_UNVERIFIED');
 }finally{await f.close();}
});

test('lost response persists one server record; duplicate and restarted submission never POST again; verify safely revisits',browserTest,async()=>{
 const f=await fixture(undefined,true);try {
  const view=await f.inspect();const text=view.fields.find(x=>x.label.startsWith('Applicant'))!,file=view.fields.find(x=>x.type==='file')!;
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:text.ref,value:'Invented Uncertain'})).status,'ok');
  const pdf=f.add(Buffer.from(inventedPdf()),'application/pdf');assert.equal((await f.call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:file.ref,artifactId:pdf.id})).status,'ok');
  const submitArgs={snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref};
  const [first,overlapping]=await Promise.all([f.call('browser.submit',submitArgs),f.call('browser.submit',submitArgs)]);assert.equal(overlapping.error?.code,'SESSION_BUSY');assert.equal(f.posts,1,JSON.stringify({first,posts:f.posts}));assert.equal(first.status,'needs_input');assert.equal(first.error?.code,'SUBMISSION_UNCERTAIN');
  assert.equal((await f.call('browser.submit',submitArgs)).error?.code,'RECONCILIATION_REQUIRED');assert.equal(f.posts,1);
  f.recreate();assert.equal((await f.call('browser.submit',submitArgs)).error?.code,'RECONCILIATION_REQUIRED');assert.equal(f.posts,1);
  const verified=await f.call('browser.verify_submission',{});assert.equal(verified.status,'ok',JSON.stringify(verified));assert.equal(f.posts,1);
  assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);
 }finally{await f.close();}
});
