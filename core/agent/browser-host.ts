import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {Page, Browser} from 'playwright-core';
import type {ApplicationRevisionRef, RunOptions, Task, ToolContext, ToolDefinition, ToolResult} from './contracts.js';
import type {AgentStore} from '../storage/agent-store.js';
import {digest, type EvidenceStore, type Namespace} from '../evidence/store.js';
import type {ArtifactRef, EvidenceRef} from '../evidence/types.js';
import {createBrowserFormTools, type BrowserReceipt, type BrowserSubmissionIntent, type BrowserWriteRequest} from '../tools/browser-forms.js';
import {createBrowserFormHost, type ApprovedBrowserPost, type BrowserFormHost, type BrowserPacketDispatch} from '../tools/browser-form-host.js';

export interface TaskBrowserReview {
 revision:ApplicationRevisionRef;
 controls:readonly {name:string;id?:string;value:string|boolean|string[]}[];
 post:ApprovedBrowserPost;
 receiptUrl:string;
 /** Optional exact autosaves/uploads. Absence denies every non-submit network write. */
 effects?:readonly {operation:'fill'|'upload';name:string;post:ApprovedBrowserPost}[];
}
interface ReviewedArtifact {id:string;sha256:string;mimeType:string;bytes:number;field:string;filename:string}
export interface TaskBrowserReviewEvidence {review:TaskBrowserReview;files:ReviewedArtifact[]}
type SavedReview=TaskBrowserReviewEvidence;
interface Approval {
 id:string;requestId:string;authorityId:string;sessionId:string;destination:string;submissionUrl:string;revision:ApplicationRevisionRef;
 artifact:ArtifactRef;revoked:boolean;superseded?:boolean;
}
interface WriteFact {
 operation:BrowserWriteRequest['operation'];approvalId:string;inputHash:string;revision:ApplicationRevisionRef;
 runId:string;generation:number;pendingCallId:string;state:'intent'|'not_dispatched'|'dispatched'|'uncertain'|'verified';
 networkWrite:boolean;artifacts:string[];
}
interface Submission {
 intent:BrowserSubmissionIntent;approvalId:string;reviewArtifact:ArtifactRef;callId:string;
 state:'uncertain'|'verified';receipt?:BrowserReceipt;evidence?:EvidenceRef;artifacts:string[];uncertaintyCount:number;
}
/** Stored only in existing atomic Task JSON. No second ledger/outbox/database. */
export interface TaskBrowserState {
 approval?:Approval;approvalHistory?:{version:1;requests:Approval[]};writes:Record<string,WriteFact>;submission?:Submission;
 recovery:'clean'|'reconciliation_required';
}
export interface TaskBrowserOptions {
 tasks:AgentStore;store:EvidenceStore;namespace:Namespace;taskId:string;
 browser:Browser;sessionId:string;destination:string;submissionUrl:string;readUrls:readonly string[];allowLoopback?:boolean;
 /** Actual authenticated owner/session fence. Signal must also notify revision/authority changes. */
 authority:{id:string;signal:AbortSignal;isCurrent(task:Readonly<Task>):boolean;dispatch?:BrowserPacketDispatch};
 readReceipt(page:Page,intent:BrowserSubmissionIntent,context:ToolContext,review:Readonly<SavedReview>):Promise<BrowserReceipt|undefined>;
 timeoutMs?:number;maxBodyBytes?:number;maxReadRequests?:number;
}
const empty=():TaskBrowserState=>({approvalHistory:{version:1,requests:[]},writes:{},recovery:'clean'});
/** An array keeps opaque request IDs (including __proto__) out of object-key lookup. */
function requestHistory(s:TaskBrowserState):Approval[]|undefined {
 const h=s.approvalHistory;
 // Old code could forget any number of requests. Only a pristine state proves none existed.
 if(h===undefined)return s.approval||s.submission||Object.keys(s.writes).length?undefined:[];
 if(!h||h.version!==1||!Array.isArray(h.requests))fail('BROWSER_REQUEST_HISTORY_INVALID');
 const ids=new Set<string>(),requests=new Set<string>();
 for(const a of h.requests){if(!a||typeof a.id!=='string'||typeof a.requestId!=='string'||ids.has(a.id)||requests.has(a.requestId))fail('BROWSER_REQUEST_HISTORY_INVALID');ids.add(a.id);requests.add(a.requestId);}
 if(s.approval&&!h.requests.some(a=>same(a,s.approval)))fail('BROWSER_REQUEST_HISTORY_INVALID');
 return h.requests;
}
function fail(code:string):never{throw Error(code);}
const hash=(value:unknown)=>digest(Buffer.from(JSON.stringify(value)));
const unknown=(s:TaskBrowserState,except?:string)=>!!s.submission&&s.submission.callId!==except&&s.submission.state!=='verified'||Object.entries(s.writes).some(([id,w])=>id!==except&&['intent','uncertain'].includes(w.state));
function refresh(s:TaskBrowserState){s.recovery=unknown(s)?'reconciliation_required':'clean';}
const normalize=(v:string)=>v.replace(/\r\n|\r|\n/g,'\r\n');
const sorted=(values:unknown[])=>values.map(v=>JSON.stringify(v)).sort();
interface View {snapshotRef:string;revision?:ApplicationRevisionRef;fields:{ref:string;name:string;id:string;type:string}[];actions:{ref:string;form:{action:string;method:string}}[]}
interface FormState {
 action:{action:{action:string;method:string}};submitter:{name:string;value:string};
 fields:{ref:string;field:{name:string;id:string;type:string;disabled:boolean};value:{values?:string[];checked?:boolean;files?:{name:string;mimeType:string;bytes:number;sha256:string}[]}}[];
}

/** Trusted owner approve/revoke methods are NOT model tools. Shared runtime still owns admission. */
export async function createTaskBrowserTools(options:TaskBrowserOptions){
 const {tasks,store,taskId}=options,ns=Object.freeze({...options.namespace});
 let closed=false,view:View|undefined,active:ToolContext|undefined,activeArgs:unknown,host:BrowserFormHost;
 let delegates:ToolDefinition[]=[],opened=false,localApproval=new AbortController();
 let settled:Promise<void>=Promise.resolve(),finish=()=>{};
 const reads=new Map<string,{receipt:BrowserReceipt;count:number}>();
 const owned=()=>tasks.taskInNamespace(ns,taskId)??fail('BROWSER_TASK_NOT_FOUND');
 owned();
 function owner(t:Task){return !closed&&!options.authority.signal.aborted&&options.authority.isCurrent(t);}
 function context(ctx:ToolContext){
  const original=active;
  if(!original||ctx.taskId!==taskId||ctx.accountId!==ns.accountId||ctx.workspaceId!==ns.workspaceId||original.callId!==ctx.callId||original.runId!==ctx.runId||ctx.signal.aborted||original.signal.aborted||!original.isCurrent())fail('BROWSER_CONTEXT_CHANGED');
  const t=owned();if(!owner(t)||t.status!=='working'||t.run.id!==ctx.runId||!same(t.applicationRevision,original.applicationRevision))fail('BROWSER_CONTEXT_CHANGED');return t;
 }
 function runtimeAdmitted(t:Task,ctx:ToolContext,name:string){
  const pending=t.pending;if(pending?.effect!=='external_write')fail('BROWSER_RUNTIME_ADMISSION_REQUIRED');
  const decision=t.decisions.at(-1);
  if(!(pending.tool===name&&pending.callId===ctx.callId||pending.tool==='batch'&&decision?.kind==='batch'&&decision.calls.some(c=>c.callId===ctx.callId&&c.name===name)))fail('BROWSER_RUNTIME_ADMISSION_REQUIRED');
 }
 function saved(artifact:ArtifactRef):SavedReview {
  const actual=store.artifact(ns,artifact.id);if(!same(actual,artifact))fail('BROWSER_REVIEW_CHANGED');
  return JSON.parse(store.read(ns,artifact.id).toString()) as SavedReview;
 }
 function intact(review:SavedReview){
  for(const f of review.files){const a=store.artifact(ns,f.id);if(a.sha256!==f.sha256||a.mimeType!==f.mimeType||a.bytes!==f.bytes)fail('BROWSER_ATTACHMENT_CHANGED');store.read(ns,f.id,8*1024*1024);}
 }
 function authorization(t:Task,except?:string){
  const s=t.browser,a=s?.approval;
  if(!owner(t)||t.status==='cancelled'||!a||a.revoked||a.superseded||a.authorityId!==options.authority.id||a.sessionId!==options.sessionId||a.destination!==options.destination||a.submissionUrl!==options.submissionUrl||!same(a.revision,t.applicationRevision)||unknown(s!,except))return undefined;
  const retained=requestHistory(s!)?.find(r=>r.id===a.id);if(!retained||retained.revoked||retained.superseded||!same(retained,a))return undefined;
  const review=saved(a.artifact);intact(review);return {approval:a,saved:review};
 }
 function target(ref:unknown){return view?.fields.find(f=>f.ref===ref);}
 function control(review:TaskBrowserReview,field:{name:string;id:string}){
  const matches=review.controls.filter(c=>c.name===field.name&&(c.id===undefined||c.id===field.id));
  if(matches.length!==1)return undefined;
  const observed=view?.fields.filter(f=>f.name===field.name&&(matches[0]!.id===undefined||f.id===matches[0]!.id));
  return observed?.length===1?matches[0]:undefined;
 }
 function approvedArgs(t:Task,name:string,args:unknown){
  const a=authorization(t);if(!a||t.browser?.submission||!view||!same(view.revision,t.applicationRevision))return false;
  const value=args as {snapshotRef?:unknown;fieldRef?:unknown;actionRef?:unknown;value?:unknown;artifactId?:unknown};
  if(value?.snapshotRef!==view.snapshotRef)return false;
  if(name==='browser.submit')return view.actions.some(action=>action.ref===value.actionRef&&action.form.action===options.submissionUrl&&action.form.method==='post');
  const field=target(value.fieldRef);if(!field)return false;
  if(name==='browser.fill')return !!control(a.saved.review,field)&&same(control(a.saved.review,field)!.value,value.value);
  return name==='browser.upload'&&view.fields.filter(f=>f.name===field.name).length===1&&a.saved.review.post.files.filter(f=>f.field===field.name&&f.artifactId===value.artifactId).length===1;
 }
 const approveExternalWrite:NonNullable<RunOptions['approveExternalWrite']>=(task,tool,args)=>{
  try{return task.id===taskId&&task.sourceEvent.accountId===ns.accountId&&task.sourceEvent.workspaceId===ns.workspaceId&&['browser.fill','browser.upload','browser.submit'].includes(tool.name)&&owned().status==='working'&&owned().recovery==='clean'&&approvedArgs(owned(),tool.name,tool.inputSchema.parse(args));}catch{return false;}
 };
 const assertReady:NonNullable<RunOptions['assertReady']>=task=>{
  if(task.id!==taskId)fail('BROWSER_TASK_NOT_FOUND');const actual=owned();if(!owner(actual))fail('BROWSER_OWNER_NOT_CURRENT');const s=actual.browser;if(!s)return;
  if(unknown(s))fail('BROWSER_RECONCILIATION_REQUIRED');
  if(s.approval&&!s.approval.revoked&&s.submission?.state!=='verified')fail('BROWSER_SUBMISSION_VERIFICATION_REQUIRED');
  if(s.submission?.state==='verified'&&!same(s.submission.intent.revision,owned().applicationRevision))fail('BROWSER_RECEIPT_FOR_PRIOR_REVISION');
 };
 function matchesForm(input:FormState,review:SavedReview){
  if(input.action.action.action!==options.submissionUrl||input.action.action.method!=='post')return false;
  const fields:{name:string;value:string}[]=[],files:{field:string;filename:string;mimeType:string;bytes:number;sha256:string}[]=[];
  for(const f of input.fields){
   if(f.field.disabled||!f.field.name||['submit','image','reset','button'].includes(f.field.type))continue;
   if(f.value.checked===false)continue;
   for(const value of f.value.values??[])fields.push({name:f.field.name,value:normalize(value)});
   for(const file of f.value.files??[])files.push({field:f.field.name,filename:file.name,mimeType:file.mimeType,bytes:file.bytes,sha256:file.sha256});
  }
  if(input.submitter.name)fields.push({name:input.submitter.name,value:normalize(input.submitter.value)});
  const expected=review.review.post.fields.map(f=>({name:f.name,value:normalize(f.value)}));
  const expectedFiles=review.review.post.files.map(f=>{const a=review.files.find(a=>a.id===f.artifactId&&a.field===f.field&&a.filename===f.filename)!;return {field:f.field,filename:f.filename,mimeType:a.mimeType.toLowerCase(),bytes:a.bytes,sha256:a.sha256};});
  return same(sorted(fields),sorted(expected))&&same(sorted(files),sorted(expectedFiles));
 }
 function binding(intent:BrowserSubmissionIntent){const r=owned().browser?.submission;if(!r||!same(r.intent,intent))fail('BROWSER_INTENT_CHANGED');return r;}
 function settleWrite(callId:string,outcome:WriteFact['state']){
  tasks.update(taskId,t=>{const s=t.browser,w=s?.writes[callId];if(!s||!w)fail('BROWSER_WRITE_MISSING');
   if(!['verified','uncertain'].includes(w.state)&&!(w.state==='dispatched'&&outcome==='not_dispatched'))w.state=outcome;
   if(s.submission?.callId===callId&&s.submission.state==='verified')w.state='verified';refresh(s);
  });
 }
 async function construct(){
  host=await createBrowserFormHost({...options,accountId:ns.accountId,workspaceId:ns.workspaceId,
   dispatch:(guard,start,signal)=>{
    const current=()=>owner(owned())&&guard();
    if(options.authority.dispatch)return options.authority.dispatch(current,start,AbortSignal.any([signal,options.authority.signal]));
    if(!current())fail('BROWSER_OWNER_NOT_CURRENT');return Promise.resolve({started:start()});
   },
   revision:()=>owned().browser?.submission?.intent.revision??owned().applicationRevision,
   uploadName:artifact=>{const a=authorization(owned(),active?.callId);const field=target((activeArgs as {fieldRef?:unknown})?.fieldRef);const match=a?.saved.review.post.files.find(f=>f.artifactId===artifact.id&&f.field===field?.name);return match?.filename??fail('BROWSER_ATTACHMENT_NOT_REVIEWED');},
   authorize:async(request,ctx)=>{
    const t=context(ctx);runtimeAdmitted(t,ctx,'browser.'+request.operation);
    const a=authorization(t,ctx.callId),field=target(request.targetRef);
    if(!a||request.sessionId!==options.sessionId||request.destination!==options.destination||!same(request.revision,a.approval.revision)||request.snapshotRef!==view?.snapshotRef)return undefined;
    if(request.operation==='submit'){if(t.browser?.submission||!matchesForm(request.input as FormState,a.saved))return undefined;}
    else {
     if(!field)return undefined;const input=request.input as {field:{name:string;id:string};value?:unknown;artifactId?:string;sha256?:string;mimeType?:string;bytes?:number;name?:string};
     if(input.field.name!==field.name||input.field.id!==field.id)return undefined;
     if(request.operation==='fill'){const c=control(a.saved.review,field);if(!c||!same(c.value,input.value))return undefined;}
     else {const f=a.saved.files.find(f=>f.id===input.artifactId&&f.field===field.name&&f.filename===input.name);if(!f||f.sha256!==input.sha256||f.mimeType!==input.mimeType||f.bytes!==input.bytes)return undefined;}
    }
    const post=request.operation==='submit'?a.saved.review.post:a.saved.review.effects?.find(e=>e.operation===request.operation&&e.name===field?.name)?.post;
    tasks.update(taskId,actual=>{context(ctx);runtimeAdmitted(actual,ctx,'browser.'+request.operation);if(!authorization(actual,ctx.callId))fail('BROWSER_APPROVAL_CHANGED');
     const s=actual.browser??=empty();if(s.writes[ctx.callId])fail('BROWSER_WRITE_ALREADY_CLAIMED');
     s.writes[ctx.callId]={operation:request.operation,approvalId:a.approval.id,inputHash:request.inputHash,revision:request.revision,runId:ctx.runId,generation:actual.generation,pendingCallId:actual.pending!.callId,state:'intent',networkWrite:!!post,artifacts:[]};refresh(s);
    });
    return {signal:AbortSignal.any([options.authority.signal,localApproval.signal]),post,
     lease:{id:a.approval.id,isCurrent:()=>{try{const actual=context(ctx),w=actual.browser?.writes[ctx.callId];return !!w&&w.approvalId===a.approval.id&&!!authorization(actual,ctx.callId);}catch{return false;}},
      close:async outcome=>{settleWrite(ctx.callId,outcome);}}
    };
   },
   submissions:{
    current:async()=>owned().browser?.submission?.intent,
    claim:async(request,ctx)=>{
     const t=context(ctx);runtimeAdmitted(t,ctx,'browser.submit');let result!:{intent:BrowserSubmissionIntent;dispatch:boolean};
     tasks.update(taskId,actual=>{
      context(ctx);runtimeAdmitted(actual,ctx,'browser.submit');const s=actual.browser??=empty();
      if(s.submission){result={intent:s.submission.intent,dispatch:false};return;}
      const a=authorization(actual,ctx.callId),w=s.writes[ctx.callId];
      if(!a||!w||w.state!=='intent'||w.generation!==actual.generation||w.runId!==ctx.runId||w.pendingCallId!==actual.pending!.callId||w.inputHash!==request.inputHash)fail('BROWSER_CLAIM_CHANGED');
      if(actual.externalAction&&actual.externalAction.state!=='verified')fail('BROWSER_OTHER_ACTION_PENDING');
      const intent:BrowserSubmissionIntent={id:randomUUID(),sessionId:options.sessionId,destination:options.destination,revision:request.revision,inputHash:request.inputHash,receiptUrl:a.saved.review.receiptUrl,state:'uncertain'};
      s.submission={intent,approvalId:a.approval.id,reviewArtifact:a.approval.artifact,callId:ctx.callId,state:'uncertain',artifacts:[],uncertaintyCount:0};refresh(s);
      actual.externalAction={id:intent.id,authorizationId:a.approval.id,state:'intent'};result={intent,dispatch:true};
     });return result;
    },
    record:async(intent,next,ctx)=>{
     const record=binding(intent);let evidence:EvidenceRef|undefined;
     if(next==='verified'){
      context(ctx);const observed=reads.get(intent.id);if(!observed||observed.count<2)fail('BROWSER_RECEIPT_NOT_OBSERVED');
      const bytes=Buffer.from(JSON.stringify({intentId:intent.id,...observed.receipt}));
      const snapshot=store.put(ns,bytes,'application/json',[record.reviewArtifact.id],{provider:'web',originalUrl:intent.receiptUrl,providerId:intent.receiptUrl,providerVersion:digest(bytes)});
      evidence={id:snapshot.source!.id,sourceId:snapshot.source!.id,sourceVersion:snapshot.source!.providerVersion!,artifactId:snapshot.artifact.id};
     }
     tasks.update(taskId,t=>{const s=t.browser!,r=s.submission!;if(!same(r.intent,intent))fail('BROWSER_INTENT_CHANGED');
      if(next==='verified'){
       context(ctx);const observed=reads.get(intent.id);if(!observed||observed.count<2)fail('BROWSER_RECEIPT_NOT_OBSERVED');
       r.state='verified';r.receipt=structuredClone(observed.receipt);r.evidence=evidence;r.artifacts.push(evidence!.artifactId);const w=s.writes[r.callId];if(w)w.state='verified';
      }else r.uncertaintyCount++;
      if(t.externalAction?.id===intent.id)t.externalAction.state=r.state==='verified'?'verified':'uncertain';refresh(s);
     });
    }
   },
   readReceipt:async(page,intent,ctx)=>{
    context(ctx);const record=binding(intent),review=saved(record.reviewArtifact);
    const receipt=await options.readReceipt(page,intent,ctx,review);context(ctx);
    if(receipt){const prior=reads.get(intent.id);reads.set(intent.id,{receipt:structuredClone(receipt),count:prior&&same(prior.receipt,receipt)?prior.count+1:1});}
    return receipt;
   }
  });delegates=createBrowserFormTools(host.options);opened=false;
 }
 if(!options.authority.id||!owner(owned()))fail('BROWSER_OWNER_NOT_CURRENT');
 await construct();
 const stop=()=>{void host.close().catch(()=>{});};options.authority.signal.addEventListener('abort',stop,{once:true});
 const tools=delegates.map(definition=>({...definition,async invoke(args:unknown,ctx:ToolContext):Promise<ToolResult>{
  if(active)fail('BROWSER_SESSION_BUSY');active=ctx;activeArgs=args;settled=new Promise(resolve=>{finish=resolve;});
  const writes=definition.effect==='external_write';
  try {
   const t=context(ctx);
   if(writes&&!approvedArgs(t,definition.name,args))return {callId:ctx.callId,status:'needs_input',effect:'none',data:{nextAction:'Review current revision/authority or reconcile retained browser effects.'},artifacts:[],evidence:[],observations:[],error:{code:'BROWSER_APPROVAL_REQUIRED',message:'Exact current owner review is required.',producer:definition.name}};
   if(host.status().state!=='ready'){await host.close();await construct();view=undefined;}
   const intent=owned().browser?.submission?.intent;
   const effective:ToolContext={...ctx,...(intent?{applicationRevision:intent.revision}:{})};
   if(!opened){await host.open(effective);opened=true;}
   const tool=delegates.find(t=>t.name===definition.name)!;
   const result=await tool.invoke(args,effective);
   if(definition.name==='browser.inspect'&&result.status==='ok')view=structuredClone(result.data) as View;
   tasks.update(taskId,t=>{const s=t.browser,w=s?.writes[ctx.callId];if(w){w.artifacts.push(...result.artifacts.map(a=>a.id));if(result.status!=='ok'&&w.state==='intent')w.state='uncertain';}
    // A late-resolving read from an aborted/superseded context commits no evidence references.
    if(s?.submission&&definition.name==='browser.verify_submission'){context(ctx);s.submission.artifacts.push(...result.artifacts.map(a=>a.id));}if(s)refresh(s);
   });if(writes&&result.status!=='ok'&&!owned().browser?.writes[ctx.callId]&&!result.artifacts.length)result.effect='none';return result;
  }catch(error){if(writes&&owned().browser?.writes[ctx.callId])settleWrite(ctx.callId,'uncertain');throw error;}
  finally{active=undefined;activeArgs=undefined;finish();}
 }}));
 return {tools,execution:{approveExternalWrite,assertReady},
  approve(review:TaskBrowserReview,requestId:string){
   const t=owned();if(!owner(t)||t.status==='cancelled'||!same(t.applicationRevision,review.revision)||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))fail('BROWSER_REVIEW_NOT_CURRENT');
   if(t.browser&&unknown(t.browser))fail('BROWSER_RECONCILIATION_REQUIRED');
   if(review.post.url!==options.submissionUrl||review.controls.length>500||review.post.fields.length>500||review.post.files.length>16||(review.effects?.length??0)>16)fail('BROWSER_INVALID_REVIEW');
   const receipt=new URL(review.receiptUrl),dest=new URL(options.destination);
   if(receipt.origin!==dest.origin||receipt.username||receipt.password||receipt.hash||receipt.href!==review.receiptUrl||receipt.href===options.destination)fail('BROWSER_RECEIPT_DENIED');
   for(const c of review.controls)if((!c.name&&!c.id)||!(typeof c.value==='string'||typeof c.value==='boolean'||Array.isArray(c.value)&&c.value.every(v=>typeof v==='string')))fail('BROWSER_INVALID_CONTROL');
   const plans=[review.post,...(review.effects??[]).map(e=>e.post)];
   for(const effect of review.effects??[])if(effect.post.url===options.submissionUrl||!['fill','upload'].includes(effect.operation))fail('BROWSER_INVALID_EFFECT');
   const files:ReviewedArtifact[]=plans.flatMap(p=>p.files.map(f=>{const a=store.artifact(ns,f.artifactId);store.read(ns,a.id,8*1024*1024);return {id:a.id,sha256:a.sha256,mimeType:a.mimeType,bytes:a.bytes,field:f.field,filename:f.filename};}));
   const content:SavedReview={review:structuredClone(review),files},bytes=Buffer.from(JSON.stringify(content)),sha=digest(bytes);
   let approval!:Approval,created=false;
   tasks.update(taskId,actual=>{
    if(!owner(actual)||actual.status==='cancelled'||!same(actual.applicationRevision,review.revision))fail('BROWSER_REVIEW_NOT_CURRENT');
    const s=actual.browser??=empty();if(unknown(s))fail('BROWSER_RECONCILIATION_REQUIRED');
    const history=requestHistory(s);if(history===undefined)fail('BROWSER_REQUEST_HISTORY_UNAVAILABLE');
    const prior=history.find(a=>a.requestId===requestId);
    if(prior){
     if(prior.artifact.sha256!==sha||!same(prior.revision,review.revision)||prior.authorityId!==options.authority.id||prior.sessionId!==options.sessionId||prior.destination!==options.destination||prior.submissionUrl!==options.submissionUrl)fail('BROWSER_REQUEST_ID_CONFLICT');
     approval=prior;return; // Retained disposition only: never replace current authority or reset a signal.
    }
    if(s.submission)fail('BROWSER_SUBMISSION_ALREADY_CLAIMED');
    if(s.approval&&same(s.approval.revision,review.revision)&&s.approval.artifact.sha256!==sha)fail('BROWSER_REVIEW_CHANGED_WITHOUT_REVISION');
    // Serialize request admission before artifact creation: same-ID retries create neither duplicates.
    const artifact=store.put(ns,bytes,'application/json',[...new Set(files.map(f=>f.id))]).artifact;
    approval={id:randomUUID(),requestId,authorityId:options.authority.id,sessionId:options.sessionId,destination:options.destination,submissionUrl:options.submissionUrl,revision:structuredClone(review.revision),artifact,revoked:false,superseded:false};
    if(s.approval){const previous=history.find(a=>a.id===s.approval!.id)!;previous.revoked=true;previous.superseded=true;}
    (s.approvalHistory??={version:1,requests:[]}).requests.push(approval);s.approval=approval;created=true;
   });if(created){localApproval.abort();localApproval=new AbortController();}return structuredClone(approval);
  },
  async revoke(approvalId:string){owned();let revoked=false;tasks.update(taskId,t=>{
   const s=t.browser;if(!s)return;const retained=requestHistory(s)?.find(a=>a.id===approvalId);if(retained)retained.revoked=true;
   if(s.approval?.id===approvalId){s.approval.revoked=true;revoked=true;}
  });if(revoked){localApproval.abort();await host.close();}},
  async close(){closed=true;options.authority.signal.removeEventListener('abort',stop);await host.close();await settled;await host.close();},
  status():TaskBrowserState{return structuredClone(owned().browser??empty());}
 };
}
