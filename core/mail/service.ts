import {randomUUID,createHash} from 'node:crypto';
import type {PaidTaskAdmission} from '../account/paid-task-quota.js';
import {isDeepStrictEqual as same} from 'node:util';
import type {GoogleOAuth} from '../connectors/google/oauth.js';
import type {Namespace,EvidenceStore} from '../evidence/store.js';
import type {AgentStore} from '../storage/agent-store.js';
import type {AgentProvider,Task,ToolContext,ToolDefinition} from '../agent/contracts.js';
import {AgentRuntime} from '../agent/runtime.js';
import {createTaskMailTools} from '../agent/mail-host.js';
import {EmailDrafts,MailFailure,parseDraftRef,parseDraftContent,mailSendGrants,reconcileOutgoingMail,type DraftRef} from '../connectors/google/outgoing.js';
import {gmailDraftTools} from './gmail-drafts.js';
import {selectMailAttachments,assertMailAttachmentsCurrent,mailSources,mailAttachmentsComplete,type MailSourceSelection} from './attachments.js';
export interface MailConnectionBinding {oauth:GoogleOAuth;connectionId:string;connectionEpoch:string;googleAccountId:string;incarnation:string;guardedHttp(input:RequestInfo|URL,init:RequestInit|undefined,guard:()=>void):Promise<Response>;assertCurrent(options?:{signal?:AbortSignal}):Promise<void>}
export interface MailAgentContext {taskId:string;namespace:Namespace;tasks:AgentStore;store:EvidenceStore;signal:AbortSignal;assertCurrent():Promise<void>;dispatchGuard():void;track<T>(operation:Promise<T>):Promise<T>}
export interface MailServiceConfig {tasks:AgentStore;store:EvidenceStore;workspaceId:string;provider:(context:MailAgentContext)=>AgentProvider;maxTurns?:number;timeoutMs?:number;toolBudget?:number;processingPaused?:boolean}
export class MailServiceFailure extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new MailServiceFailure(status,code);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uncertain=(t:Task)=>Object.values(t.mail?.sends??{}).some(r=>!r.outcome||r.outcome.state==='uncertain')||Object.values(t.mail?.publishes??{}).some(p=>p.state==='intent'||p.state==='uncertain');
/** Authenticated account facade. It does not own account auth, OAuth grants, a second
 * task queue/store, or a planner. Only explicit requests start model processing. */
export class MailService {
 private jobs=new Set<Promise<unknown>>();private controllers=new Map<string,AbortController>();private stopping=false;
 constructor(private config:MailServiceConfig,private bind:(owner:string,session:string,connectionId:string)=>Promise<MailConnectionBinding>,private admitPaidTask?:PaidTaskAdmission){
  for(const [v,max] of [[config.maxTurns??12,64],[config.timeoutMs??120000,3600000],[config.toolBudget??128,1024]])if(!Number.isSafeInteger(v)||v<1||v>max)throw Error('MAIL_INVALID_BOUND');
 }
 private ns(owner:string):Namespace{return {workspaceId:this.config.workspaceId,accountId:owner};}
 private owned(owner:string,taskId:unknown){if(!id(taskId))return fail(400,'MAIL_INVALID_TASK_ID');const t=this.config.tasks.taskInNamespace(this.ns(owner),taskId);if(!t?.mail?.service)return fail(404,'MAIL_TASK_NOT_FOUND');return t;}
 private async reconcilePaidTask(task:Task){
  await this.admitPaidTask?.reconcile(task.sourceEvent.accountId,JSON.stringify([task.sourceEvent.workspaceId,task.sourceEvent.accountId,task.sourceEvent.messageId]),task.id);
 }
 private track<T>(operation:Promise<T>):Promise<T>{this.jobs.add(operation);void operation.finally(()=>this.jobs.delete(operation)).catch(()=>{});return operation;}
 private review(t:Task,ref:DraftRef){
  if(!same(t.mail!.drafts[ref.draftId],ref))fail(409,'MAIL_DRAFT_NOT_CURRENT');
  const snap=new EmailDrafts(this.config.store,this.ns(t.sourceEvent.accountId),t.mail!.service!.googleAccountId).read(ref);
  const publishes=Object.values(t.mail!.publishes??{}).filter(p=>same(p.binding.draft,ref)),sends=Object.values(t.mail!.sends).filter(s=>same(s.intent.binding.draft,ref));
  const p=publishes.at(-1),s=sends.at(-1);
  return {attachmentsComplete:mailAttachmentsComplete(t.mail!.service!.source,snap.record.attachments),draft:structuredClone(ref),sender:snap.record.sender??snap.record.accountId,content:structuredClone(snap.record.content),attachments:structuredClone(snap.record.attachments),publish:p?{state:p.state,...(p.providerDraftId?{providerDraftId:p.providerDraftId}:{}),...(p.code?{code:p.code}:{})}:null,send:s?.outcome?structuredClone(s.outcome):s?{state:'uncertain',code:'MAIL_RECONCILIATION_REQUIRED'}:null};
 }
 private sourceCurrent(t:Task){try{assertMailAttachmentsCurrent(this.config.tasks,this.config.store,this.ns(t.sourceEvent.accountId),t.mail!.service!.source);return true;}catch{return false;}}
 private status(t:Task){const p=t.mail!.service!;return {...(p.source?{source:{taskId:p.source.taskId,revision:p.source.revision,current:this.sourceCurrent(t),artifacts:p.source.artifacts}}:{}),taskId:t.id,state:t.status,request:p.request,connectionId:p.connectionId,googleAccountId:p.googleAccountId,drafts:Object.values(t.mail!.drafts).map(ref=>{const {content,...review}=this.review(t,ref);return {...review,subject:content.subject};}),recovery:t.recovery,processingPaused:this.config.processingPaused===true,execution:this.controllers.has(t.id)?'running':p.active?'interrupted':'idle',...(t.status==='blocked'?{blocker:uncertain(t)?'MAIL_RECONCILIATION_REQUIRED':'MAIL_PROCESSING_OR_ACTION_BLOCKED'}:{}),budget:{...t.budget}};}
 private async binding(t:Task,owner:string,session:string){
  const p=t.mail!.service!,b=await this.bind(owner,session,p.connectionId);await b.assertCurrent();
  const fresh=this.owned(owner,t.id),current=fresh.mail!.service!;
  if(b.connectionId!==current.connectionId||b.googleAccountId!==current.googleAccountId)fail(409,'MAIL_CONNECTION_CHANGED');
  if(b.connectionEpoch!==current.connectionEpoch||b.incarnation!==current.incarnation){
   // Genuine owner actions may use a newly consented grant for the SAME sender.
   // Never rewrite old intents/observed facts or use reconnect to escape an unknown.
   if(uncertain(fresh)||current.active||fresh.pending||fresh.recovery!=='clean')fail(409,'MAIL_RECONCILIATION_REQUIRED');
   this.config.tasks.update(t.id,task=>{const actual=task.mail!.service!;if(task.generation!==fresh.generation||actual.active||uncertain(task))fail(409,'MAIL_CONTEXT_CHANGED');actual.connectionEpoch=b.connectionEpoch;actual.incarnation=b.incarnation;task.generation++;
    for(const a of Object.values(task.mail!.approvals))a.revoked=true;
    for(const a of Object.values(task.mail!.requests??{}))a.revoked=true;
   });
  }
  return b;
 }
 private currentDraft(t:Task,value:unknown){const ref=parseDraftRef(value);this.review(t,ref);return ref;}
 private claim(taskId:string){const nonce=randomUUID();this.config.tasks.update(taskId,t=>{if(t.status==='cancelled')fail(409,'MAIL_CANCELLED');if(t.mail!.service!.active||t.pending||t.recovery!=='clean')fail(409,'MAIL_RECONCILIATION_REQUIRED');t.mail!.service!.active=nonce;});return nonce;}
 private assertReady(task:Readonly<Task>,sourceOverride?:{selection:MailSourceSelection|undefined}){
  const actual=this.owned(task.sourceEvent.accountId,task.id),selection=sourceOverride?sourceOverride.selection:actual.mail!.service!.source;
  assertMailAttachmentsCurrent(this.config.tasks,this.config.store,this.ns(task.sourceEvent.accountId),selection);
  if(!Object.keys(actual.mail!.drafts).length)fail(409,'MAIL_DRAFT_REQUIRED');
  if(!Object.values(actual.mail!.drafts).every(ref=>mailAttachmentsComplete(selection,this.review(actual,ref).attachments)))fail(409,'MAIL_ATTACHMENT_SELECTION_INCOMPLETE');
  if(uncertain(actual))fail(409,'MAIL_RECONCILIATION_REQUIRED');
 }
 private async tools(t:Task,b:MailConnectionBinding,grant:string=mailSendGrants.send,readOnlyReconciliation=false,sourceOverride?:{selection:MailSourceSelection|undefined}){
  t=this.owned(t.sourceEvent.accountId,t.id);
  const ns=this.ns(t.sourceEvent.accountId),drafts=new EmailDrafts(this.config.store,ns,b.googleAccountId);
  // Runtime increments generation AFTER tool construction. Use the actual invocation
  // context and stable claim nonce, never a pre-runtime generation snapshot.
  const activeCalls=new Map<string,{runId:string;name:string}>();
  const admitted=(actual:Task,ctx:ToolContext)=>{
   const invocation=activeCalls.get(ctx.callId);if(!invocation||invocation.runId!==ctx.runId)return false;
   if(actual.pending?.tool!=='batch')return actual.pending?.callId===ctx.callId&&actual.pending?.tool===invocation.name;
   const decision=actual.decisions.at(-1);
   return decision?.kind==='batch'&&decision.calls.some(call=>call.callId===ctx.callId&&call.name===invocation.name);
  };
  const check=(ctx:ToolContext,dispatch=false)=>{const actual=this.owned(ns.accountId,t.id),p=actual.mail!.service!;if(!readOnlyReconciliation)assertMailAttachmentsCurrent(this.config.tasks,this.config.store,ns,sourceOverride?sourceOverride.selection:p.source);if(this.stopping||ctx.signal.aborted||!ctx.isCurrent()||ctx.taskId!==t.id||ctx.accountId!==ns.accountId||ctx.workspaceId!==ns.workspaceId||dispatch&&!same(actual.mail!.drafts,t.mail!.drafts)||!readOnlyReconciliation&&(actual.status!=='working'||p.active!==t.mail!.service!.active||actual.run.id!==ctx.runId||!admitted(actual,ctx))||p.connectionId!==b.connectionId||p.connectionEpoch!==b.connectionEpoch||p.googleAccountId!==b.googleAccountId||p.incarnation!==b.incarnation)fail(409,'MAIL_CONTEXT_CHANGED');};
  const http=(input:RequestInfo|URL,init:RequestInit|undefined,ctx:ToolContext)=>this.track(b.guardedHttp(input,init,()=>check(ctx,true)));
  const fence=async(ctx:ToolContext)=>{check(ctx);await b.assertCurrent({signal:ctx.signal});check(ctx);};
  // Only explicit owner-selected preparation artifacts; internal mail/MIME records are not automatic attachments.
  const allowed=(ctx:ToolContext,artifactId:string)=>{const task=this.owned(ns.accountId,ctx.taskId);const selection=sourceOverride?sourceOverride.selection:task.mail!.service!.source;assertMailAttachmentsCurrent(this.config.tasks,this.config.store,ns,selection);return !!selection?.artifacts.some(a=>a.artifactId===artifactId);};
  let publication:ReturnType<typeof gmailDraftTools>;
  const host=createTaskMailTools({tasks:this.config.tasks,store:this.config.store,namespace:ns,sender:b.googleAccountId,allowAttachment:allowed,send:{oauth:b.oauth,connectionId:b.connectionId,connectionEpoch:b.connectionEpoch,grant:grant as typeof mailSendGrants.send,http,assertCurrent:ctx=>fence(ctx),providerDraft:(ctx,bound)=>publication.providerDraft(ctx,bound)}});
  publication=gmailDraftTools({tasks:this.config.tasks,drafts,binding:b,http,allowCancelledRead:readOnlyReconciliation,assertCurrent:fence,allowAttachment:allowed,arguments:host.tools.find(t=>t.name==='mail.send')!.inputSchema});
  const tools=[...host.tools,publication.tool].map(tool=>({...tool,invoke:(args:unknown,ctx:ToolContext)=>this.track((async()=>{
   if(activeCalls.has(ctx.callId))fail(409,'MAIL_CONTEXT_CHANGED');activeCalls.set(ctx.callId,{runId:ctx.runId,name:tool.name});
   try{await fence(ctx);const result=await tool.invoke(args,ctx);await fence(ctx);return result;}finally{activeCalls.delete(ctx.callId);}
  })())}));
  const execution={approveExternalWrite:(task:Readonly<Task>,tool:ToolDefinition,args:unknown)=>tool.name==='mail.draft.publish'?publication.approveExternalWrite(task.id,args):host.approveExternalWrite(task,tool,args),assertReady:(task:Readonly<Task>)=>this.assertReady(task,sourceOverride)};
  return {tools,host,publication,execution,fence,http};
 }
 private assertModelDispatch(taskId:string,owner:string,b:MailConnectionBinding,nonce:string,signal:AbortSignal){
  signal.throwIfAborted();const task=this.owned(owner,taskId),p=task.mail!.service!;assertMailAttachmentsCurrent(this.config.tasks,this.config.store,this.ns(owner),p.source);if(this.stopping||this.config.processingPaused||task.status!=='working'||p.active!==nonce||p.connectionId!==b.connectionId||p.googleAccountId!==b.googleAccountId||p.incarnation!==b.incarnation||p.connectionEpoch!==b.connectionEpoch)fail(409,'MAIL_PROCESSING_CONTEXT_CHANGED');
 }
 private async assertModelCurrent(taskId:string,owner:string,b:MailConnectionBinding,nonce:string,signal:AbortSignal){
  this.assertModelDispatch(taskId,owner,b,nonce,signal);await b.assertCurrent({signal});this.assertModelDispatch(taskId,owner,b,nonce,signal);
 }
 private async execute(t:Task,b:MailConnectionBinding,nonce:string,provider:AgentProvider,turns:number,manual:boolean,grant?:string,controller=new AbortController(),sourceOverride?:{selection:MailSourceSelection|undefined}){this.controllers.set(t.id,controller);
  try{
   const composed=await this.tools(t,b,grant,false,sourceOverride);this.config.tasks.update(t.id,task=>{if(task.mail!.service!.active!==nonce||task.status==='cancelled')fail(409,'MAIL_CONTEXT_CHANGED');task.status='working';delete task.currentResult;delete task.blocker;});
   const trackedProvider:AgentProvider={id:provider.id,next:(...args)=>this.track((async()=>{if(!manual)await this.assertModelCurrent(t.id,t.sourceEvent.accountId,b,nonce,controller.signal);const decision=await provider.next(...args);if(!manual)await this.assertModelCurrent(t.id,t.sourceEvent.accountId,b,nonce,controller.signal);return decision;})())};
   await new AgentRuntime(this.config.tasks,composed.tools).run(t.id,trackedProvider,turns,{...composed.execution,timeoutMs:this.config.timeoutMs??120000,signal:controller.signal});
   this.config.tasks.update(t.id,task=>{
    if(task.mail!.service!.active!==nonce||task.status==='cancelled')return;
    if(uncertain(task)){task.status='blocked';task.blocker='MAIL_RECONCILIATION_REQUIRED';}
    else if(manual&&task.status==='working'){if(task.observations.at(-1)?.status==='ok'){composed.execution.assertReady(task);task.status='ready';}else task.status='blocked';}
    else if(!manual&&task.status==='working'){task.status='blocked';task.blocker='MAIL_TURN_LIMIT';}
   });
  }catch{this.config.tasks.update(t.id,task=>{if(task.mail!.service!.active===nonce&&task.status!=='cancelled'){task.status='blocked';task.blocker='MAIL_EXECUTION_UNAVAILABLE';}});}
  finally{this.controllers.delete(t.id);this.config.tasks.update(t.id,task=>{if(task.mail!.service!.active===nonce)delete task.mail!.service!.active;});}
 }
 async handle(owner:string,session:string,path:string,data:Record<string,unknown>):Promise<unknown>{return this.track(this.handleRequest(owner,session,path,data).catch(error=>{if(error instanceof MailFailure)throw new MailServiceFailure(error.code==='MAIL_SOURCE_UNAVAILABLE'?404:error.code.includes('RECONCILIATION')||error.code.includes('NOT_CURRENT')||error.code==='MAIL_SOURCE_CHANGED'?409:400,error.code);throw error;}));}
 private async handleRequest(owner:string,session:string,path:string,data:Record<string,unknown>):Promise<unknown>{
  if(this.stopping)fail(503,'MAIL_STOPPING');
  const fields:Record<string,string[]>={'/mail/config':[],'/mail/request':['connectionId','request','requestId','processingConsent','sourceTaskId','attachmentIds'],'/mail/sources':['sourceTaskId'],'/mail/list':[],'/mail/status':['taskId'],'/mail/draft':['taskId','draft'],'/mail/edit':['taskId','draft','content','requestId','sourceTaskId','attachmentIds'],'/mail/publish':['taskId','draft','requestId'],'/mail/send':['taskId','draft','requestId'],'/mail/reconcile':['taskId','draft'],'/mail/cancel':['taskId']};
  if(!Object.hasOwn(fields,path))fail(404,'NOT_FOUND');if(Object.keys(data).some(k=>!fields[path].includes(k)))fail(400,'MAIL_INVALID_FIELDS');
  if(path==='/mail/config')return {configured:true,processingPaused:this.config.processingPaused===true,requiresProcessingConsent:true,modes:['local_draft','gmail_draft','send'],readiness:{credentials:'lazy_not_checked',liveAcceptance:'unverified'},gmailComposeGrant:mailSendGrants.compose,gmailSendGrant:mailSendGrants.send};
  if(path==='/mail/sources')return mailSources(this.config.tasks,this.config.store,this.ns(owner),data.sourceTaskId);
  if(path==='/mail/list')return {tasks:this.config.tasks.tasks(this.ns(owner)).filter(t=>t.mail?.service).map(t=>({taskId:t.id,state:t.status,request:t.mail!.service!.request.slice(0,160),connectionId:t.mail!.service!.connectionId})),limit:100};
  if(path==='/mail/request'){
   if(!id(data.connectionId)||!id(data.requestId)||typeof data.request!=='string'||!data.request.trim()||Buffer.byteLength(data.request)>16384||data.processingConsent!==true)fail(400,'MAIL_INVALID_REQUEST');
   const selection=selectMailAttachments(this.config.tasks,this.config.store,this.ns(owner),data.sourceTaskId,data.attachmentIds);
   // The existing exact event admission key persists request identity across restart.
   // No bounded UI-list scan is used for idempotency.
   const b=await this.bind(owner,session,data.connectionId as string);await b.assertCurrent();
   if(b.connectionId!==data.connectionId)fail(409,'MAIL_CONNECTION_CHANGED');
   if(this.config.processingPaused)fail(423,'MAIL_PROCESSING_PAUSED');
   const event={...this.ns(owner),messageId:'mail:'+data.requestId,outcome:selection?JSON.stringify({request:data.request,source:{taskId:selection.taskId,revision:selection.revision},attachments:selection.artifacts}):data.request as string};
   const retained=()=>{
    const task=this.config.tasks.taskForEvent(event);
    if(!task?.mail?.service)return;
    const p=task.mail.service;if(p.request!==data.request||p.connectionId!==data.connectionId||!same(p.source,selection))fail(409,'MAIL_REQUEST_ID_CONFLICT');
    return task;
   };
   const previous=retained();if(previous){await this.reconcilePaidTask(previous);const fresh=this.owned(owner,previous.id);return {taskId:fresh.id,state:fresh.status};}
   let admitted=false;
   const create=()=>{
    const existing=retained();if(existing)return existing;
    const task=this.config.tasks.admit(event,this.config.toolBudget??128);
    const result=this.config.tasks.update(task.id,t=>{t.mail={drafts:{},approvals:{},sends:{},requests:{},publishes:{},service:{connectionId:b.connectionId,connectionEpoch:b.connectionEpoch,incarnation:b.incarnation,googleAccountId:b.googleAccountId,requestId:data.requestId as string,request:data.request as string,...(selection?{source:selection}:{}),edits:{}}};});
    admitted=true;return result;
   };
   const task=this.admitPaidTask?await this.admitPaidTask(owner,JSON.stringify([this.config.workspaceId,owner,event.messageId]),create):create();
   await this.reconcilePaidTask(task);
   if(!admitted)return {taskId:task.id,state:task.status};
   const nonce=this.claim(task.id),controller=new AbortController();
   // Factory invocation is lazy and limited to this explicitly consented request.
   const job=Promise.resolve().then(async()=>{if(this.stopping||this.owned(owner,task.id).status==='cancelled')return;await this.assertModelCurrent(task.id,owner,b,nonce,controller.signal);const p=this.config.provider({taskId:task.id,namespace:this.ns(owner),tasks:this.config.tasks,store:this.config.store,signal:controller.signal,assertCurrent:()=>this.assertModelCurrent(task.id,owner,b,nonce,controller.signal),dispatchGuard:()=>this.assertModelDispatch(task.id,owner,b,nonce,controller.signal),track:operation=>this.track(operation)});return this.execute(task,b,nonce,p,this.config.maxTurns??12,false,undefined,controller);}).catch(()=>{this.config.tasks.update(task.id,t=>{if(t.mail!.service!.active!==nonce)return;if(t.status!=='cancelled'){t.status='blocked';t.blocker='MAIL_PROVIDER_UNAVAILABLE';}delete t.mail!.service!.active;});}).finally(()=>{this.config.tasks.update(task.id,t=>{if(t.mail!.service!.active===nonce&&!this.controllers.has(t.id)){delete t.mail!.service!.active;if(t.status==='working'){t.status='blocked';t.blocker='MAIL_EXECUTION_STOPPED';}}});});
   void this.track(job);return {taskId:task.id,state:'working'};
  }
  let t=this.owned(owner,data.taskId);
  if(!['/mail/cancel','/mail/status','/mail/draft'].includes(path)){
   await this.reconcilePaidTask(t);t=this.owned(owner,t.id);
  }
  if(path==='/mail/status')return this.status(t);
  if(path==='/mail/cancel'){this.controllers.get(t.id)?.abort();this.config.tasks.cancel(t.id);this.config.tasks.update(t.id,task=>{if(task.mail)for(const a of Object.values(task.mail.approvals))a.revoked=true;});return this.status(this.owned(owner,t.id));}
  const ref=this.currentDraft(t,data.draft);
  if(path==='/mail/draft')return this.review(t,ref);
  if(path!=='/mail/reconcile'&&!id(data.requestId))fail(400,'MAIL_INVALID_REQUEST_ID');
  const b=await this.binding(t,owner,session);t=this.owned(owner,t.id);this.currentDraft(t,ref);
  if(t.status==='cancelled'&&path!=='/mail/reconcile')fail(409,'MAIL_CANCELLED');
  if(path==='/mail/reconcile'){
   if(this.controllers.has(t.id))fail(409,'MAIL_ALREADY_WORKING');
   const generation=t.generation,controller=new AbortController(),ctx:ToolContext={...this.ns(owner),taskId:t.id,runId:t.run.id,callId:randomUUID(),scope:{sources:[],destinations:[],grants:[]},budget:t.budget,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),isCurrent:()=>!this.stopping&&this.owned(owner,t.id).generation===generation};
   const composed=await this.tools(t,b,undefined,true);await composed.publication.reconcile(ctx,ref);
   // Read-only search does not convert candidates into a delivery claim or clear send uncertainty.
   const searches=[];for(const r of Object.values(t.mail!.sends))if(same(r.intent.binding.draft,ref)&&(!r.outcome||r.outcome.state==='uncertain'))searches.push(await reconcileOutgoingMail(new EmailDrafts(this.config.store,this.ns(owner),b.googleAccountId),r.intent,ctx,{oauth:b.oauth,connectionId:b.connectionId,http:(input,init)=>composed.http(input,init,ctx),assertCurrent:composed.fence}));
   return {...this.status(this.owned(owner,t.id)),reconciliation:searches};
  }
  const sourceOverride=path==='/mail/edit'&&(Object.hasOwn(data,'attachmentIds')||Object.hasOwn(data,'sourceTaskId'))?{selection:selectMailAttachments(this.config.tasks,this.config.store,this.ns(owner),data.sourceTaskId,data.attachmentIds)}:undefined;
  if(!sourceOverride)assertMailAttachmentsCurrent(this.config.tasks,this.config.store,this.ns(owner),t.mail!.service!.source);
  if((path==='/mail/publish'||path==='/mail/send')&&!this.review(t,ref).attachmentsComplete)fail(409,'MAIL_ATTACHMENT_SELECTION_INCOMPLETE');
  // A concurrent identical action only observes retained state; it never starts a second run.
  if(this.controllers.has(t.id)||t.mail!.service!.active)return this.status(t);
  if(uncertain(t)){
   const retained=path==='/mail/publish'?t.mail!.publishes?.['request:'+data.requestId]:path==='/mail/send'?t.mail!.requests?.['request:'+data.requestId]:undefined;
   if(retained&&same(retained.binding.draft,ref))return this.status(t);
   fail(409,'MAIL_RECONCILIATION_REQUIRED');
  }
  if(t.pending||t.recovery!=='clean')fail(409,'MAIL_RECONCILIATION_REQUIRED');
  const nonce=this.claim(t.id);
  try{
  let args:Record<string,unknown>={draft:ref},tool:string,grant:string|undefined;
  const composed=await this.tools(t,b);
  if(path==='/mail/edit'){
   const parsed=parseDraftContent(data.content),content=sourceOverride?{...parsed,attachments:(sourceOverride.selection?.artifacts??[]).map(({artifactId,sha256,name})=>({artifactId,sha256,name}))}:parsed,key='request:'+data.requestId,contentHash=hash([content,sourceOverride]),prior=t.mail!.service!.edits[key];
   if(prior){if(!same(prior.draft,ref)||prior.contentHash!==contentHash)fail(409,'MAIL_REQUEST_ID_CONFLICT');return this.status(t);}
   this.config.tasks.update(t.id,task=>{task.mail!.service!.edits[key]={draft:ref,contentHash};});
   args={draft:ref,content,provenanceIds:[]};tool='mail.draft.edit';
  }else if(path==='/mail/publish'){
   const p=composed.publication.approve(t.id,ref,data.requestId as string);if(p.state!=='approved')return this.status(this.owned(owner,t.id));tool='mail.draft.publish';
  }else{
   const a=composed.host.approve(t.id,ref,data.requestId as string);if(a.revoked||this.config.tasks.get(t.id).mail!.approvals[ref.draftId]?.id!==a.id||t.mail!.sends[a.id]?.outcome)return this.status(this.owned(owner,t.id));
   const state=await b.oauth.connectionState(b.connectionId);await b.assertCurrent();this.currentDraft(this.owned(owner,t.id),ref);
   grant=Object.values(mailSendGrants).find(g=>state?.grants.includes(g))??mailSendGrants.send;tool='mail.send';
  }
  const provider:AgentProvider={id:'trusted-owner-mail-action',async next(){return {kind:'tool',name:tool,args};}};
  await this.execute(t,b,nonce,provider,1,true,grant,undefined,sourceOverride);
  if(path==='/mail/edit')this.config.tasks.update(t.id,task=>{const e=task.mail!.service!.edits['request:'+data.requestId],latest=task.mail!.drafts[ref.draftId];if(latest&&!same(latest,ref)){e.result=latest;if(sourceOverride){task.mail!.service!.source=sourceOverride.selection;const selection=sourceOverride.selection;task.requestedOutcome=selection?JSON.stringify({request:task.mail!.service!.request,source:{taskId:selection.taskId,revision:selection.revision},attachments:selection.artifacts}):task.mail!.service!.request;if(!this.sourceCurrent(task)){task.status='blocked';task.blocker='MAIL_SOURCE_CHANGED';}}}});
  return this.status(this.owned(owner,t.id));
  }finally{this.config.tasks.update(t.id,task=>{if(task.mail!.service!.active===nonce)delete task.mail!.service!.active;});}
 }
 async close():Promise<void>{this.stopping=true;for(const c of this.controllers.values())c.abort();while(this.jobs.size)await Promise.allSettled([...this.jobs]);}
}
