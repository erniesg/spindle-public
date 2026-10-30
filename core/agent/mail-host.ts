import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {Task,ToolContext,ToolDefinition,RunOptions,ApplicationRevisionRef} from './contracts.js';
import type {AgentStore} from '../storage/agent-store.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import {EmailDrafts,mailBinding,parseDraftRef,type DraftRef,type MailSendBinding,type MailSendHost,type MailSendIntent,type SendOutcome,type LocalMailDraft} from '../connectors/google/outgoing.js';
import {createOutgoingMailTools} from '../connectors/google/outgoing-tools.js';

interface Approval {id:string;requestId:string;binding:MailSendBinding;connectionId:string;revoked:boolean;applicationRevision?:ApplicationRevisionRef}
interface SendRecord {intent:MailSendIntent;claim:{runId:string;callId:string;generation:number};outcome?:SendOutcome;latestError?:string;errorCount:number}
/** Domain state in the EXISTING atomic AgentStore task, not another outbox/database. */
export interface TaskMailState {service?:import('../mail/types.js').MailTaskRecord;publishes?:Record<string,import('../mail/types.js').GmailDraftPublication>;drafts:Record<string,DraftRef>;approvals:Record<string,Approval>;sends:Record<string,SendRecord>;/** One retained identity per trusted owner action; absence denotes legacy incomplete history. */requests?:Record<string,Approval>}
export type TaskMailReview={draft:DraftRef;sends:{draft:DraftRef;outcome:SendOutcome|null}[]} & (
 {state:'available';record:LocalMailDraft}|{state:'unavailable';error:'MAIL_DRAFT_UNAVAILABLE'}
);
export interface TaskMailReviewPage {drafts:TaskMailReview[];next?:string}
export interface TaskMailOptions {
 tasks:AgentStore;store:EvidenceStore;namespace:Namespace;sender:string;
 allowAttachment?:(context:ToolContext,artifactId:string)=>boolean;
 /** Backend-owned selected connection + authenticated session/standing-authority fence. */
 send?:Omit<MailSendHost,'approval'|'journal'>;
}
const empty=():TaskMailState=>({drafts:{},approvals:{},sends:{},requests:{}});
const requestKey=(id:string)=>`request:${id}`;
function revokeApproval(state:TaskMailState,a:Approval){a.revoked=true;const retained=state.requests?.[requestKey(a.requestId)];if(retained?.id===a.id)retained.revoked=true;}
function fail(code:string):never{throw Error(code);}
const unknown=(r:SendRecord)=>!r.outcome||r.outcome.state==='uncertain';
/** Trusted application calls approve/revoke only AFTER normal owner authentication
 * and review. Neither is a model tool or a Google consent grant. */
export function createTaskMailTools(options:TaskMailOptions){
 const ns=Object.freeze({...options.namespace}),drafts=new EmailDrafts(options.store,ns,options.sender),connection=options.send;
 const owned=(id:string)=>options.tasks.taskInNamespace(ns,id)??fail('MAIL_TASK_NOT_FOUND');
 const context=(ctx:ToolContext)=>{if(ctx.workspaceId!==ns.workspaceId||ctx.accountId!==ns.accountId||ctx.signal.aborted||!ctx.isCurrent())fail('MAIL_CONTEXT_CHANGED');const t=owned(ctx.taskId);if(t.status!=='working'||t.run.id!==ctx.runId)fail('MAIL_CONTEXT_CHANGED');return t;};
 const authorization=(t:Task,ref:DraftRef)=>{
  if(!connection||!same(t.mail?.drafts[ref.draftId],ref))return undefined;
  const a=t.mail?.approvals[ref.draftId];
  return a&&!a.revoked&&a.connectionId===connection.connectionId&&a.binding.connectionEpoch===connection.connectionEpoch&&same(a.binding.draft,ref)&&same(a.applicationRevision,t.applicationRevision)?a:undefined;
 };
 const approveExternalWrite:NonNullable<RunOptions['approveExternalWrite']>=(task,tool,args)=>{try{return tool.name==='mail.send'&&!!authorization(owned(task.id),parseDraftRef((args as any)?.draft));}catch{return false;}};
 const assertReady:NonNullable<RunOptions['assertReady']>=task=>{if(Object.values(owned(task.id).mail?.sends??{}).some(unknown))fail('MAIL_RECONCILIATION_REQUIRED');};
 const send:MailSendHost|undefined=connection&&{...connection,
  approval:async(ctx,binding)=>{const a=authorization(context(ctx),binding.draft);return a&&same(a.binding,binding)?{id:a.id,binding:structuredClone(a.binding)}:undefined;},
  assertCurrent:async(ctx,a)=>{const check=()=>{const actual=authorization(context(ctx),a.binding.draft);if(!actual||actual.id!==a.id||!same(actual.binding,a.binding))fail('MAIL_APPROVAL_CHANGED');};check();await connection.assertCurrent(ctx,a);check();},
  journal:{
   reserve:async(intent,ctx)=>{
    context(ctx);let result:'new'|'existing'='existing';options.tasks.update(ctx.taskId,t=>{
     const a=authorization(t,intent.binding.draft);if(t.status!=='working'||t.run.id!==ctx.runId||ctx.signal.aborted||!ctx.isCurrent()||!a||a.id!==intent.id||!same(a.binding,intent.binding)||intent.taskId!==t.id||t.pending?.tool!=='mail.send'||t.pending.callId!==ctx.callId||t.pending.effect!=='external_write')fail('MAIL_RUNTIME_ADMISSION_REQUIRED');
     const state=t.mail??=empty(),prior=state.sends[intent.id];if(prior){if(!same(prior.intent,intent))fail('MAIL_INTENT_CHANGED');return;}
     state.sends[intent.id]={intent:structuredClone(intent),claim:{runId:ctx.runId,callId:ctx.callId,generation:t.generation},errorCount:0};t.externalAction={id:intent.id,authorizationId:intent.approvalId,state:'intent'};result='new';
    });return result;
   },
   assertReserved:async(intent,ctx)=>{const t=context(ctx),r=t.mail?.sends[intent.id];if(!r||!same(r.intent,intent)||r.claim.runId!==ctx.runId||r.claim.callId!==ctx.callId||r.claim.generation!==t.generation||r.outcome)fail('MAIL_RESERVATION_CHANGED');},
   settle:async(intent,outcome)=>{
    owned(intent.taskId);options.tasks.update(intent.taskId,t=>{const r=t.mail?.sends[intent.id];if(!r||!same(r.intent,intent))fail('MAIL_INTENT_CHANGED');
     // Post-dispatch facts survive cancellation/revocation; a late uncertainty
     // cannot erase a previously committed acknowledgement.
     if(r.outcome?.state!=='sent')r.outcome=structuredClone(outcome);
     if(outcome.state!=='sent'){r.latestError=outcome.code;r.errorCount++;}
     if(t.externalAction?.id===intent.id)t.externalAction.state=r.outcome?.state==='sent'?'verified':'uncertain';
    });
   }
  }
 };
 const tools=createOutgoingMailTools({store:options.store,namespace:ns,sender:options.sender,allowAttachment:options.allowAttachment,send}).map(tool=>({...tool,async invoke(args:unknown,ctx:ToolContext){
  context(ctx);
  if(tool.name==='mail.draft.read'||tool.name==='mail.draft.edit'){
   const ref=parseDraftRef((args as any)?.draft),t=owned(ctx.taskId);
   const retained=Object.values(t.mail?.drafts??{}).some(r=>same(r,ref))||t.observations.some(o=>same((o.data as any)?.draft,ref));
   if(!retained)fail('MAIL_DRAFT_NOT_ADMITTED');
   if(tool.name==='mail.draft.edit'&&!same(t.mail?.drafts[ref.draftId],ref))fail('MAIL_DRAFT_NOT_CURRENT');
  }
  if(tool.name==='mail.send'){
   const a=authorization(owned(ctx.taskId),parseDraftRef((args as any)?.draft)),known=a&&owned(ctx.taskId).mail?.sends[a.id]?.outcome;
   if(known?.state==='sent'&&a&&send){await send.assertCurrent(ctx,{id:a.id,binding:a.binding});return {callId:ctx.callId,status:'ok' as const,data:structuredClone(known),artifacts:[],evidence:[],observations:['Retained provider acknowledgement; no new send.']};}
  }
  const result=await tool.invoke(args,ctx);
  if(result.status==='ok'&&['mail.draft.create','mail.draft.edit'].includes(tool.name)){
   const ref=parseDraftRef((result.data as any).draft);drafts.read(ref);context(ctx);
   options.tasks.update(ctx.taskId,t=>{if(t.status!=='working'||t.run.id!==ctx.runId||ctx.signal.aborted||!ctx.isCurrent())fail('MAIL_CONTEXT_CHANGED');const state=t.mail??=empty();state.drafts[ref.draftId]=ref;const a=state.approvals[ref.draftId];if(a&&!same(a.binding.draft,ref))revokeApproval(state,a);});
  }
  return result;
 }}));
 return {tools,approveExternalWrite,assertReady,execution:{approveExternalWrite,assertReady},
  approve(taskId:string,value:unknown,requestId:string){
   if(!connection||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(requestId))fail('MAIL_APPROVAL_CONFIGURATION_REQUIRED');
   const ref=parseDraftRef(value),snapshot=drafts.read(ref),binding=mailBinding(ns,connection.connectionEpoch,snapshot);let approved:Approval|undefined;
   owned(taskId);options.tasks.update(taskId,t=>{if(t.status==='cancelled'||!same(t.mail?.drafts[ref.draftId],ref))fail('MAIL_DRAFT_NOT_CURRENT');const state=t.mail??=empty(),prior=state.approvals[ref.draftId];
    const legacy=state.requests===undefined&&(Object.keys(state.approvals).length>0||Object.keys(state.sends).length>0);
    if(!legacy)state.requests??={};
    const key=requestKey(requestId),retained=legacy?(prior?.requestId===requestId?prior:undefined):state.requests![key];
    if(retained){if(!same(retained.binding,binding)||retained.connectionId!==connection.connectionId||!same(retained.applicationRevision,t.applicationRevision))fail('MAIL_REQUEST_ID_CONFLICT');approved=retained;return;}
    // Forgotten legacy request identities cannot be reconstructed from send IDs.
    if(legacy)fail('MAIL_APPROVAL_HISTORY_RECONCILIATION_REQUIRED');
    if(Object.values(state.sends).some(r=>r.intent.binding.draft.draftId===ref.draftId&&unknown(r)))fail('MAIL_RECONCILIATION_REQUIRED');
    if(prior)revokeApproval(state,prior);
    approved={id:randomUUID(),requestId,binding,connectionId:connection.connectionId,revoked:false,...(t.applicationRevision?{applicationRevision:structuredClone(t.applicationRevision)}:{})};state.approvals[ref.draftId]=approved;state.requests![key]=structuredClone(approved);
   });return structuredClone(approved!);
  },
  revoke(taskId:string,approvalId:string){owned(taskId);options.tasks.update(taskId,t=>{if(t.mail)for(const a of Object.values(t.mail.approvals))if(a.id===approvalId)revokeApproval(t.mail,a);});},
  /** Owner-only read projection: no model turn, approval, reconciliation or send. */
  review(taskId:string,after=''):TaskMailReviewPage{
   const task=options.tasks.taskMailInNamespace(ns,taskId)??fail('MAIL_TASK_NOT_FOUND'),state=task.mail??empty();
   // One potentially large body per read; every logical draft remains pageable.
   const ids=Object.keys(state.drafts).sort().filter(id=>id>after),id=ids[0];if(!id)return {drafts:[]};
   const ref=state.drafts[id],base={draft:structuredClone(ref),sends:Object.values(state.sends).filter(r=>r.intent.binding.draft.draftId===ref.draftId).map(r=>({draft:structuredClone(r.intent.binding.draft),outcome:r.outcome?structuredClone(r.outcome):null}))};
   let view:TaskMailReview;try{view={...base,state:'available',record:drafts.read(ref).record};}
   catch{view={...base,state:'unavailable',error:'MAIL_DRAFT_UNAVAILABLE'};}
   return {drafts:[view],...(ids.length>1?{next:id}:{})};
  },
  status(taskId:string):TaskMailState{return structuredClone(owned(taskId).mail??empty());}
 };
}
