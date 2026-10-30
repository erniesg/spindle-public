import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium,type Browser,type BrowserContext,type Video} from 'playwright-core';
import {AgentRuntime} from '../core/agent/runtime.js';
import type {AgentProvider,ApplicationRevisionRef,ToolDefinition,Decision,ToolResult} from '../core/agent/contracts.js';
import {createTaskBrowserTools,type TaskBrowserReview} from '../core/agent/browser-host.js';
import {AgentStore} from '../core/storage/agent-store.js';
import {EvidenceStore,digest,type Namespace} from '../core/evidence/store.js';
import {AgentSessionStore} from '../core/models/agent-session-store.js';
import {NebiusAgentProvider,type AgentProviderOptions} from '../core/models/agent-provider.js';
import {visibleRecord} from '../core/preparation/session.js';
import {startPortal,type PortalConfig} from '../examples/application-portal/server.js';

export const FICTIONAL_SUBMIT_INSTRUCTION='Submit exactly this reviewed invented application revision and attachment to this run-owned fictional loopback portal, then verify its persisted receipt by navigation and revisit. No third-party submission is authorized.';
export interface BrowserLoopInput {
 goal:string;destination:string;
 context?:string;
 fields:{name:string;label:string;value:string}[];
 attachments:{field:string;label:string;artifactId:string;filename:string;sha256:string}[];
}
export interface BrowserLoopOptions {
 outputDir:string;executablePath:string;approveFictionalSubmit:boolean;variant?:0|1;recordVideo?:boolean;
 provider:{kind:'nebius';options:Omit<AgentProviderOptions,'persist'>}|{kind:'scripted-test';provider:AgentProvider};
 /** Optional freshly admitted invented email task. Stores stay caller-owned. */
 binding?:{tasks:AgentStore;store:EvidenceStore;namespace:Namespace;taskId:string};
 /** Trusted demo assembly may add scoped source tools and context, never a planner. */
 additionalTools?:ToolDefinition[];context?:string;
 /** Observer may wrap, never replace provider decisions; intended for acceptance assertions. */
 observeProvider?:(provider:AgentProvider)=>AgentProvider;
 maxTurns?:number;timeoutMs?:number;
}
export interface BrowserLoopResult {
 taskId:string;mode:'nebius'|'scripted-test';proof:'scripted-provider'|'injected-nebius-transport'|'nebius-default-transport';accepted:boolean;status:string;recordCount:number;fileBytesVerified:boolean;
 providerObservedVerification:boolean;screenshots:string[];videos:string[];mediaErrors:string[];
}

/** Complete small one-page PDF, not a placeholder extension or an imported personal file. */
function statementPdf():Buffer {
 const stream='BT /F1 12 Tf 20 100 Td (Invented workshop statement - demo only.) Tj ET\n';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets:number[]=[];
 objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
 const xref=Buffer.byteLength(pdf);
 return Buffer.from(pdf+`xref\n0 6\n0000000000 65535 f \n`+offsets.map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function visibleArgs(args:unknown){
 const values=args as Record<string,unknown>;
 return {...visibleRecord(args) as object,...Object.fromEntries(['snapshotRef','fieldRef','actionRef'].flatMap(k=>typeof values?.[k]==='string'?[[k,visibleRecord(values[k])]]:[]))};
}
function visibleDecision(d:Decision):unknown {
 const base=visibleRecord(d) as object;
 return d.kind==='tool'?{...base,args:visibleArgs(d.args)}:d.kind==='batch'?{...base,calls:d.calls.map(c=>({...visibleRecord(c) as object,args:visibleArgs(c.args)}))}:base;
}
function visibleResult(o:ToolResult):unknown {
 const data=o.data as {snapshotRef?:string;fields?:Record<string,unknown>[];actions?:{ref:string;label:string;form:{action:string;method:string}}[]}|null;
 const base=visibleRecord(o) as object;
 if(!data?.snapshotRef||!Array.isArray(data.fields))return base;
 return {...base,data:{...visibleRecord(data) as object,snapshotRef:visibleRecord(data.snapshotRef),
  fields:data.fields.map(f=>({...visibleRecord(f) as object,ref:visibleRecord(f.ref),type:visibleRecord(f.type),required:visibleRecord(f.required)})),
  actions:data.actions?.map(a=>({ref:visibleRecord(a.ref),label:visibleRecord(a.label),form:{action:visibleRecord(a.form.action),method:visibleRecord(a.form.method)}}))}};
}
function identity(){return {sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),buildSha256:digest(readFileSync(fileURLToPath(import.meta.url)))};}

/** No planner here: the supplied provider alone chooses registered tools and consumes their results. */
export async function runBrowserLoop(options:BrowserLoopOptions):Promise<BrowserLoopResult> {
 if(options.approveFictionalSubmit!==true)throw Error('FICTIONAL_SUBMIT_APPROVAL_REQUIRED');
 const output=resolve(options.outputDir);mkdirSync(dirname(output),{recursive:true});mkdirSync(output); // Never reuse an old run or erase evidence.
 const contexts:BrowserContext[]=[],recordings:Video[]=[],screenshots:string[]=[],mediaErrors:string[]=[];
 let browser:Browser|undefined,portal:Awaited<ReturnType<typeof startPortal>>|undefined,host:Awaited<ReturnType<typeof createTaskBrowserTools>>|undefined;
 let tasks:AgentStore|undefined,store:EvidenceStore|undefined,taskId:string|undefined,sessions:AgentSessionStore|undefined;
 const namespace=options.binding?.namespace??{accountId:'fictional-owner',workspaceId:'fictional-demo'};
 const mode=options.provider.kind,proof=options.provider.kind==='scripted-test'?'scripted-provider':options.provider.options.transport?'injected-nebius-transport':'nebius-default-transport',build=identity();let summary:BrowserLoopResult|undefined;
 const pdf=statementPdf();
 try {
  tasks=options.binding?.tasks??new AgentStore(join(output,'tasks.sqlite'));
  store=options.binding?.store??new EvidenceStore(join(output,'evidence'));sessions=new AgentSessionStore(store.db);
  const task=options.binding?tasks.taskInNamespace(namespace,options.binding.taskId):tasks.admit({...namespace,messageId:randomUUID(),outcome:'Invented browser acceptance demo'},128);
  if(!task||task.status!=='working'||task.decisions.length||task.observations.length||task.browser||task.pending||task.recovery!=='clean'||task.applicationRevision)throw Error('FRESH_INVENTED_TASK_REQUIRED');
  taskId=task.id;
  const config:PortalConfig={title:'Invented workshop application — demo harness, not owner product UI',fields:options.variant===1?[{name:'reply_z',label:'Reply mailbox',required:true,type:'email'},{name:'guest_z',label:'Workshop guest',required:true}]:[{name:'participant_a',label:'Participant name',required:true},{name:'contact_a',label:'Contact email',required:true,type:'email'}],attachments:[{name:options.variant===1?'narrative_z':'statement_a',label:'Invented workshop statement',required:true,type:'application/pdf',maxBytes:50000}]};
  portal=await startPortal(join(output,'portal'),config);
  const destination=portal.origin+'/',key='invented-'+randomUUID();
  const attachment=store.put(namespace,pdf,'application/pdf',[],{provider:'user',providerId:'invented-reviewed-statement',providerVersion:'1'});
  const input:BrowserLoopInput={goal:'Use browser.inspect to discover current DOM refs. Fill the supplied reviewed values using observed field refs, upload the supplied artifact, submit once using the observed action ref, and call browser.verify_submission. Observe its actual verified result before declaring Ready. A successful state=dispatched tool result means the operation already ran. After browser.submit returns dispatched or uncertain, never refill, reupload or resubmit: use the read-only browser.verify_submission tool to reconcile the retained intent. Do not treat a submitted page or stale snapshot as a new blank application.',destination,
   ...(options.context?{context:options.context}:{}),
   fields:[...config.fields.map(f=>({name:f.name,label:f.label,value:f.type==='email'?'mira.demo@example.test':'Mira Example'})),{name:'idempotencyKey',label:'Submission identity',value:key}],
   attachments:[{field:config.attachments[0]!.name,label:config.attachments[0]!.label,artifactId:attachment.artifact.id,filename:'invented-statement.pdf',sha256:attachment.artifact.sha256}]};
  const revision:ApplicationRevisionRef={applicationId:'fictional-workshop',revision:1,contentHash:digest(Buffer.from(JSON.stringify(input)))};
  tasks.update(taskId,t=>{t.requestedOutcome=JSON.stringify(input);t.applicationRevision=revision;});
  const review:TaskBrowserReview={revision,controls:input.fields.map(({name,value})=>({name,value})),post:{url:portal.origin+'/applications',encoding:'multipart',fields:input.fields.map(({name,value})=>({name,value})),files:input.attachments.map(a=>({field:a.field,artifactId:a.artifactId,filename:a.filename}))},receiptUrl:portal.origin+'/receipts/'+digest(Buffer.from(key))};
  writeFileSync(join(output,'owner-instruction.json'),JSON.stringify({instruction:FICTIONAL_SUBMIT_INSTRUCTION,review},null,2));
  browser=await chromium.launch({executablePath:options.executablePath,headless:true,chromiumSandbox:true});
  // Trusted harness injection only: preserve all production context safeguards and retain
  // actual tool-browser video. The host currently has no public context-options seam.
  const actualBrowser=browser;
  const recordedBrowser=new Proxy(actualBrowser,{get(target,property){
   if(property==='newContext')return async(contextOptions:Parameters<Browser['newContext']>[0])=>{
    const context=await target.newContext({...contextOptions,...(options.recordVideo!==false?{recordVideo:{dir:join(output,'video'),size:{width:1280,height:720}}}:{})});
    contexts.push(context);context.on('page',page=>{const video=page.video();if(video)recordings.push(video);});return context;
   };
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  host=await createTaskBrowserTools({tasks,store,namespace,taskId,browser:recordedBrowser,sessionId:'fictional-session-'+taskId,destination,submissionUrl:review.post.url,readUrls:[],allowLoopback:true,timeoutMs:10000,
   authority:{id:'explicit-fictional-owner-instruction',signal:new AbortController().signal,isCurrent:()=>true},
   readReceipt:async(page,intent,_context,saved)=>{
    const actual=JSON.parse(await page.locator('pre').innerText()) as {reference:string;status:string;digest:string};
    const fields=Object.fromEntries(saved.review.post.fields.filter(f=>f.name!=='idempotencyKey').map(f=>[f.name,f.value]));
    const files=saved.review.post.files.map(f=>{const a=saved.files.find(a=>a.id===f.artifactId)!;return {name:f.field,filename:f.filename,type:a.mimeType,bytes:a.bytes,sha256:a.sha256};});
    if(actual.status!=='submitted'||intent.receiptUrl!==portal!.origin+'/receipts/'+actual.reference||actual.digest!==digest(Buffer.from(JSON.stringify({fields,files}))))return undefined;
    return {receiptId:actual.reference,contentHash:actual.digest,destination:intent.destination,revision:intent.revision};
   }});
  host.approve(review,'one-explicit-fictional-submit'); // Trusted owner side, never a model tool.
  async function screenshot(name:string){
   const page=contexts.at(-1)?.pages()[0];if(!page||page.isClosed())return;
   const filename=`${String(screenshots.length+1).padStart(2,'0')}-${name}.png`;
   try{await page.screenshot({path:join(output,filename),fullPage:true,timeout:5000});screenshots.push(filename);}catch{mediaErrors.push('SCREENSHOT_UNAVAILABLE');}
  }
  const tools=[...host.tools,...(options.additionalTools??[])].map(tool=>({...tool,async invoke(...args:Parameters<typeof tool.invoke>){
   if(tool.name==='browser.submit')await screenshot('reviewed-filled-form');
   const result=await tool.invoke(...args);await screenshot(tool.name.replace('browser.',''));return result;
  }}));
  const configured=options.provider.kind==='nebius'?new NebiusAgentProvider({...options.provider.options,persist:sessions.persist}):options.provider.provider;
  const provider=options.observeProvider?.(configured)??configured;
  let providerObservedVerification=false;
  const observedProvider:AgentProvider={id:provider.id,async next(task,metadata,context){
   const hasVerifiedResult=task.observations.some(o=>o.status==='ok'&&(o.data as {state?:string})?.state==='verified');
   const decision=await provider.next(task,metadata,context);
   if(hasVerifiedResult)providerObservedVerification=true;return decision;
  }};
  await new AgentRuntime(tasks,tools).run(taskId,observedProvider,options.maxTurns??16,{...host.execution,blockOnTurnLimit:true,scope:{sources:[attachment.source!],destinations:[destination],grants:[]},timeoutMs:options.timeoutMs??300000});
  // Observation ending is not destination drain: a dispatched request can still
  // commit while the model is blocked. Close owned contexts/server before readback.
  await host.close();host=undefined;await portal.close();portal=undefined;
  const final=tasks.get(taskId),records=readdirSync(join(output,'portal')).filter(f=>f.endsWith('.json'));
  let fileBytesVerified=false,recordMatches=false;
  if(records.length===1){
   const record=JSON.parse(readFileSync(join(output,'portal',records[0]!),'utf8')) as {reference:string;status:string;fields:Record<string,string>;files:{sha256:string;bytes:number}[]};
   recordMatches=record.reference===digest(Buffer.from(key))&&record.status==='submitted'&&JSON.stringify(record.fields)===JSON.stringify(Object.fromEntries(input.fields.filter(f=>f.name!=='idempotencyKey').map(f=>[f.name,f.value])));
   fileBytesVerified=record.files.length===1&&record.files[0]!.sha256===attachment.artifact.sha256&&record.files[0]!.bytes===pdf.length&&readFileSync(join(output,'portal',attachment.artifact.sha256+'.upload')).equals(pdf);
  }
  const videos=await Promise.all(recordings.map(async video=>relative(output,await video.path())));
  summary={taskId,mode,proof,accepted:final.status==='ready'&&final.browser?.submission?.state==='verified'&&providerObservedVerification&&records.length===1&&recordMatches&&fileBytesVerified,status:final.status,recordCount:records.length,fileBytesVerified,providerObservedVerification,screenshots,videos,mediaErrors};
  writeFileSync(join(output,'result.json'),JSON.stringify(summary,null,2));return summary;
 } finally {
  try{if(host)await host.close();}finally{try{if(browser)await browser.close();}finally{try{if(portal)await portal.close();}finally{
   try{if(tasks&&store&&taskId&&sessions){
    const task=tasks.get(taskId);
    const session={kind:'spindle.browser-demo-visible-session.v1',mode,proof,build,taskId,status:task.status,recovery:task.recovery,blocker:visibleRecord(task.blocker),input:visibleRecord(task.requestedOutcome),revision:task.applicationRevision,
     decisions:task.decisions.map(visibleDecision),
     results:task.observations.map(visibleResult),modelCalls:sessions.list(namespace,taskId).map(e=>({model:e.model,cursor:e.cursor,reservation:e.reservation,responsePersisted:!!e.response,usage:e.response?.usage??null,decision:e.response&&visibleDecision(e.response.decision)})),summary};
    const bytes=Buffer.from(JSON.stringify(session,null,2));store.put(namespace,bytes,'application/json');writeFileSync(join(output,'visible-session.json'),bytes);
   }}finally{if(!options.binding){tasks?.close();store?.close();}}
  }}}
 }
}

async function cli(){
 const args=process.argv.slice(2),value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 if(!args.includes('--approve-fictional-submit'))throw Error('FICTIONAL_SUBMIT_APPROVAL_REQUIRED');
 const modulePath=value('--provider-module'),outputDir=value('--output'),executablePath=value('--chromium');
 if(!modulePath||!isAbsolute(modulePath)||!outputDir||!executablePath)throw Error('Require --provider-module /absolute/trusted.mjs --output NEW_DIRECTORY --chromium EXECUTABLE');
 // Executable trusted configuration, never selected by task/email/page/model content.
 const module=await import(pathToFileURL(modulePath).href);
 const providerOptions=await module.browserDemoProviderOptions() as Omit<AgentProviderOptions,'persist'>;
 const result=await runBrowserLoop({outputDir,executablePath,approveFictionalSubmit:true,provider:{kind:'nebius',options:providerOptions}});
 console.log(JSON.stringify(result));if(!result.accepted)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void cli().catch(()=>{console.error('Browser demo failed; inspect retained local run evidence. No automatic retry.');process.exitCode=1;});
