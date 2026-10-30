import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { EvidenceStore, digest } from '../../core/evidence/store.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import type { ApplicationRevisionRef, ToolContext, ToolResult } from '../../core/agent/contracts.js';
import { createBrowserFormTools, type BrowserSubmissionIntent } from '../../core/tools/browser-forms.js';
import { createBrowserFormHost, type BrowserFormHostConfig, type BrowserHostGrant } from '../../core/tools/browser-form-host.js';
import { startPortal, type PortalConfig } from '../../examples/application-portal/server.js';
import { inventedPdf, inventedPng } from '../portal/fixtures.js';

const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
const scratch=process.env.TMPDIR??process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch';
const browserTest={skip:!existsSync(executablePath)};
const revision:ApplicationRevisionRef={applicationId:'invented',revision:1,contentHash:digest(Buffer.from('reviewed invented revision'))};
interface View {snapshotRef:string;fields:{ref:string;type:string;label:string;name:string;accept:string|null}[];actions:{ref:string}[]}
interface SubmissionInput {fields:{field:{name:string};value:{values?:string[]}}[]}

async function heldSite(directory:string) {
 let origin='',record='',notify!:()=>void,release!:()=>void;
 const received=new Promise<void>(r=>{notify=r;}),released=new Promise<void>(r=>{release=r;});
 const server=createServer(async(req,res)=>{
  if(req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   const form=await new Request(origin,{method:'POST',headers:{'content-type':req.headers['content-type']!},body:Buffer.concat(chunks)}).formData();
   const fields={visitor:String(form.get('visitor'))},files:unknown[]=[];
   record=JSON.stringify({reference:digest(Buffer.from('held-identity')),status:'submitted',digest:digest(Buffer.from(JSON.stringify({fields,files}))),fields,files});
   writeFileSync(join(directory,'actual.json'),record);notify();await released;
   res.writeHead(303,{Location:'/receipts/'+digest(Buffer.from('held-identity'))});res.end();return;
  }
  res.setHeader('Content-Type','text/html');
  if(req.url?.startsWith('/receipts/')){res.end('<pre>'+record+'</pre>');return;}
  res.end('<form method="post" action="/applications"><label>Visitor<input name="visitor" required></label><label>Submission identity<input name="idempotencyKey" value="held-identity"></label><button>Send</button></form>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 return {origin,received,release,close:async()=>{release();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}};
}
async function fixture(variant=0,lose=false,held=false,omitOptional=false) {
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'bfh-'));mkdirSync(join(root,'portal'));
 const portalConfig:PortalConfig=held?{title:'Held invented response',fields:[{name:'visitor',label:'Visitor',required:true}],attachments:[]}:{title:'Invented varied native form',fields:variant?[{name:'reply_z',label:'Reply mailbox',required:true,type:'email'},{name:'visitor_z',label:'Workshop guest',required:true}]:[{name:'guest_a',label:'Participant',required:true},{name:'email_a',label:'Contact address',required:true,type:'email'}],attachments:variant?[{name:'portrait_z',label:'Supporting illustration',required:true,type:'image/png',maxBytes:50000},{name:'proposal_z',label:'Workshop narrative',required:true,type:'application/pdf',maxBytes:50000}]:[{name:'document_a',label:'Written proposal',required:true,type:'application/pdf',maxBytes:50000},{name:'picture_a',label:'Reference picture',required:true,type:'image/png',maxBytes:50000}]};
 if(omitOptional)portalConfig.attachments[0]!.required=false;
 const site=held?await heldSite(join(root,'portal')):await startPortal(join(root,'portal'),portalConfig,{loseResponseOnce:lose});
 const store=new EvidenceStore(join(root,'evidence'));
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true}).catch(async error=>{await site.close();store.close();rmSync(root,{recursive:true,force:true});throw error;});
 try {
 let current=true,approval=true,currentRevision:ApplicationRevisionRef|undefined=revision;
 const cancel=new AbortController(),revoke=new AbortController();
 const ctx:ToolContext={accountId:'a',workspaceId:'w',taskId:'task',runId:'run',callId:'setup',scope:{sources:[],destinations:[site.origin+'/'],grants:[]},applicationRevision:revision,signal:cancel.signal,isCurrent:()=>current,budget:{limit:100,used:0}};
 const artifacts=portalConfig.attachments.filter(f=>!omitOptional||f.required).map(f=>{const data=f.type==='application/pdf'?Buffer.from(inventedPdf()):inventedPng();const stored=store.put(ctx,data,f.type,[],{provider:'user',providerId:randomUUID(),providerVersion:digest(data)});ctx.scope.sources.push(stored.source!);return {field:f.name,artifact:stored.artifact,filename:f.type==='application/pdf'?'reviewed.pdf':'reviewed.png'};});
 const fields=portalConfig.fields.map(f=>({name:f.name,value:f.type==='email'?'invented@example.test':'Reviewed invented guest'}));
 const expectedFiles=artifacts.map(f=>({name:f.field,filename:f.filename,type:f.artifact.mimeType,bytes:f.artifact.bytes,sha256:f.artifact.sha256}));
 const expectedDigest=digest(Buffer.from(JSON.stringify({fields:Object.fromEntries(fields.map(f=>[f.name,f.value])),files:expectedFiles})));
 const intentPath=join(root,'intent.json'),closedLeases:string[]=[];
 const config:BrowserFormHostConfig={browser,store,accountId:'a',workspaceId:'w',taskId:'task',sessionId:'owned-session',destination:site.origin+'/',submissionUrl:site.origin+'/applications',readUrls:[],allowLoopback:true,revision:()=>currentRevision,timeoutMs:4000,
  uploadName:a=>artifacts.find(f=>f.artifact.id===a.id)!.filename,
  authorize:async(request):Promise<BrowserHostGrant|undefined>=>{
   if(!approval)return undefined;
   const input=request.input as {field?:{name:string};value?:unknown;artifactId?:string};
   if(request.operation==='fill'&&!fields.some(f=>f.name===input.field?.name&&f.value===input.value))return undefined;
   if(request.operation==='upload'&&!artifacts.some(f=>f.field===input.field?.name&&f.artifact.id===input.artifactId))return undefined;
   const identity=(request.input as SubmissionInput).fields?.find(f=>f.field.name==='idempotencyKey')?.value.values?.[0];
   return {signal:revoke.signal,lease:{id:'actual-host-capability',isCurrent:()=>current&&approval&&!revoke.signal.aborted,close:async outcome=>{closedLeases.push(outcome);}},post:request.operation==='submit'?{url:site.origin+'/applications',encoding:held?'urlencoded':'multipart',fields:[...fields,{name:'idempotencyKey',value:identity!}],files:artifacts.map(f=>({field:f.field,artifactId:f.artifact.id,filename:f.filename}))}:undefined};
  },
  submissions:{
   current:async()=>existsSync(intentPath)?JSON.parse(readFileSync(intentPath,'utf8')) as BrowserSubmissionIntent:undefined,
   claim:async request=>{
    if(existsSync(intentPath))return {intent:JSON.parse(readFileSync(intentPath,'utf8')) as BrowserSubmissionIntent,dispatch:false};
    const key=(request.input as SubmissionInput).fields.find(f=>f.field.name==='idempotencyKey')!.value.values![0]!;
    const intent:BrowserSubmissionIntent={id:'durable-host-intent',sessionId:request.sessionId,destination:request.destination,revision:request.revision,inputHash:request.inputHash,receiptUrl:site.origin+'/receipts/'+digest(Buffer.from(key)),state:'uncertain'};
    writeFileSync(intentPath+'.tmp',JSON.stringify(intent));renameSync(intentPath+'.tmp',intentPath);return {intent,dispatch:true};
   },
   record:async(intent,state)=>{writeFileSync(intentPath,JSON.stringify({...intent,state}));}
  },
  // Same site-specific parser contract as the returned tool tests, not a universal receipt assertion.
  readReceipt:async(page,intent)=>{const record=JSON.parse(await page.locator('pre').innerText()) as {reference:string;status:string;digest:string};if(record.status!=='submitted'||!intent.receiptUrl.endsWith(record.reference)||record.digest!==expectedDigest)return undefined;return {receiptId:record.reference,contentHash:record.digest,destination:intent.destination,revision:intent.revision};}
 };
 let host=await createBrowserFormHost(config);await host.open(ctx);let page=host.options.session(ctx)!.page,tools=createBrowserFormTools(host.options);
 const call=async(name:string,args:unknown):Promise<ToolResult>=>{const tool=tools.find(t=>t.name===name)!;return tool.invoke(args,{...ctx,callId:randomUUID()});};
 const inspect=async()=>{const r=await call('browser.inspect',{});assert.equal(r.status,'ok',JSON.stringify(r));return r.data as View;};
 const prepare=async()=>{const view=await inspect();for(const field of view.fields){if(field.name==='idempotencyKey')continue;const artifact=artifacts.find(f=>f.field===field.name);if(field.type==='file'&&!artifact)continue;const r=artifact?await call('browser.upload',{snapshotRef:view.snapshotRef,fieldRef:field.ref,artifactId:artifact.artifact.id}):await call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:field.ref,value:field.type==='email'?'invented@example.test':'Reviewed invented guest'});assert.equal(r.status,'ok',JSON.stringify(r));}return view;};
 return {root,site,store,browser,ctx,config,revoke,cancel,closedLeases,fields,artifacts,call,inspect,prepare,get host(){return host;},get page(){return page;},setApproval:(v:boolean)=>{approval=v;},setCurrent:(v:boolean)=>{current=v;},setRevision:(v:ApplicationRevisionRef|undefined)=>{currentRevision=v;ctx.applicationRevision=v;},recreate:async()=>{await host.close();host=await createBrowserFormHost(config);await host.open(ctx);page=host.options.session(ctx)!.page;tools=createBrowserFormTools(host.options);},close:async()=>{try{await host.close();}finally{await browser.close();await site.close();store.close();rmSync(root,{recursive:true,force:true});}}};
 }catch(error){await browser.close();await site.close();store.close();rmSync(root,{recursive:true,force:true});throw error;}
}

async function attackFixture(allowAutosave=false,loseAutosave=false) {
 const root=mkdtempSync(join(scratch,'bfh-')),store=new EvidenceStore(root);
 const received:{url:string;method:string;headers:Record<string,unknown>;body:string}[]=[];let upgrades=0;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({url:req.url!,method:req.method!,headers:req.headers,body});
  if(req.method==='POST'&&loseAutosave){req.socket.destroy();return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:origin+'/outside'});res.end();return;}
  if(req.url==='/download'){res.setHeader('Content-Disposition','attachment; filename="not-allowed.txt"');res.end('invented download');return;}
  res.setHeader('Content-Type','text/html');res.end(req.url==='/'?'<form action="/post" method="post"><label>Invented entry<input name="entry"></label><button>Send</button></form>':'invented response');
 });
 server.on('upgrade',(_req,socket)=>{upgrades++;socket.destroy();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true}).catch(async error=>{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});throw error;});
 try {
 const revoke=new AbortController();
 const ctx:ToolContext={accountId:'a',workspaceId:'w',taskId:'attack',runId:'run',callId:'setup',scope:{sources:[],destinations:[origin+'/'],grants:[]},applicationRevision:revision,signal:new AbortController().signal,isCurrent:()=>true,budget:{limit:30,used:0}};
 const host=await createBrowserFormHost({browser,store,accountId:'a',workspaceId:'w',taskId:ctx.taskId,sessionId:'attack-session',destination:origin+'/',submissionUrl:origin+'/post',readUrls:[origin+'/read',origin+'/redirect',origin+'/download'],allowLoopback:true,revision:()=>revision,
  authorize:async()=>({signal:revoke.signal,lease:{id:'reviewed-fill',isCurrent:()=>!revoke.signal.aborted,close:async()=>{}},post:allowAutosave?{url:origin+'/autosave',encoding:'urlencoded',fields:[{name:'entry',value:'Reviewed invented value'}],files:[]}:undefined}),uploadName:()=>'',submissions:{current:async()=>undefined,claim:async()=>{throw Error('not authorized');},record:async()=>{}},readReceipt:async()=>undefined});
 await host.open(ctx);const page=host.options.session(ctx)!.page,tools=createBrowserFormTools(host.options);
 const call=async(name:string,args:unknown)=>tools.find(t=>t.name===name)!.invoke(args,{...ctx,callId:randomUUID()});
 return {host,page,received,origin,call,get upgrades(){return upgrades;},close:async()=>{await host.close();await browser.close();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));store.close();rmSync(root,{recursive:true,force:true});}};
 }catch(error){await browser.close();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});throw error;}
}

test('actual immediate/deferred autosave and exfil channels are confined, including allowed-read headers and redirect chains',browserTest,async()=>{
 const f=await attackFixture();try{
  await f.page.locator('input').evaluate(input=>{const save=()=>fetch('/autosave',{method:'POST',body:new URLSearchParams({entry:(input as HTMLInputElement).value})}).catch(()=>{});input.addEventListener('input',()=>{void save();(window as unknown as {deferred:()=>Promise<unknown>}).deferred=save;});});
  const inspected=await f.call('browser.inspect',{}),view=inspected.data as View;
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'})).status,'ok');
  await f.page.evaluate(async()=>{await (window as unknown as {deferred:()=>Promise<unknown>}).deferred();document.cookie='leaked=InventedSentinel';await fetch('/read',{headers:{'X-Exfil':'InventedSentinel'},referrer:location.origin+'/private/InventedSentinel'});await fetch('/read?leak=InventedSentinel').catch(()=>{});await fetch('/redirect').catch(()=>{});await fetch('/download').catch(()=>{});await new Promise<void>(resolve=>{const socket=new WebSocket(location.origin.replace('http','ws')+'/socket');socket.onclose=()=>resolve();socket.onerror=()=>resolve();});});
  assert.equal(f.received.filter(r=>r.method==='POST').length,0);assert.equal(f.received.filter(r=>r.url.includes('?')||r.url==='/outside').length,0);assert.equal(f.upgrades,0);
  const read=f.received.find(r=>r.url==='/read')!;assert.ok(!read.headers['x-exfil']);assert.ok(!read.headers.referer);assert.ok(!read.headers.cookie);
  assert.ok(f.host.status().blockedRequests>=5);assert.deepEqual(await f.page.evaluate(()=>['RTCPeerConnection','WebTransport','Worker','SharedWorker','fetchLater'].map(key=>typeof (globalThis as unknown as Record<string,unknown>)[key])),['undefined','undefined','undefined','undefined','undefined']);
  const closed=f.page.waitForEvent('close');await f.page.evaluate(()=>{const frame=document.createElement('iframe');frame.src='/read';document.body.append(frame);}).catch(()=>{});await closed;await f.host.close();assert.equal(f.host.status().reason,'child_frame');assert.equal(f.host.status().inFlight,0);assert.equal(f.received.filter(r=>r.url==='/read').length,1);
 }finally{await f.close();}
});

test('one exact authorized autosave POST is consumed once; identical concurrent and post-lease writes are denied',browserTest,async()=>{
 const f=await attackFixture(true);try{
  await f.page.locator('input').evaluate(input=>{const save=()=>fetch('/autosave',{method:'POST',body:new URLSearchParams({entry:(input as HTMLInputElement).value})}).catch(()=>{});input.addEventListener('input',()=>{void save();void save();(window as unknown as {deferred:()=>Promise<unknown>}).deferred=save;});});
  const view=(await f.call('browser.inspect',{})).data as View;assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'})).status,'ok');
  await f.page.evaluate(async()=>{await (window as unknown as {deferred:()=>Promise<unknown>}).deferred();});
  const posts=f.received.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0]!.body,'entry=Reviewed+invented+value');assert.equal(f.host.status().dispatchedPosts,1);assert.ok(f.host.status().blockedRequests>=2);
 }finally{await f.close();}
});

test('response loss during authorized autosave cannot be returned as a clean successful write',browserTest,async()=>{
 const f=await attackFixture(true,true);try{
  await f.page.locator('input').evaluate(input=>input.addEventListener('input',()=>{void fetch('/autosave',{method:'POST',body:new URLSearchParams({entry:(input as HTMLInputElement).value})}).catch(()=>{});}));
  const view=(await f.call('browser.inspect',{})).data as View;
  const result=await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented value'});
  assert.equal(result.status,'needs_input');await f.host.close();assert.equal(f.received.filter(r=>r.method==='POST').length,1);assert.equal(f.host.status().lastPost,'unknown');assert.equal(f.host.status().inFlight,0);assert.equal(f.host.status().state,'quarantined');
 }finally{await f.close();}
});

test('real confined host: two changed ordinary forms, approved PDF/PNG bytes, persisted receipt and unchanged site parser',browserTest,async()=>{
 for(const variant of [0,1]){
  const f=await fixture(variant);try{
   const view=await f.prepare();const submitted=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(submitted.status,'ok',JSON.stringify({submitted,host:f.host.status()}));
   assert.equal(f.host.status().dispatchedPosts,1);assert.equal(f.host.status().lastPost,'response_received');
   assert.equal((await f.call('browser.verify_submission',{})).status,'ok');
   const receipts=readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json'));assert.equal(receipts.length,1);
   const receipt=JSON.parse(readFileSync(join(f.root,'portal',receipts[0]!),'utf8')) as {files:{sha256:string;filename:string;type:string}[]};
   for(const file of receipt.files){const bytes=readFileSync(join(f.root,'portal',file.sha256+'.upload'));assert.equal(digest(bytes),file.sha256);assert.deepEqual(bytes,file.type==='application/pdf'?Buffer.from(inventedPdf()):inventedPng());assert.equal(file.filename,file.type==='application/pdf'?'reviewed.pdf':'reviewed.png');}
   assert.equal((await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref})).error?.code,'RECONCILIATION_REQUIRED');
  }finally{await f.close();}
 }
});

test('optional untouched file input sends no unapproved placeholder artifact and receipt still verifies',browserTest,async()=>{
 const f=await fixture(0,false,false,true);try{
  const view=await f.prepare();const submitted=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(submitted.status,'ok',JSON.stringify({submitted,host:f.host.status()}));assert.equal((await f.call('browser.verify_submission',{})).status,'ok');assert.equal(f.host.status().dispatchedPosts,1);
 }finally{await f.close();}
});

test('read-only normal registry/runtime turn observes real browser results before revision/approval (scripted provider, NOT LLM)',browserTest,async()=>{
 const f=await fixture();const tasks=new AgentStore(':memory:');try{
  f.setRevision(undefined);f.setApproval(false);
  const task=tasks.admit({accountId:'a',workspaceId:'w',messageId:'invented-trigger',outcome:'Read admitted form'},12);
  f.config.taskId=task.id;f.ctx.taskId=task.id;await f.recreate();
  const runtime=new AgentRuntime(tasks,createBrowserFormTools(f.host.options));let observed=false;
  await runtime.run(task.id,{id:'scripted-invented-not-model',async next(state,metadata){assert.ok(metadata.some(t=>t.name==='browser.fill'&&t.effect==='external_write'));if(!state.observations.length)return {kind:'tool',name:'browser.inspect',args:{}};const view=state.observations[0]!.data as View;assert.ok(view.fields.some(f=>f.label.includes('Participant')));assert.ok(view.fields.every(f=>typeof f.ref==='string'));observed=true;return {kind:'ready',result:'Observed actual form metadata'};}},2,{scope:f.ctx.scope});
  assert.equal(observed,true);assert.equal(tasks.get(task.id).status,'ready');assert.equal(f.host.status().dispatchedPosts,0);
 }finally{tasks.close();await f.close();}
});

test('authority, wrong namespace and missing/tampered artifact or body never enable a dispatch',browserTest,async()=>{
 const f=await fixture();try{
  const view=await f.inspect();f.setApproval(false);assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented guest'})).error?.code,'AUTHORITY_REQUIRED');f.setApproval(true);
  assert.equal(f.host.options.session({...f.ctx,accountId:'other'}),undefined);f.config.accountId='other';assert.equal(f.host.options.session({...f.ctx,accountId:'other'}),undefined);f.config.accountId='a';
  const initialAuthorize=f.config.authorize;f.config.authorize=async(r,c)=>{const grant=await initialAuthorize(r,c);if(grant)grant.post={url:f.site.origin+'/applications',encoding:'multipart',fields:[],files:[]};return grant;};
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented guest'})).error?.code,'AUTHORITY_REQUIRED');f.config.authorize=initialAuthorize;
  assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Unreviewed'})).error?.code,'AUTHORITY_REQUIRED');
  const prepared=await f.prepare();const original=f.config.authorize;
  f.config.authorize=async(r,c)=>{const grant=await original(r,c);if(grant?.post)grant.post.files=[...grant.post.files,{field:'extra',artifactId:'missing',filename:'invented.pdf'}];return grant;};
  assert.equal((await f.call('browser.submit',{snapshotRef:prepared.snapshotRef,actionRef:prepared.actions[0]!.ref})).error?.code,'AUTHORITY_REQUIRED');assert.equal(f.host.status().dispatchedPosts,0);
 }finally{await f.close();}
});

test('modified submit payload is denied before transport; no server record and no second attempt',browserTest,async()=>{
 const f=await fixture();try{
  const view=await f.prepare();await f.page.locator('form').evaluate(form=>form.addEventListener('submit',()=>{form.querySelector('input')!.value='Page-tampered invented value';}));
  const r=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(r.status,'needs_input');
  assert.equal(f.host.status().dispatchedPosts,0);assert.ok(f.host.status().blockedRequests>0);assert.equal(f.host.status().state,'quarantined');assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,0);
  await f.recreate();assert.equal((await f.call('browser.verify_submission',{})).error?.code,'RECEIPT_UNVERIFIED');assert.equal(f.host.status().dispatchedPosts,0);
 }finally{await f.close();}
});

test('changed uploaded bytes with matching MIME/name are denied before server dispatch',browserTest,async()=>{
 const f=await fixture();try{
  const view=await f.prepare(),file=f.artifacts[0]!;
  await f.page.locator('input[type=file]').first().setInputFiles({name:file.filename,mimeType:file.artifact.mimeType,buffer:Buffer.from('Unreviewed invented bytes')});
  assert.equal((await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref})).status,'needs_input');assert.equal(f.host.status().dispatchedPosts,0);assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,0);
 }finally{await f.close();}
});

test('response loss dispatches one real POST, drains/quarantines, and recreated host only reconciles durable intent',browserTest,async()=>{
 const f=await fixture(0,true);try{
  const view=await f.prepare(),first=f.host;
  const result=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(result.status,'needs_input');
  assert.equal(first.status().dispatchedPosts,1);assert.equal(first.status().lastPost,'unknown');assert.equal(first.status().inFlight,0);assert.equal(first.status().state,'quarantined');
  assert.equal(readdirSync(join(f.root,'portal')).filter(x=>x.endsWith('.json')).length,1);
  await f.recreate();assert.equal((await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref})).error?.code,'RECONCILIATION_REQUIRED');
  assert.equal((await f.call('browser.verify_submission',{})).status,'ok');assert.equal(f.host.status().dispatchedPosts,0);
 }finally{await f.close();}
});

test('ordinary native textarea line endings match reviewed values using HTML form CRLF normalization',browserTest,async()=>{
 const f=await fixture(0,false,true);try{
  const value='Reviewed\ninvented guest';f.fields[0]!.value=value;
  await f.page.locator('input[name=visitor]').evaluate(el=>{const area=document.createElement('textarea');area.name='visitor';area.required=true;el.replaceWith(area);});
  const view=await f.inspect();assert.equal((await f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value})).status,'ok');
  (f.site as Awaited<ReturnType<typeof heldSite>>).release();
  const result=await f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});assert.equal(result.status,'ok',JSON.stringify({result,host:f.host.status()}));
  const record=JSON.parse(readFileSync(join(f.root,'portal','actual.json'),'utf8')) as {fields:{visitor:string}};assert.equal(record.fields.visitor,'Reviewed\r\ninvented guest');
 }finally{await f.close();}
});

test('revocation during actual held POST drains client fetch while persisted remote result remains honestly unknown',browserTest,async()=>{
 const f=await fixture(0,false,true);try{
  const view=await f.prepare();const running=f.call('browser.submit',{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref});
  await (f.site as Awaited<ReturnType<typeof heldSite>>).received;
  assert.equal(f.host.status().inFlight,1);f.revoke.abort();const result=await running;
  assert.equal(result.status,'needs_input');assert.equal(f.host.status().state,'quarantined');assert.equal(f.host.status().inFlight,0);assert.equal(f.host.status().lastPost,'unknown');assert.ok(existsSync(join(f.root,'portal','actual.json')));
  // The remote committed before cancellation. Stopping this client is NOT remote rollback.
  (f.site as Awaited<ReturnType<typeof heldSite>>).release();await f.recreate();assert.equal((await f.call('browser.verify_submission',{})).status,'ok');assert.equal(f.host.status().dispatchedPosts,0);
 }finally{await f.close();}
});

test('late authority callback after cancellation is closed without opening transport',browserTest,async()=>{
 const f=await fixture();try{
  const view=await f.inspect(),original=f.config.authorize;
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r;}),waiting=new Promise<void>(r=>{release=r;});
  f.config.authorize=async(r,c)=>{const grant=await original(r,c);ready();await waiting;return grant;};
  const running=f.call('browser.fill',{snapshotRef:view.snapshotRef,fieldRef:view.fields[0]!.ref,value:'Reviewed invented guest'});await started;f.cancel.abort();release();await running;
  // Host callback settlement/cutoff is observable, not a sleep pretending cleanup occurred.
  await f.host.close();assert.equal(f.host.status().inFlight,0);assert.equal(f.host.status().dispatchedPosts,0);assert.ok(f.closedLeases.includes('not_dispatched'));
 }finally{await f.close();}
});
