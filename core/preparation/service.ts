import {createHash,randomUUID} from 'node:crypto';
import type {PaidTaskAdmission} from '../account/paid-task-quota.js';
import type {AgentProvider,Task,ToolContext,ToolDefinition,ToolResult,TrustedScope} from '../agent/contracts.js';
import {AgentRuntime} from '../agent/runtime.js';
import type {AgentStore} from '../storage/agent-store.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import {AgentSessionStore} from '../models/agent-session-store.js';
import type {SharedGoogle} from '../tracking/google.js';
import {googleSourceTools} from '../connectors/google/tools.js';
import {boundSaveHistory,type PreparationRecord,type PreparationSave,type PreparationAction,type PreparationStep} from './types.js';
import {preparationSession,visibleRecord} from './session.js';
import {preparationCitation} from './citations.js';
import {preparationTools,type PreparationExportContext} from './tools.js';
import {createDriveArtifactTool} from './drive-tool.js';
import {reconcilePreparationOutputs} from './reconcile.js';
import {preparationArtifactBinding,preparationArtifactCurrent,assertPreparationArtifactsCurrent} from './artifact-binding.js';
import {preparationBrowserReview,validatePreparationPortal,PreparationBrowserReviewFailure,type PreparationPortal,type PreparationBrowserSelection} from './browser-review.js';
import {continuePreparationPortal,reconcilePreparationPortal,PortalContinuationFailure,type PortalApproval,type PortalContinuationOptions} from './portal-continuation.js';
import type {PreparationBrowserContinuation,PreparationBrowserPhase} from './portal-production.js';
export type PreparationBinding=Awaited<ReturnType<SharedGoogle<any>['preparationBinding']>>;
export interface PreparationContext {taskId:string;namespace:Namespace;tasks:AgentStore;store:EvidenceStore;sessions:AgentSessionStore;binding:PreparationBinding;processingSignal:AbortSignal;outputApproval?:{snapshotId:string;artifactIds:readonly string[]};serializeOutput<T>(operation:()=>Promise<T>):Promise<T>;track<T>(operation:Promise<T>):Promise<T>;scope():TrustedScope}
export interface PreparationConfig {
 /** Trusted destination only; account/model input cannot configure an effect target. */
 browserPortal?:PreparationPortal;
 /** Explicit operator browser-continuation wiring (developer-fictional destination only). Absent = no
  * approval/execution endpoint; the service owns its browser and closes it on shutdown. */
 browserContinuation?:PreparationBrowserContinuation;
 /** Trusted operator startup setting. Reading status never releases this hold or schedules old work. */
 processingPaused?:boolean;processingPauseReason?:string;
 tasks:AgentStore;store:EvidenceStore;workspaceId:string;buildIdentity:string;sourceIdentity?:{revision:string;tree?:string};
 provider:(context:PreparationContext)=>AgentProvider;
 tools:(context:PreparationContext)=>ToolDefinition[]|Promise<ToolDefinition[]>;
 /** Optional one-line description of a newly read image source (e.g. via the vision model), shown next to its name. */
 describeSource?:(context:PreparationContext,ctx:ToolContext,sourceId:string)=>Promise<string|undefined>;
 maxTurns?:number;timeoutMs?:number;toolBudget?:number;
 limits?:{limitUsd:number;maximumDecisionCalls:number;maximumVisionCalls:number};
 modelStatus?:{endpoint:string;globalLimitUsd:number;maximumWholeTaskReservationUsd:number;decision:{modelId:string;inputContextTokens:number;maxOutputTokens:number};vision:{modelId:string;inputContextTokens:number;maxOutputTokens:number;imageTokensUpperBound:number;imageAccounting:'input-tokens'}};
}
/** A file attached to the email that asked for this preparation. */
export interface EmailAttachmentInput {name:string;mimeType:string;providerId:string;bytes:Uint8Array}
export class PreparationFailure extends Error {constructor(readonly status:number,code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new PreparationFailure(status,code);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v);
const manualReconciliation=(t:Task)=>t.pending?.effect==='write_local'||t.pending?.tool==='batch'||t.recovery==='reconciliation_required'&&t.pending?.tool!=='drive.create_artifact';
const saveReceipt=({events,...save}:PreparationSave)=>structuredClone(save);
const receipt=(t:Task)=>({taskId:t.id,revision:t.preparation!.revision,state:t.status,generation:t.generation});
type PortalView={action:'approve'|'reconcile';state:'running'|'verified'|'held'|'cancelled'|'refused';requestId?:string;code?:string;interruption?:string;submission?:string;observedAt:string};
/** Module refusals cross the account API as fixed PREPARATION_* codes only. */
const portalCode=(error:unknown)=>error instanceof PortalContinuationFailure?error.message.replace(/^PORTAL_CONTINUATION_/,'PREPARATION_PORTAL_'):error instanceof PreparationBrowserReviewFailure||error instanceof PreparationFailure?error.message:'PREPARATION_PORTAL_UNAVAILABLE';
const portalStatus=(code:string)=>/INVALID_SELECTION|INVALID_APPROVAL/.test(code)?400:/NOT_CONFIGURED|INVALID_DESTINATION|STOPPING/.test(code)?503:code==='PREPARATION_PROCESSING_PAUSED'?423:409;
/** Inert display projection of the browser facts retained on the Task (no capability). */
function browserView(t:Task){
 const s=t.browser;if(!s)return null;const a=s.approval,r=s.submission;
 return {recovery:s.recovery,writes:Object.keys(s.writes).length,approval:a?{id:a.id,requestId:a.requestId,revoked:a.revoked,superseded:!!a.superseded,revision:a.revision}:null,submission:r?{state:r.state,approvalId:r.approvalId,destination:r.intent.destination,receiptUrl:r.intent.receiptUrl,revision:r.intent.revision,receipt:r.receipt??null,evidenceArtifactId:r.evidence?.artifactId??null}:null};
}
const revisionHash=(p:PreparationRecord)=>createHash('sha256').update(JSON.stringify([p.request,p.revision,p.revisions])).digest('hex');
/** Authenticated facade over the existing runtime/stores. No alternate planner or tool DAG. */
export class PreparationService {
 private resuming=new Set<string>();
 private jobs=new Set<Promise<void>>();private queued=new Set<string>();private runtimes=new Map<string,AgentRuntime>();private tail:Promise<void>=Promise.resolve();private stopping=false;private operations=new Set<Promise<unknown>>();private continuations=new Map<string,{task:Task;owner:string;session:string;actionId:string}>();private controllers=new Map<string,AbortController>();private releaseOwner:()=>void;private outputTail:Promise<unknown>=Promise.resolve();private activeSaveCalls=new Set<string>();
 private portals=new Map<string,{cancel:AbortController;authority:AbortController}>();private portalOutcomes=new Map<string,PortalView>();
 readonly sessions:AgentSessionStore;
 constructor(private config:PreparationConfig,private bind:(owner:string,session:string,connection:string,root:string)=>Promise<PreparationBinding>,private admitPaidTask?:PaidTaskAdmission,private documentNames?:(owner:string)=>Promise<readonly string[]>){
  for(const [v,max]of [[config.maxTurns??16,64],[config.timeoutMs??300000,3600000],[config.toolBudget??128,1024]])if(!Number.isSafeInteger(v)||v<1||v>max)throw Error('INVALID_PREPARATION_BOUND');
  const l=config.limits;if(l&&(!Number.isFinite(l.limitUsd)||l.limitUsd<=0||l.limitUsd>2||!Number.isSafeInteger(l.maximumDecisionCalls)||l.maximumDecisionCalls<1||l.maximumDecisionCalls>64||!Number.isSafeInteger(l.maximumVisionCalls)||l.maximumVisionCalls<0||l.maximumVisionCalls>16))throw Error('INVALID_PREPARATION_BUDGET');
  if(config.browserPortal!==undefined)config.browserPortal=validatePreparationPortal(config.browserPortal);
  this.sessions=new AgentSessionStore(config.store.db);this.releaseOwner=config.tasks.claimPreparationOwner();
 }
 private owned(owner:string,taskId:unknown):Task {if(!id(taskId))return fail(400,'INVALID_TASK_ID');const task=this.config.tasks.taskInNamespace({workspaceId:this.config.workspaceId,accountId:owner},taskId);if(!task?.preparation)return fail(404,'PREPARATION_NOT_FOUND');let changed=false;for(const save of task.preparation.saves??[])changed=boundSaveHistory(save,this.activeSaveCalls)||changed;if(changed)return this.config.tasks.update(task.id,t=>{for(const save of t.preparation!.saves??[])boundSaveHistory(save,this.activeSaveCalls);});return task;}
 private async reconcilePaidTask(task:Task){
  await this.admitPaidTask?.reconcile(task.sourceEvent.accountId,JSON.stringify([task.sourceEvent.workspaceId,task.sourceEvent.accountId,task.sourceEvent.messageId]),task.id);
 }
 private localContext(task:Task):PreparationExportContext {
  const namespace={workspaceId:this.config.workspaceId,accountId:task.sourceEvent.accountId};
  const names=this.documentNames;
  return {taskId:task.id,namespace,tasks:this.config.tasks,store:this.config.store,sessions:this.sessions,...(names?{documentNames:()=>names(namespace.accountId)}:{}),scope:()=>{const p=this.config.tasks.get(task.id).preparation!;return {sources:structuredClone(p.sources),destinations:[p.rootId],grants:p.processingConsent?['image.processing','document.processing','ocr.processing']:[]};}};
 }
 private context(task:Task,binding:PreparationBinding,processingSignal:AbortSignal):PreparationContext {
  return {...this.localContext(task),binding,processingSignal,track:operation=>this.track(operation),serializeOutput:operation=>{const job=this.outputTail.catch(()=>{}).then(operation);this.outputTail=job;return job;}};
 }
 private async binding(task:Task,owner:string,session:string){const p=task.preparation!,b=await this.bind(owner,session,p.connectionId,p.rootId);if(b.incarnation!==p.incarnation||b.rootRevision!==p.rootRevision||b.googleAccountId!==p.googleAccountId)fail(409,'PREPARATION_CONNECTION_CHANGED');return b;}
 private audit(task:Task,session:string,action:PreparationAction['action'],actionId:string,disposition:string,intentHash?:string){
  this.config.tasks.recordPreparationAction({workspaceId:this.config.workspaceId,accountId:task.sourceEvent.accountId},{action,actionId,disposition,taskId:task.id,runId:task.run.id,generation:task.generation,observedAt:new Date().toISOString(),caller:'account_api',sessionCorrelation:createHash('sha256').update('preparation-action:'+session).digest('hex').slice(0,32),...(intentHash?{intentHash}:{})});
 }
 private assertProcessing(){if(this.config.processingPaused)fail(423,'PREPARATION_PROCESSING_PAUSED');}
 private execution(task:Task){
  if(this.portals.has(task.id))return {...task.preparation!.execution,state:'running',phase:'browser_submission'};
  const state=this.controllers.has(task.id)?'running':this.queued.has(task.id)?'queued':task.status==='working'?'interrupted':'idle';
  return {...task.preparation!.execution,state,phase:state==='interrupted'?'interrupted':task.preparation!.execution?.phase??task.status};
 }
 private browserApproval(){
  const c=this.config.browserContinuation;
  return c?{available:!this.config.processingPaused,mode:c.mode,destination:c.destination,...(this.config.processingPaused?{reason:'PREPARATION_PROCESSING_PAUSED'}:{})}:{available:false,reason:'PREPARATION_BROWSER_APPROVAL_NOT_CONFIGURED'};
 }
 private busy(taskId:string){return this.controllers.has(taskId)||this.queued.has(taskId)||this.resuming.has(taskId)||this.portals.has(taskId);}
 async handle(owner:string,session:string,path:string,data:Record<string,unknown>,options:{signal?:AbortSignal;emailAttachments?:readonly EmailAttachmentInput[]}={}):Promise<unknown>{
  if(this.stopping)fail(503,'PREPARATION_STOPPING');
  const fields:Record<string,string[]>={'/preparation/config':[],'/preparation/list':[],'/preparation/save':['taskId','expectedRevision','kind','requestId','saveOutputs'],'/preparation/request':['connectionId','rootId','request','requestId','processingConsent','saveOutputs','newIntent'],'/preparation/status':['taskId'],'/preparation/browser-review':['taskId','expectedRevision','fields','files'],'/preparation/browser-approve':['taskId','expectedRevision','fingerprint','requestId'],'/preparation/browser-reconcile':['taskId'],'/preparation/correct':['taskId','expectedRevision','fieldId','value'],'/preparation/resume':['taskId','expectedGeneration','requestId'],'/preparation/cancel':['taskId'],'/preparation/artifact':['taskId','artifactId'],'/preparation/source':['taskId','operation','fileId']};
  if(!fields[path])fail(404,'NOT_FOUND');if(Object.keys(data).some(k=>!fields[path]!.includes(k)))fail(400,'INVALID_PREPARATION_FIELDS');
  if(path==='/preparation/config')return {configured:true,processingPaused:this.config.processingPaused===true,processingPauseReason:visibleRecord(this.config.processingPauseReason??'Processing is paused by the operator; review retained work before any new execution.'),models:this.config.modelStatus??null,limits:this.config.limits??{limitUsd:0.3,maximumDecisionCalls:16,maximumVisionCalls:3},modes:['local_draft','drive_outputs'],requiresProcessingConsent:true,sourceIdentity:this.config.sourceIdentity??null,buildIdentity:this.config.buildIdentity,readiness:{credentials:'lazy_not_checked',processing:'explicit_request_consent_required',writePermission:'not_assumed',liveAcceptance:'unverified'},browserApproval:this.browserApproval()};
  if(path==='/preparation/list')return {tasks:this.config.tasks.tasks({workspaceId:this.config.workspaceId,accountId:owner}).filter(t=>t.preparation).map(t=>({...receipt(t),request:t.requestedOutcome.slice(0,160),connectionId:t.preparation!.connectionId,rootId:t.preparation!.rootId,execution:this.execution(t)})),limit:100};
  if(path==='/preparation/request'){
   if(!id(data.connectionId)||!id(data.rootId)||!id(data.requestId)||typeof data.request!=='string'||!data.request.trim()||Buffer.byteLength(data.request)>16384||data.processingConsent!==true||typeof data.saveOutputs!=='boolean')fail(400,'INVALID_PREPARATION_REQUEST');
   if(data.newIntent!==undefined&&typeof data.newIntent!=='boolean')fail(400,'INVALID_PREPARATION_REQUEST');
   const ns={workspaceId:this.config.workspaceId,accountId:owner},intentHash=createHash('sha256').update(JSON.stringify([data.connectionId,data.rootId,data.request,data.saveOutputs])).digest('hex');
   const retained=()=>{
    const action=this.config.tasks.preparationAction(ns,data.requestId as string),byId=this.config.tasks.preparationForRequest(ns,data.requestId as string);
    if(action&&action.intentHash!==intentHash)fail(409,'REQUEST_ID_CONFLICT');
    if(action)return this.owned(owner,action.taskId);
    const exact=byId;
    if(exact?.preparation){const p=exact.preparation;if(p.request!==data.request||p.connectionId!==data.connectionId||p.rootId!==data.rootId||p.saveOutputs!==data.saveOutputs)fail(409,'REQUEST_ID_CONFLICT');return exact;}
    const match=this.config.tasks.preparationForIntent(ns,data.rootId as string,data.request as string);
    return match&&(data.newIntent!==true||match.status==='working')?match:undefined;
   };
   let previous=retained();if(previous){await this.reconcilePaidTask(previous);previous=this.owned(owner,previous.id);this.audit(previous,session,'request',data.requestId as string,'retained',intentHash);return receipt(previous);}
   this.assertProcessing();
   const b=await this.bind(owner,session,data.connectionId as string,data.rootId as string);
   // Recheck after binding and again after durable quota reservation: two tabs
   // cannot admit the same exact intent twice.
   previous=retained();if(previous){await this.reconcilePaidTask(previous);previous=this.owned(owner,previous.id);this.audit(previous,session,'request',data.requestId as string,'retained',intentHash);return receipt(previous);}
   let admitted=false;
   const create=()=>{
    const existing=retained();if(existing)return existing;
    return this.config.tasks.admitPreparation({workspaceId:this.config.workspaceId,accountId:owner,messageId:`preparation:${data.requestId}`,outcome:data.request as string},this.config.toolBudget??128,t=>{
     if(t.preparation){const p=t.preparation;if(p.request!==data.request||p.connectionId!==data.connectionId||p.rootId!==data.rootId||p.saveOutputs!==data.saveOutputs)fail(409,'REQUEST_ID_CONFLICT');this.audit(t,session,'request',data.requestId as string,'retained',intentHash);return;}
     // Fail audit capacity/storage before creating an artifact or committing admission.
     this.audit(t,session,'request',data.requestId as string,'admitted',intentHash);
     const input=this.config.store.put({workspaceId:this.config.workspaceId,accountId:owner},Buffer.from(data.request as string,'utf8'),'text/plain',[],{provider:'user',accountId:owner,providerId:data.requestId as string,providerVersion:'1'});
     const l=this.config.limits??{limitUsd:0.3,maximumDecisionCalls:16,maximumVisionCalls:3};
     // Files attached to the request email (trusted host input from the inbox, never from the HTTP body) become sources beside the Drive folder.
     const attached=(options.emailAttachments??[]).slice(0,5).map(a=>({name:a.name,...this.config.store.put({workspaceId:this.config.workspaceId,accountId:owner},a.bytes,a.mimeType,[],{provider:'gmail',accountId:owner,providerId:a.providerId,providerVersion:'1'})}));
     t.preparation={connectionId:data.connectionId as string,rootId:data.rootId as string,requestId:data.requestId as string,request:data.request as string,incarnation:b.incarnation,rootRevision:b.rootRevision,googleAccountId:b.googleAccountId,revision:1,processingConsent:true,saveOutputs:data.saveOutputs as boolean,sources:[input.source!,...attached.map(a=>a.source!)],sourceNames:{[data.requestId as string]:'Your request',...Object.fromEntries(attached.map(a=>[a.source!.providerId!,a.name]))},artifactRevisions:Object.fromEntries([input.artifact.id,...attached.map(a=>a.artifact.id)].map(id=>[id,1])),artifactIds:[input.artifact.id,...attached.map(a=>a.artifact.id)],fields:[],revisions:[],uploads:[],modelBudget:{...l,decisionCalls:0,visionCalls:0,reservedUsd:0}};
     t.preparation.execution={state:'queued',phase:'queued',observedAt:new Date().toISOString()};
     t.applicationRevision={applicationId:t.id,revision:1,contentHash:revisionHash(t.preparation)};admitted=true;
    });
   };
   const task=this.admitPaidTask?await this.admitPaidTask(owner,JSON.stringify([this.config.workspaceId,owner,'preparation:'+data.requestId]),create):create();
   await this.reconcilePaidTask(task);
   if(admitted)this.enqueue(task,owner,session);return receipt(task);
  }
  let t=this.owned(owner,data.taskId);
  t=this.recoverInterrupted(t);
  if(!['/preparation/cancel','/preparation/status','/preparation/artifact','/preparation/browser-review'].includes(path)){
   await this.reconcilePaidTask(t);t=this.owned(owner,t.id);
  }
  if(path==='/preparation/browser-review'){
   const c=this.config.browserContinuation,ns={workspaceId:this.config.workspaceId,accountId:owner};
   if(!c&&!this.config.browserPortal)fail(503,'PREPARATION_BROWSER_NOT_CONFIGURED');
   const empty=(v:unknown)=>v===undefined||Array.isArray(v)&&!v.length;
   // With configured continuation the field/file mapping is server-owned; the page supplies none.
   if(c&&(!empty(data.fields)||!empty(data.files)))fail(400,'PREPARATION_BROWSER_MAPPING_SERVER_OWNED');
   try{
    const target=c?.target(t,this.config.store,ns);
    const selection=(target?{expectedRevision:data.expectedRevision,...target.selection}:{expectedRevision:data.expectedRevision,fields:data.fields,files:data.files}) as PreparationBrowserSelection;
    const {assertCurrent,...snapshot}=preparationBrowserReview(this.config.tasks,this.config.store,ns,t.id,selection,target?.portal??this.config.browserPortal!);
    // Read only: no browser construction, approval, provider or continuation.
    return target?{...snapshot,required:target.required,approval:this.browserApproval()}:snapshot;
   }catch(error){if(error instanceof PreparationBrowserReviewFailure)fail(error.message==='PREPARATION_BROWSER_INVALID_SELECTION'?400:error.message==='PREPARATION_BROWSER_INVALID_DESTINATION'?503:409,error.message);throw error;}
  }
  if(path==='/preparation/browser-approve'||path==='/preparation/browser-reconcile')return this.portalRun(t,owner,session,path==='/preparation/browser-approve'?'approve':'reconcile',data,options.signal);
  if(path==='/preparation/save'){if(this.portals.has(t.id))fail(409,'PREPARATION_ALREADY_WORKING');return this.saveTask(owner,session,t,data);}
  if(path==='/preparation/status'){
   const p=t.preparation!,ns={workspaceId:this.config.workspaceId,accountId:owner};
   return {...receipt(t),actionHistory:{retained:this.config.tasks.preparationActionCount(ns,t.id),window:64,coverage:'since_instrumentation_only'},connectionId:p.connectionId,rootId:p.rootId,googleAccountId:p.googleAccountId,execution:this.execution(t),browser:browserView(t),portal:this.portalOutcomes.get(t.id)??null,canReconcile:!!this.config.browserContinuation&&!this.config.processingPaused&&!this.busy(t.id)&&t.status==='blocked'&&!!t.browser?.submission&&t.browser.submission.state!=='verified'&&!t.pending&&t.recovery==='clean',steps:p.steps??{},processingPaused:this.config.processingPaused===true,processingPauseReason:visibleRecord(this.config.processingPauseReason),canResume:!this.config.processingPaused&&t.status==='blocked'&&!this.queued.has(t.id)&&!this.resuming.has(t.id)&&!manualReconciliation(t)&&!p.uploads.some(u=>u.state!=='verified'),actions:this.config.tasks.preparationActions(ns,t.id),processingConsent:p.processingConsent,saveOutputs:p.saveOutputs,mode:p.saveOutputs?'drive_outputs':'local_draft',models:this.config.modelStatus??null,request:p.request,checklist:t.checklist,recovery:t.recovery,blocker:visibleRecord(t.blocker),nextAction:visibleRecord(t.nextAction),fields:p.fields.map(f=>({...f,citations:f.citations.map(e=>preparationCitation(this.config.store,ns,t,e))})),sources:p.sources.map(({originalUrl,...s})=>({...s,name:p.sourceNames?.[s.providerId??'']})),artifacts:p.artifactIds.map(a=>{const {relativePath,...artifact}=this.config.store.artifact(ns,a);return {...artifact,revision:p.artifactRevisions?.[a],current:preparationArtifactCurrent(this.config.store,ns,p,a)};}),outputs:p.uploads.map(({intent,...u})=>({...u,current:preparationArtifactCurrent(this.config.store,ns,p,u.artifactId)})),session:preparationSession(t,this.sessions,this.config.buildIdentity,this.config.sourceIdentity),result:t.currentResult,budget:p.modelBudget,saves:(p.saves??[]).map(({events,...s})=>s)};
  }
  if(path==='/preparation/artifact'){
   if(!id(data.artifactId)||!t.preparation!.artifactIds.includes(data.artifactId))fail(404,'PREPARATION_ARTIFACT_NOT_FOUND');
   const ns={workspaceId:this.config.workspaceId,accountId:owner},artifact=this.config.store.artifact(ns,data.artifactId as string);
   return {binary:this.config.store.read(ns,artifact.id),mimeType:artifact.mimeType};
  }
  if(path==='/preparation/source')return this.sourceDiagnostic(t,owner,session,data);
  if(path==='/preparation/cancel'){
   // Owner stop must not depend on audit capacity, nor leave a queued successor.
   this.portals.get(t.id)?.cancel.abort();this.continuations.delete(t.id);this.queued.delete(t.id);
   this.controllers.get(t.id)?.abort();this.runtimes.get(t.id)?.cancel(t.id);
   const stopped=this.config.tasks.update(t.id,t=>{t.generation++;t.status='cancelled';t.preparation!.processingConsent=false;t.preparation!.execution={state:'idle',phase:'cancelled',observedAt:new Date().toISOString(),reason:'owner_cancel'};t.nextAction='Processing cancelled through the authenticated account API';});
   try{this.audit(stopped,session,'cancel',randomUUID(),'requested');}
   catch{this.config.tasks.update(t.id,t=>{t.nextAction='Processing cancelled; action audit unavailable. No processing was restarted.';});}
   return receipt(this.config.tasks.get(t.id));
  }
  if(path==='/preparation/correct'){
   this.assertProcessing();if(this.portals.has(t.id))fail(409,'PREPARATION_ALREADY_WORKING');   if(!id(data.fieldId)||typeof data.value!=='string'||data.value.length>8192||!Number.isSafeInteger(data.expectedRevision))fail(400,'INVALID_PREPARATION_CORRECTION');
   if(t.status==='cancelled')fail(409,'PREPARATION_CANCELLED');if(t.preparation!.revision!==data.expectedRevision)fail(409,'STALE_PREPARATION_REVISION');
   if(t.pending&&t.pending.effect!=='read'||t.recovery!=='clean')fail(409,'PREPARATION_RECONCILIATION_REQUIRED');
   const generation=t.generation,binding=await this.binding(t,owner,session);await binding.assertCurrent();const actionId=randomUUID();
   t=this.config.tasks.update(t.id,t=>{if(t.status==='cancelled')fail(409,'PREPARATION_CANCELLED');if(t.pending&&t.pending.effect!=='read'||t.recovery!=='clean')fail(409,'PREPARATION_RECONCILIATION_REQUIRED');const p=t.preparation!;if(p.revision!==data.expectedRevision||t.generation!==generation)fail(409,'STALE_PREPARATION_REVISION');const f=p.fields.find(f=>f.id===data.fieldId);if(!f)fail(404,'PREPARATION_FIELD_NOT_FOUND');p.revision++;f!.value=data.value as string;f!.unresolved=false;f!.corrected=true;p.revisions.push({revision:p.revision,fieldId:f!.id,value:f!.value});t.generation++;delete t.pending;delete t.currentResult;delete t.blocker;t.status='working';t.applicationRevision={applicationId:t.id,revision:p.revision,contentHash:revisionHash(p)};t.nextAction='Prepare corrected revision from retained sources';this.audit(t,session,'correct',actionId,'accepted');});
   // CAS invalidates the old generation first. Aborting this lease supersedes only
   // that run; its actual invocations drain before the queued successor starts.
   this.controllers.get(t.id)?.abort();
   this.enqueue(t,owner,session,actionId);return receipt(t);
  }
  return this.resumeTask(t,owner,session,data);
 }
 /** Owner-approved browser continuation (or read-only receipt reconcile) on the SAME task, runtime
  * and stores via the reviewed module. Admission is synchronous; the run is a service-owned job
  * because the account client bounds each request to 10 s. Its authority is the signed-in session
  * plus the task's bound connection/root/grant: it retires on signout, session/root/grant/epoch
  * change, owner cancel or service close, never on task generation, so it survives recover(). */
 private async portalRun(t:Task,owner:string,session:string,action:'approve'|'reconcile',data:Record<string,unknown>,request?:AbortSignal){
  const c=this.config.browserContinuation;if(!c)return fail(503,'PREPARATION_BROWSER_APPROVAL_NOT_CONFIGURED');
  this.assertProcessing();
  let approval:PortalApproval|undefined;
  if(action==='approve'){
   if(!Number.isSafeInteger(data.expectedRevision)||typeof data.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(data.fingerprint)||!id(data.requestId)||(data.requestId as string).length>128)fail(400,'INVALID_PREPARATION_APPROVAL');
   approval={expectedRevision:data.expectedRevision as number,fingerprint:data.fingerprint as string,requestId:data.requestId as string};
  }
  if(this.busy(t.id))fail(409,'PREPARATION_ALREADY_WORKING');
  const run={cancel:new AbortController(),authority:new AbortController()};this.portals.set(t.id,run);
  let unobserve=()=>{},started=false;
  try{
   const ns={workspaceId:this.config.workspaceId,accountId:owner},b=await this.binding(t,owner,session);
   unobserve=b.observe(()=>run.authority.abort());
   // A request whose client already went away never starts a browser run.
   if(request?.aborted)fail(409,'PREPARATION_REQUEST_DISCONNECTED');
   if(this.stopping)fail(503,'PREPARATION_STOPPING');this.assertProcessing();if(run.cancel.signal.aborted)fail(409,'PREPARATION_CANCELLED');
   const task=this.owned(owner,t.id),target=c.target(task,this.config.store,ns);
   let review:PreparationBrowserPhase['review']={controls:[],files:[]};
   if(approval){
    // Read-only precheck so a stale approval starts nothing; a used request id is left to the module's replay rules.
    const used=task.browser?.approvalHistory?.requests.some(a=>a.requestId===approval!.requestId);
    try{const shown=preparationBrowserReview(this.config.tasks,this.config.store,ns,t.id,{expectedRevision:approval.expectedRevision,...target.selection},target.portal);
     if(!used&&shown.fingerprint!==approval.fingerprint)fail(409,'PREPARATION_PORTAL_REVIEW_CHANGED');
     review={controls:shown.review.controls.map(c=>({name:c.name,value:c.value})),files:[...shown.review.post.files]};}
    catch(error){if(!used||!(error instanceof PreparationBrowserReviewFailure))throw error;}
   }
   const signal=run.authority.signal,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,32);
   const isCurrent=(x:Readonly<Task>)=>{const p=x.preparation;return !signal.aborted&&!this.stopping&&!this.config.processingPaused&&x.id===t.id&&x.sourceEvent.accountId===owner&&x.sourceEvent.workspaceId===this.config.workspaceId&&x.status!=='cancelled'&&!!p&&p.processingConsent&&p.connectionId===b.connectionId&&p.rootId===b.rootId&&p.incarnation===b.incarnation&&p.rootRevision===b.rootRevision&&p.googleAccountId===b.googleAccountId;};
   const dispatch=<T,>(guard:()=>boolean,start:()=>T,s?:AbortSignal)=>b.guardedDispatch(guard,start,{signal:s?AbortSignal.any([s,signal]):signal});
   const browser=await c.browser(),context=this.context(task,b,signal);
   if(request?.aborted)fail(409,'PREPARATION_REQUEST_DISCONNECTED');
   const options:PortalContinuationOptions={tasks:this.config.tasks,store:this.config.store,namespace:ns,taskId:t.id,target,caller:'account_api',cancel:run.cancel.signal,
    browser:{browser,sessionId:hash(['preparation-browser-session',session]),readUrls:[],allowLoopback:c.allowLoopback,timeoutMs:c.browserTimeoutMs,readReceipt:c.readReceipt,
     authority:{id:hash(['preparation-browser-authority',session,b.incarnation,b.rootRevision,b.connectionEpoch,b.googleAccountId]),signal,isCurrent,dispatch:(guard,start,s)=>dispatch(guard,start,s)}},
    preflight:async s=>{await b.assertCurrent({signal:s});await b.assertSources(context.scope().sources,{signal:s});},
    provider:c.provider(context,{review,isCurrent:()=>isCurrent(this.config.tasks.get(t.id)),dispatch}),maxTurns:c.maxTurns,timeoutMs:c.timeoutMs,
    getScope:()=>({sources:structuredClone(this.config.tasks.get(t.id).preparation!.sources),destinations:[target.portal.destination],grants:[]}),
    assertReady:x=>assertPreparationArtifactsCurrent(this.config.store,ns,x)};
   const observedAt=()=>new Date().toISOString();
   this.portalOutcomes.set(t.id,{action,state:'running',...(approval?{requestId:approval.requestId}:{}),observedAt:observedAt()});
   const job=(async()=>{
    let view:PortalView;
    try{const o=approval?await continuePreparationPortal(options,approval):await reconcilePreparationPortal(options);
     view={action,state:o.state,...(approval?{requestId:approval.requestId}:{}),...(o.state==='held'?{code:o.code.replace(/^PORTAL_CONTINUATION_/,'PREPARATION_PORTAL_'),...(o.interruption?{interruption:o.interruption}:{})}:{}),...(o.state!=='verified'&&o.submission?{submission:o.submission}:{}),observedAt:observedAt()};}
    catch(error){view={action,state:'refused',...(approval?{requestId:approval.requestId}:{}),code:portalCode(error),observedAt:observedAt()};}
    finally{unobserve();run.authority.abort();this.portals.delete(t.id);}
    this.portalOutcomes.set(t.id,view);
   })();
   started=true;this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));
   return {...receipt(this.config.tasks.get(t.id)),browser:{action,state:'running'}};
  }catch(error){
   // Typed account/Google failures keep their own fixed codes; module/review refusals are mapped.
   if(error instanceof PreparationFailure||typeof (error as {status?:unknown})?.status==='number')throw error;
   const code=portalCode(error);fail(portalStatus(code),code);
  }finally{if(!started){unobserve();this.portals.delete(t.id);}}
 }
 /** A run cut off by a service restart (deploy or memory kill) is left 'working' with nothing running it. When its
  * in-flight call could only have read or written local results, record that call as not completed (no effect)
  * and block the task so the owner, or the inbox, can resume it. External writes keep their reconciliation path. */
 private recoverInterrupted(t:Task):Task{
  // The 30 s grace avoids racing admission, which marks a task working just before queueing it.
  const seen=Date.parse(t.preparation?.execution?.observedAt??'');
  if(t.status!=='working'||this.busy(t.id)||this.stopping||t.pending?.effect==='external_write'||!(Date.now()-seen>30_000))return t;
  return this.config.tasks.update(t.id,x=>{
   if(x.status!=='working'||x.pending?.effect==='external_write')return;
   if(x.pending){x.observations.push({effect:'none',callId:x.pending.callId,status:'failed',data:null,artifacts:[],evidence:[],observations:['The service restarted during this call, so it did not complete. Run it again if it is still needed.'],error:{code:'INTERRUPTED',message:'Interrupted by a service restart',producer:'runtime'}});delete x.pending;x.run.cursor++;}
   x.status='blocked';x.blocker='PREPARATION_INTERRUPTED';x.nextAction='Resume to continue from the retained work';
   x.preparation!.execution={state:'interrupted',phase:'interrupted',observedAt:new Date().toISOString(),reason:'service_shutdown'};
  });
 }
 private async resumeTask(t:Task,owner:string,session:string,data:Record<string,unknown>){
  if(!id(data.requestId)||!Number.isSafeInteger(data.expectedGeneration))fail(400,'INVALID_PREPARATION_RESUME');
  if(t.status==='working'||this.queued.has(t.id)||this.resuming.has(t.id)||this.portals.has(t.id)){this.audit(t,session,'resume',data.requestId as string,'rejected_active');fail(409,'PREPARATION_ALREADY_WORKING');}
  this.assertProcessing();
  if(t.status==='cancelled')fail(409,'PREPARATION_CANCELLED');
  if(t.status!=='blocked')fail(409,'PREPARATION_NOT_BLOCKED');
  if(t.generation!==data.expectedGeneration)fail(409,'STALE_PREPARATION_GENERATION');
  this.resuming.add(t.id);
  try{
  // Explicit recovery never erases uncertain writes or repeats POST. Source grants remain bound.
  if(t.status==='cancelled')fail(409,'PREPARATION_CANCELLED');
  if(manualReconciliation(t))fail(409,'PREPARATION_RECONCILIATION_REQUIRED');
  if(t.preparation!.uploads.some(u=>u.state!=='verified')){
   const binding=await this.binding(t,owner,session),controller=new AbortController();
   try{await reconcilePreparationOutputs(this.context(t,binding,controller.signal));}catch{fail(409,'PREPARATION_RECONCILIATION_REQUIRED');}
   t=this.owned(owner,t.id);
  }
  if(t.pending?.effect==='external_write'&&(t.pending.tool!=='drive.create_artifact'||!t.preparation!.uploads.length))fail(409,'PREPARATION_RECONCILIATION_REQUIRED');
  const fresh=await this.bind(owner,session,t.preparation!.connectionId,t.preparation!.rootId);
  if(fresh.googleAccountId!==t.preparation!.googleAccountId)fail(409,'PREPARATION_CONNECTION_CHANGED');
  t=this.config.tasks.update(t.id,t=>{if(t.status!=='blocked'||t.generation!==data.expectedGeneration)fail(409,'STALE_PREPARATION_GENERATION');if(manualReconciliation(t)||t.preparation!.uploads.some(u=>u.state!=='verified'))fail(409,'PREPARATION_RECONCILIATION_REQUIRED');t.preparation!.incarnation=fresh.incarnation;t.preparation!.rootRevision=fresh.rootRevision;t.generation++;delete t.pending;delete t.blocker;t.recovery='clean';t.status='working';t.nextAction='Resume from committed observations after explicit owner recovery';this.audit(t,session,'resume',data.requestId as string,'accepted');});
  this.enqueue(t,owner,session,data.requestId as string);return receipt(t);
  }finally{this.resuming.delete(t.id);}
 }
 private async saveTask(owner:string,session:string,task:Task,data:Record<string,unknown>){
  if(!Number.isSafeInteger(data.expectedRevision)||!['draft','session'].includes(String(data.kind))||!id(data.requestId)||typeof data.saveOutputs!=='boolean')fail(400,'INVALID_PREPARATION_SAVE');
  if(task.preparation!.revision!==data.expectedRevision)fail(409,'STALE_PREPARATION_REVISION');
  if(data.saveOutputs===true)this.assertProcessing();
  this.audit(task,session,'save',data.requestId as string,'requested');
  let save=task.preparation!.saves?.find(s=>s.requestId===data.requestId);
  if(save&&(save.revision!==data.expectedRevision||save.kind!==data.kind||save.saveOutputs!==data.saveOutputs))fail(409,'REQUEST_ID_CONFLICT');
  if(save){this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!;boundSaveHistory(s,this.activeSaveCalls);s.history!.observedUserAttempts++;});save=this.config.tasks.get(task.id).preparation!.saves!.find(s=>s.id===save!.id)!;}
  if(save?.state==='capturing')fail(409,'PREPARATION_SAVE_IN_PROGRESS');
  if(save?.state==='capture_failed'||save?.state==='verified')return saveReceipt(save);
  const signal=new AbortController().signal,generation=task.generation,revision=task.preparation!.revision;
  const current=()=>{const t=this.config.tasks.get(task.id);return !this.stopping&&t.generation===generation&&t.preparation!.revision===revision;};
  const ctx:ToolContext={callId:randomUUID(),taskId:task.id,runId:task.run.id,accountId:owner,workspaceId:this.config.workspaceId,scope:this.localContext(task).scope(),budget:structuredClone(task.budget),signal,isCurrent:current,applicationRevision:task.applicationRevision};
  const invoke=async(tool:ToolDefinition,args:unknown)=>{
   const parsed=tool.inputSchema.parse(args),callId=randomUUID();this.activeSaveCalls.add(callId);
   const complete=(t:Task,result?:ToolResult)=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!,index=s.events.findIndex(e=>e.callId===callId);if(index<0)throw Error('ACTIVE_SAVE_CALL_MISSING');const [event]=s.events.splice(index,1);if(result)event!.result=result;else event!.error='CAPABILITY_FAILED_EFFECTS_RETAINED';s.events.push(event!);boundSaveHistory(s,this.activeSaveCalls);};
   try{this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!;boundSaveHistory(s,this.activeSaveCalls);s.events.push({callId,tool:tool.name,args:parsed});s.history!.observedCapabilityEvents++;boundSaveHistory(s,this.activeSaveCalls);});this.step(task.id,tool.name,'running','user_save');const result=await tool.invoke(parsed,{...ctx,callId});if(result.callId!==callId||!['ok','failed','needs_input'].includes(result.status)||!Array.isArray(result.artifacts))throw Error('INVALID_SAVE_CAPABILITY_RESULT');result.data=tool.outputSchema.parse(result.data);this.config.tasks.update(task.id,t=>complete(t,result));this.step(task.id,tool.name,result.status,'user_save',result.error?.code);return result;}
   catch(error){try{this.config.tasks.update(task.id,t=>complete(t));this.step(task.id,tool.name,'failed','user_save','STEP_UNAVAILABLE');}catch{/* Preserve the original capability/storage fault, never invent completion. */}throw error;}
   finally{this.activeSaveCalls.delete(callId);}
  };
  if(!save){
   const saveId=randomUUID();this.config.tasks.update(task.id,t=>{if(!current())fail(409,'STALE_PREPARATION_REVISION');if((t.preparation!.saves?.length??0)>=32)fail(507,'PREPARATION_SAVE_BOUND');(t.preparation!.saves??=[]).push({id:saveId,requestId:data.requestId as string,kind:data.kind as 'draft'|'session',revision,generation,saveOutputs:data.saveOutputs as boolean,state:'capturing',artifactIds:[],createdAt:new Date().toISOString(),history:{coverage:'complete',observedUserAttempts:1,observedCapabilityEvents:0,droppedCapabilityEvents:0,dropped:{ok:0,needs_input:0,failed:0,error:0,unresolved:0},activeCallIds:[]},events:[]});});
   save=this.config.tasks.get(task.id).preparation!.saves!.find(s=>s.id===saveId)!;
   try{const local={...this.localContext(task),saveSnapshotId:saveId},tool=preparationTools(local,this.config.buildIdentity,this.config.sourceIdentity).find(t=>t.name===(data.kind==='draft'?'draft.export':'session.export'))!;await invoke(tool,{});}catch{this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===saveId)!;s.state='capture_failed';s.error='LOCAL_EXPORT_FAILED';});}
   save=this.config.tasks.get(task.id).preparation!.saves!.find(s=>s.id===saveId)!;
  }
  if(!save.saveOutputs||save.state==='capture_failed')return saveReceipt(save);
  // Snapshot is durably local before any credential/grant/provider operation. This
  // user action invokes only the same registered NEW-artifact capability, never a model.
  try{
   if(!current())throw Error('STALE_SAVE_REVISION');
   const binding=await this.bind(owner,session,task.preparation!.connectionId,task.preparation!.rootId);if(binding.googleAccountId!==task.preparation!.googleAccountId)throw Error('SAVE_IDENTITY_CHANGED');
   const context=this.context(task,binding,signal);context.outputApproval={snapshotId:save.id,artifactIds:[...save.artifactIds]};const tool=createDriveArtifactTool(context);
   this.config.tasks.update(task.id,t=>{t.preparation!.saves!.find(s=>s.id===save!.id)!.state='uploading';});
   for(const artifactId of save.artifactIds){
    if(!current())throw Error('STALE_SAVE_REVISION');
    const a=this.config.store.artifact(context.namespace,artifactId),previous=this.config.tasks.get(task.id).preparation!.uploads.find(u=>u.revision===revision&&u.artifactId===artifactId),extension=a.mimeType==='application/pdf'?'pdf':a.mimeType==='image/jpeg'?'jpg':a.mimeType==='image/png'?'png':a.mimeType==='image/webp'?'webp':'json';
    const result=await invoke(tool,{artifactId,name:previous?.name??`Draft r${revision} ${artifactId}.${extension}`});if(result.status!=='ok'){this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!;s.state='upload_blocked';s.error='GOOGLE_OUTPUT_GRANT_OR_PARENT_REQUIRED';});return saveReceipt(this.config.tasks.get(task.id).preparation!.saves!.find(s=>s.id===save!.id)!);}
   }
   if(!current())throw Error('STALE_SAVE_REVISION');
   this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!;s.state='verified';delete s.error;});
  }catch{this.config.tasks.update(task.id,t=>{const s=t.preparation!.saves!.find(s=>s.id===save!.id)!;s.state=t.preparation!.uploads.some(u=>s.artifactIds.includes(u.artifactId)&&u.state!=='verified')?'uncertain':'upload_blocked';s.error=s.state==='uncertain'?'UPLOAD_RECONCILIATION_REQUIRED':'SAVE_GRANT_PARENT_OR_CURRENTNESS_UNAVAILABLE';});}
  return saveReceipt(this.config.tasks.get(task.id).preparation!.saves!.find(s=>s.id===save!.id)!);
 }
 private step(taskId:string,tool:string,status:'running'|'ok'|'failed'|'needs_input',origin:'runtime'|'manual_probe'|'user_save',code?:string){
  const phase:PreparationStep|undefined=tool==='drive.list'?'discovery':tool==='drive.read'?'read':tool.startsWith('ocr.')?'ocr':tool.startsWith('image.')?'photo':tool==='document.render'?'pdfRender':tool.startsWith('document.')?'pdfFill':tool==='draft.export'?'draft':tool==='session.export'?'session':tool==='drive.create_artifact'?'driveOutput':undefined;
  if(!phase)return;
  this.config.tasks.update(taskId,t=>{const p=t.preparation!;(p.steps??={})[phase]={status,origin,observedAt:new Date().toISOString(),...(code&&/^[A-Za-z_]{1,80}$/.test(code)?{code}:{})};if(origin==='runtime'&&p.execution)p.execution.phase=phase;});
 }
 private async sourceDiagnostic(task:Task,owner:string,session:string,data:Record<string,unknown>){
  if(!['list','read'].includes(String(data.operation))||data.operation==='read'&&!id(data.fileId)||data.operation==='list'&&data.fileId!==undefined)fail(400,'INVALID_PREPARATION_SOURCE');
  if(this.busy(task.id))fail(409,'PREPARATION_ALREADY_WORKING');
  if(!task.preparation!.processingConsent)fail(403,'PREPARATION_PROCESSING_CONSENT_REQUIRED');
  if(manualReconciliation(task)||task.preparation!.uploads.some(u=>u.state!=='verified'))fail(409,'PREPARATION_RECONCILIATION_REQUIRED');
  this.audit(task,session,'source',randomUUID(),'manual_probe');
  const b=await this.binding(task,owner,session),controller=new AbortController(),context=this.context(task,b,controller.signal),generation=task.generation;
  const current=()=>!this.stopping&&this.config.tasks.get(task.id).generation===generation;
  const active=(ctx:ToolContext)=>{ctx.signal.throwIfAborted();if(!ctx.isCurrent()||!this.config.tasks.get(task.id).preparation!.processingConsent)fail(409,'PREPARATION_CONTEXT_CHANGED');};
  const tools=await this.composedTools(task,context,b,active,'manual_probe',true),tool=tools.find(t=>t.name==='drive.'+data.operation)!;
  const args=tool.inputSchema.parse(data.operation==='list'?{folderId:b.rootId}:{fileId:data.fileId});
  const result=await tool.invoke(args,{callId:randomUUID(),taskId:task.id,runId:task.run.id,accountId:owner,workspaceId:this.config.workspaceId,scope:context.scope(),budget:structuredClone(task.budget),signal:controller.signal,isCurrent:current,applicationRevision:task.applicationRevision});
  result.data=tool.outputSchema.parse(result.data);
  return {origin:'manual_probe',result:visibleRecord(result)};
 }
 private async composedTools(task:Task,context:PreparationContext,b:PreparationBinding,active:(ctx:ToolContext)=>void,origin:'runtime'|'manual_probe',sourceOnly=false){
  const sourceTools=(await googleSourceTools(b.oauth,b.connectionId,context.namespace.workspaceId,new Set(),context.store,b.http,new Set([b.rootId]),new Map(),{ownerId:task.sourceEvent.accountId,assertCurrent:async(ctx)=>{active(ctx);await b.assertCurrent({signal:ctx.signal});active(ctx);},admit:(source,ctx)=>{active(ctx);this.config.tasks.update(task.id,t=>{if(!t.preparation!.sources.some(s=>s.id===source.id))t.preparation!.sources.push(source);});}})).filter(tool=>tool.name.startsWith('drive.'));
  const local=sourceOnly?[]:await this.config.tools(context);
  return [...sourceTools,...local,...(sourceOnly?[]:preparationTools(context,this.config.buildIdentity,this.config.sourceIdentity))].map(tool=>{
   if(!/^(?:drive\.(?:list|read|create_artifact)|image\.[a-z_]+|document\.[a-z_]+|ocr\.(?:document|render_regions)|preparation\.record_fields|draft\.export|session\.export|skill\.load|web\.(?:search|open_result))$/.test(tool.name))throw Error('PREPARATION_TOOL_NOT_ALLOWLISTED');
   return {...tool,invoke:async(args:unknown,ctx:ToolContext):Promise<ToolResult>=>{
    active(ctx);await b.assertCurrent({signal:ctx.signal});await b.assertSources(context.scope().sources,{signal:ctx.signal});active(ctx);
    const binding=preparationArtifactBinding(this.config.tasks.get(task.id).preparation!,'',tool.artifactFieldIds?.(args,ctx));
    this.step(task.id,tool.name,'running',origin);
    const operation=Promise.resolve().then(()=>tool.invoke(args,ctx));this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});
    let result:ToolResult;
    try{result=await operation;active(ctx);await b.assertCurrent({signal:ctx.signal});await b.assertSources(context.scope().sources,{signal:ctx.signal});active(ctx);}
    catch(error){if(ctx.isCurrent())this.step(task.id,tool.name,'failed',origin,'STEP_UNAVAILABLE');throw error;}
    if(result.status==='ok')this.config.tasks.update(task.id,t=>{if(tool.name==='drive.list'){const listing=(result.data as {listing?:{files:{id:string;name:string}[]}}).listing;for(const file of listing?.files??[])(t.preparation!.sourceNames??={})[file.id]=file.name;}for(const a of result.artifacts){context.store.artifact(context.namespace,a.id);if(!t.preparation!.artifactIds.includes(a.id)){t.preparation!.artifactIds.push(a.id);(t.preparation!.artifactRevisions??={})[a.id]=t.preparation!.revision;(t.preparation!.artifactBindings??={})[a.id]={...binding,sha256:a.sha256};}}});
    // Describe newly read images once, so the planner knows which file is the passbook vs the portrait.
    const read=tool.name==='drive.read'&&result.status==='ok'?(result.data as {source?:{id:string;mimeType:string}}).source:undefined;
    if(read&&read.mimeType.startsWith('image/')&&this.config.describeSource&&!this.config.tasks.get(task.id).preparation!.sourceDescriptions?.[read.id]){
     try{const text=await this.config.describeSource(context,ctx,read.id);active(ctx);
      if(text){this.config.tasks.update(task.id,t=>{(t.preparation!.sourceDescriptions??={})[read.id]=text;});result={...result,observations:[`This image shows: ${text}`,...result.observations]};}}
     catch(error){if(!ctx.isCurrent())throw error;}
    }
    this.step(task.id,tool.name,result.status,origin,result.error?.code);return result;
   }};
  });
 }
 private enqueue(task:Task,owner:string,session:string,actionId=task.preparation!.requestId){
  if(this.stopping||this.config.processingPaused)return;
  if(this.queued.has(task.id)){this.continuations.set(task.id,{task,owner,session,actionId});return;}
  this.queued.add(task.id);
  const job=this.tail.catch(()=>{}).then(async()=>{
   let runtime:AgentRuntime|undefined,runRevision=task.preparation!.revision;
   try{
    if(this.stopping||this.config.processingPaused)return;const t=this.config.tasks.get(task.id);if(t.status!=='working')return;
    this.config.tasks.update(t.id,t=>{delete t.blocker;t.nextAction='Preparing from the retained request';t.preparation!.execution={state:'running',phase:'connecting',observedAt:new Date().toISOString()};});
    runRevision=t.preparation!.revision;const controller=new AbortController();this.controllers.set(t.id,controller);
    const b=await this.binding(t,owner,session),context=this.context(t,b,controller.signal),revision=t.preparation!.revision;
    const active=(ctx:ToolContext)=>{this.assertProcessing();ctx.signal.throwIfAborted();const p=this.config.tasks.get(t.id).preparation!;if(!ctx.isCurrent()||!p.processingConsent||p.revision!==revision)throw Error('STALE_PREPARATION');};
    // Without Drive saving, external writes are not offered at all, so the model cannot spend (or end) the run attempting one.
    const tools=(await this.composedTools(t,context,b,active,'runtime')).filter(tool=>t.preparation!.saveOutputs||tool.effect!=='external_write');
    runtime=new AgentRuntime(this.config.tasks,tools);this.runtimes.set(t.id,runtime);
    const provider=this.config.provider(context);
    let startRecorded=false;
    const guarded:AgentProvider={id:provider.id,next:async(task,tools,ctx)=>{this.assertProcessing();if(!startRecorded){this.audit(task,session,'run_start',actionId,'observed_before_provider');startRecorded=true;}this.config.tasks.update(task.id,t=>{if(t.preparation!.execution)t.preparation!.execution.phase='decision';});await b.assertCurrent({signal:ctx?.signal});await b.assertSources(context.scope().sources,{signal:ctx?.signal});const operation=provider.next(task,tools,ctx);this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});const d=await operation;await b.assertCurrent({signal:ctx?.signal});await b.assertSources(context.scope().sources,{signal:ctx?.signal});return d;}};
    await runtime.run(t.id,guarded,this.config.maxTurns??16,{getScope:context.scope,signal:controller.signal,signalMode:'supersede',timeoutMs:this.config.timeoutMs??300000,
     approveExternalWrite:(task,tool,args)=>{const p=task.preparation!,a=args as {artifactId?:string};return tool.name==='drive.create_artifact'&&p.revision===revision&&p.processingConsent&&p.saveOutputs&&typeof a?.artifactId==='string'&&p.artifactIds.includes(a.artifactId)&&preparationArtifactCurrent(context.store,context.namespace,p,a.artifactId);},
     assertReady:task=>{assertPreparationArtifactsCurrent(context.store,context.namespace,task);const p=task.preparation!,outputs=p.uploads.filter(u=>u.revision===p.revision&&preparationArtifactCurrent(context.store,context.namespace,p,u.artifactId));const exportIds=p.artifactIds.filter(id=>p.artifactBindings?.[id]?.exportKind==='session'&&p.artifactRevisions?.[id]===p.revision&&preparationArtifactCurrent(context.store,context.namespace,p,id));if(!exportIds.length)throw Error('CURRENT_SESSION_EXPORT_REQUIRED: call session.export for this revision before declaring ready.');if(/\bfill\b/i.test(p.request)&&!p.fields.some(f=>!f.unresolved&&f.value?.trim()))throw Error('FORM_NOT_FILLED: the request asks for a filled form but no field values are recorded. Read the source document (ocr.document on the relevant region), record the values with preparation.record_fields citing the OCR spans, fill the form with document.fill_by_label, then export and declare ready.');if(p.fields.some(f=>f.unresolved)||task.checklist.items.some(i=>!['done','skipped'].includes(i.state)))throw Error('PREPARATION_INCOMPLETE: resolve or correct unresolved fields and mark every checklist item done or skipped.');if(p.saveOutputs&&(!outputs.length||outputs.some(u=>u.state!=='verified')||!outputs.some(u=>p.artifactBindings?.[u.artifactId]?.exportKind==='session')||outputs.every(u=>p.artifactBindings?.[u.artifactId]?.exportKind==='session')))throw Error('OUTPUTS_NOT_VERIFIED: saving is enabled, so upload each prepared output with drive.create_artifact, then upload the current session.export artifact; ready needs verified uploads of both.');}
    });
    const after=this.config.tasks.get(t.id);if(!this.stopping&&after.status==='working'&&after.preparation!.revision===revision)this.config.tasks.update(t.id,t=>{t.status='blocked';t.blocker='Preparation turn bound reached';t.nextAction='Review retained work before explicit resume';});
   }catch(error){const latest=this.config.tasks.get(task.id);if(!this.stopping&&latest.status==='working'&&latest.preparation!.revision===runRevision)this.config.tasks.update(task.id,t=>{t.status='blocked';t.blocker=error instanceof Error?error.message:'PREPARATION_UNAVAILABLE';t.nextAction='Resolve connection or processing configuration, then resume';});}
   finally{while(this.operations.size)await Promise.allSettled([...this.operations]);if(!this.stopping)this.config.tasks.update(task.id,t=>{const p=t.preparation!;p.execution={state:'idle',phase:t.status,observedAt:new Date().toISOString(),...(t.status==='cancelled'?{reason:p.execution?.reason??'runtime_stop'}:{})};if(t.status==='cancelled'&&p.execution.reason!=='owner_cancel')t.nextAction='Run stopped; inspect retained work. Initiator is not recorded as owner cancellation.';});this.controllers.delete(task.id);this.runtimes.delete(task.id);this.queued.delete(task.id);const next=this.continuations.get(task.id);this.continuations.delete(task.id);if(next&&!this.stopping&&this.config.tasks.get(task.id).status==='working')this.enqueue(next.task,next.owner,next.session,next.actionId);}
  });
  this.tail=job;this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));
 }
 track<T>(operation:Promise<T>):Promise<T>{this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});return operation;}
 async close(){
  this.stopping=true;
  try{for(const taskId of this.queued){this.config.tasks.update(taskId,t=>{if(t.status==='working')t.preparation!.execution={state:'interrupted',phase:'interrupted',observedAt:new Date().toISOString(),reason:'service_shutdown'};});}}
  finally{for(const controller of this.controllers.values())controller.abort();for(const run of this.portals.values())run.authority.abort();await Promise.allSettled([...this.jobs]);while(this.operations.size)await Promise.allSettled([...this.operations]);try{await this.config.browserContinuation?.close();}finally{this.releaseOwner();}}
 }
}
