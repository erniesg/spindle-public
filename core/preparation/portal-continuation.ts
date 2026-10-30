import {isDeepStrictEqual as same} from 'node:util';
import type {AgentProvider, RunOptions, Task, TrustedScope} from '../agent/contracts.js';
import {AgentRuntime} from '../agent/runtime.js';
import {createTaskBrowserTools, type TaskBrowserOptions} from '../agent/browser-host.js';
import type {BrowserReceipt} from '../tools/browser-forms.js';
import type {EvidenceRef} from '../evidence/types.js';
import type {EvidenceStore, Namespace} from '../evidence/store.js';
import type {AgentStore} from '../storage/agent-store.js';
import type {PreparationAction} from './types.js';
import {preparationBrowserReview, type PreparationBrowserSelection, type PreparationPortal} from './browser-review.js';

/** Trusted host configuration. Never derived from a page, model or account request body. */
export interface PortalContinuationTarget {
 portal:PreparationPortal;
 /** Host-owned mapping from prepared fields/files to destination controls. */
 selection:Omit<PreparationBrowserSelection,'expectedRevision'>;
 /** Host-declared controls/file fields the destination requires; not every prep field or raw source. */
 required:{controls:readonly string[];files:readonly string[]};
}
export interface PortalContinuationOptions {
 tasks:AgentStore;store:EvidenceStore;namespace:Namespace;taskId:string;target:PortalContinuationTarget;
 /** Coordinator-owned browser/session/authority/receipt parser. Destination comes from `target` only. */
 browser:Omit<TaskBrowserOptions,'tasks'|'store'|'namespace'|'taskId'|'destination'|'submissionUrl'>;
 /** Async authenticated session + source check. NOT dispatch authority: the synchronous
  * `browser.authority` signal/isCurrent is rechecked after it and immediately before approval. */
 preflight(signal:AbortSignal):Promise<void>;
 /** Trusted transport that carried the owner request; recorded on the owner action, never inferred here. */
 caller:PreparationAction['caller'];
 /** Existing configured provider; phase instructions are coordinator-wired. Its adapter must settle
  * `next()` once `ctx.signal` aborts: the module drains in-flight calls rather than orphan their spend. */
 provider:AgentProvider;maxTurns:number;
 /** The configured run limit (AgentRuntime's default when absent). Reaching it supersedes the run
  * into a reconcilable hold; it is never recorded as owner cancellation. */
 timeoutMs?:number;
 scope?:TrustedScope;getScope?:RunOptions['getScope'];
 /** Existing family Ready gates (e.g. preparation outputs), composed, never replaced. */
 assertReady?:RunOptions['assertReady'];
 /** Owner cancellation. Disconnect/revocation is `browser.authority.signal`. */
 cancel?:AbortSignal;
}
export interface PortalApproval {expectedRevision:number;fingerprint:string;requestId:string}
export type PortalContinuationOutcome=
 |{state:'verified';approvalId:string;receipt:BrowserReceipt;evidence:EvidenceRef}
 |{state:'held';code:string;approvalId?:string;submission?:'uncertain'|'verified';interruption?:'deadline'|'authority'}
 |{state:'cancelled';approvalId?:string;submission?:'uncertain'|'verified'};
export class PortalContinuationFailure extends Error {}
function fail(code:string,cause?:unknown):never{throw new PortalContinuationFailure(code,cause===undefined?undefined:{cause});}

/** Same default as AgentRuntime; bounded so the runtime's own (owner-cancel) timer can sit above it. */
const RUNTIME_DEFAULT_TIMEOUT_MS=30_000,MAX_TIMEOUT_MS=2**30;
/** Blockers this module itself writes after superseding its own run before any submission claim. */
const INTERRUPTED={PORTAL_CONTINUATION_INTERRUPTED:'authority',PORTAL_CONTINUATION_DEADLINE_EXCEEDED:'deadline'} as const;
const MANIFEST='spindle.preparation-portal-approval';

function validTarget(target:PortalContinuationTarget){
 const {selection,required,portal}=target,names=[...selection.fields.map(f=>f.name),...(portal.constants??[]).map(c=>c.name)],files=selection.files.map(f=>f.field);
 const list=(v:readonly string[])=>Array.isArray(v)&&v.every(n=>typeof n==='string'&&n.length>0)&&new Set(v).size===v.length;
 if(!list(required.controls)||!list(required.files))fail('PORTAL_CONTINUATION_INVALID_TARGET');
 if(required.controls.some(n=>!names.includes(n))||required.files.some(n=>!files.includes(n)))fail('PORTAL_CONTINUATION_REQUIRED_UNCOVERED');
}
function validOptions(o:PortalContinuationOptions){
 validTarget(o.target);
 if(o.caller!=='account_api')fail('PORTAL_CONTINUATION_INVALID_CALLER');
 const ms=o.timeoutMs??RUNTIME_DEFAULT_TIMEOUT_MS;if(!Number.isSafeInteger(ms)||ms<1||ms>MAX_TIMEOUT_MS)fail('PORTAL_CONTINUATION_INVALID_TIMEOUT');
 return ms;
}
function budgeted(t:Task){
 const m=t.preparation?.modelBudget;
 // Precheck only: runtime/provider adapters still enforce; nothing here lifts or resets a cap.
 if(t.budget.used>=t.budget.limit||m&&m.decisionCalls>=m.maximumDecisionCalls)fail('PORTAL_CONTINUATION_BUDGET_EXHAUSTED');
}

function scoped(o:PortalContinuationOptions){
 const ns=Object.freeze({...o.namespace}),authority=o.browser.authority;
 const live=()=>{const t=o.tasks.taskInNamespace(ns,o.taskId)??fail('PORTAL_CONTINUATION_TASK_NOT_FOUND');if(authority.signal.aborted||!authority.isCurrent(t))fail('PORTAL_CONTINUATION_AUTHORITY_NOT_CURRENT');return t;};
 const host=()=>createTaskBrowserTools({...o.browser,tasks:o.tasks,store:o.store,namespace:ns,taskId:o.taskId,destination:o.target.portal.destination,submissionUrl:o.target.portal.submissionUrl});
 return {ns,live,host};
}
function verified(t:Task):Extract<PortalContinuationOutcome,{state:'verified'}>|undefined{
 const s=t.browser?.submission;
 return t.status==='ready'&&s?.state==='verified'&&s.receipt&&s.evidence?{state:'verified',approvalId:s.approvalId,receipt:structuredClone(s.receipt),evidence:structuredClone(s.evidence)}:undefined;
}
/** This module's own clean pre-claim interruption: the only non-ready state a fresh explicit approval may continue. */
function interrupted(t:Task){
 const s=t.browser;
 return t.status==='blocked'&&!!t.blocker&&Object.hasOwn(INTERRUPTED,t.blocker)&&!!s?.approvalHistory?.requests.length&&s.recovery==='clean'&&!s.submission&&!t.externalAction;
}

/** Runs the existing runtime on the SAME task after explicit owner continuation; drains provider and host. */
async function drive(o:PortalContinuationOptions,deadlineMs:number,host:Awaited<ReturnType<typeof createTaskBrowserTools>>,tools:typeof host.tools,writes:boolean):Promise<PortalContinuationOutcome>{
 const runtime=new AgentRuntime(o.tasks,tools),inflight=new Set<Promise<unknown>>();
 // The runtime claims a generation/run id when it starts; the provider sees that claim.
 const before=o.tasks.get(o.taskId);let claim:{generation:number;runId:string}|undefined;
 const provider:AgentProvider={id:o.provider.id,next(task,metadata,ctx){claim??={generation:task.generation,runId:task.run.id};const p=o.provider.next(task,metadata,ctx);inflight.add(p);void p.finally(()=>inflight.delete(p)).catch(()=>{});return p;}};
 const ours=(t:Task)=>claim?t.generation===claim.generation&&t.run.id===claim.runId:t.generation===before.generation+1&&t.run.id!==before.run.id;
 const observed=(t:Readonly<Task>)=>{
  const s=o.tasks.get(o.taskId).browser?.submission;
  if(!s||s.state!=='verified')fail('PORTAL_CONTINUATION_RECEIPT_NOT_VERIFIED');
  // The provider must have seen the host's verification result, not merely the stored state.
  if(!t.observations.some(r=>{const d=r.data as {state?:unknown;intentId?:unknown}|null;return r.status==='ok'&&d?.state==='verified'&&d.intentId===s.intent.id&&r.artifacts.some(a=>s.artifacts.includes(a.id));}))fail('PORTAL_CONTINUATION_VERIFICATION_NOT_OBSERVED');
 };
 const stop=()=>runtime.cancel(o.taskId);o.cancel?.addEventListener('abort',stop,{once:true});
 // The configured limit supersedes like a disconnect. The runtime's own timer would record
 // "Cancelled by user", so it is only a backstop above the configured limit.
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),deadlineMs);
 try{
  if(o.cancel?.aborted)stop();
  await runtime.run(o.taskId,provider,o.maxTurns,{scope:o.scope,getScope:o.getScope,timeoutMs:2*deadlineMs,blockOnTurnLimit:true,
   // Disconnect/revocation/deadline supersede this run without being recorded as owner cancellation.
   signal:AbortSignal.any([o.browser.authority.signal,deadline.signal]),signalMode:'supersede',
   ...(writes?{approveExternalWrite:host.execution.approveExternalWrite}:{}),
   assertReady:t=>{host.execution.assertReady(t);observed(t);o.assertReady?.(t);}});
 }finally{clearTimeout(timer);o.cancel?.removeEventListener('abort',stop);while(inflight.size)await Promise.allSettled([...inflight]);}
 const reason=o.browser.authority.signal.aborted||!deadline.signal.aborted?'PORTAL_CONTINUATION_INTERRUPTED':'PORTAL_CONTINUATION_DEADLINE_EXCEEDED';
 // A superseded run returns without a transition; hold it like the runtime's own error path,
 // but only while the task still carries this run's claim (never another runner's). A write in
 // flight stays uncertain. This run's own READ is retired as AgentStore.recover does: its tool
 // context is already aborted, so the host refuses its late commit, and host.close() awaits it.
 o.tasks.update(o.taskId,t=>{if(t.status!=='working'||!ours(t))return;t.status='blocked';t.blocker=reason;t.nextAction='Reconcile retained browser effects before explicit continuation';if(t.pending?.effect==='read')delete t.pending;else if(t.pending)t.recovery='reconciliation_required';});
 const t=o.tasks.get(o.taskId),s=host.status(),approvalId=s.approval?.id,submission=s.submission?.state;
 const done=verified(t);if(done)return done;
 if(t.status==='cancelled')return {state:'cancelled',...(approvalId?{approvalId}:{}),...(submission?{submission}:{})};
 const interruption=t.status==='blocked'&&t.blocker&&Object.hasOwn(INTERRUPTED,t.blocker)?INTERRUPTED[t.blocker as keyof typeof INTERRUPTED]:undefined;
 return {state:'held',code:s.recovery==='reconciliation_required'||t.recovery!=='clean'?'PORTAL_CONTINUATION_RECONCILIATION_REQUIRED':'PORTAL_CONTINUATION_NOT_VERIFIED',...(approvalId?{approvalId}:{}),...(submission?{submission}:{}),...(interruption?{interruption}:{})};
}

/** The retained owner-action manifest for a replayed request, located by the audited intent hash. */
function manifestFor(o:PortalContinuationOptions,ns:Namespace,requestId:string,approvalId:string){
 const action=o.tasks.preparationActions(ns,o.taskId).find(a=>a.disposition==='portal_approved'&&a.actionId===requestId);
 const rows=action?.intentHash?o.store.db.prepare("SELECT id FROM artifacts WHERE workspace=? AND account=? AND json_extract(body,'$.sha256')=? LIMIT 8").all(ns.workspaceId,ns.accountId,action.intentHash) as {id:string}[]:[];
 for(const {id} of rows){
  const m=JSON.parse(o.store.read(ns,id,1024*1024).toString()) as {kind?:unknown;requestId?:unknown;approvalId?:unknown;reviewArtifactId?:unknown;fingerprint?:unknown;revision?:unknown;destination?:unknown};
  if(m.kind===MANIFEST&&m.requestId===requestId&&m.approvalId===approvalId)return m;
 }
 return fail('PORTAL_CONTINUATION_REPLAY_UNVERIFIABLE');
}

/** Explicit owner approval of the displayed review -> same-task browser continuation -> verified receipt.
 * No new task/store/queue; at most one submission; never a POST retry. */
export async function continuePreparationPortal(o:PortalContinuationOptions,approval:PortalApproval):Promise<PortalContinuationOutcome>{
 if(!approval||!Number.isSafeInteger(approval.expectedRevision)||approval.expectedRevision<1||typeof approval.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(approval.fingerprint)||typeof approval.requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(approval.requestId))fail('PORTAL_CONTINUATION_INVALID_APPROVAL');
 const deadlineMs=validOptions(o);
 const {ns,live,host:open}=scoped(o);
 const retained=(t:Task)=>{
  const s=t.browser,own=s?.approvalHistory?.requests.find(a=>a.requestId===approval.requestId);
  // A request id is one owner decision: once used it never re-approves, even without a submission.
  if(!s?.submission){if(own)fail('PORTAL_CONTINUATION_REQUEST_ALREADY_USED');return undefined;}
  // Same request replay returns the retained verified fact; anything else must reconcile, never re-approve.
  if(!own||own.id!==s.submission.approvalId)fail('PORTAL_CONTINUATION_SUBMISSION_EXISTS');
  const done=verified(t)??fail('PORTAL_CONTINUATION_RECONCILIATION_REQUIRED'),m=manifestFor(o,ns,approval.requestId,own.id);
  // The replay must name the review that was approved, and the receipt must descend from that approval.
  if(m.fingerprint!==approval.fingerprint||(m.revision as {revision?:unknown}|undefined)?.revision!==approval.expectedRevision||m.destination!==o.target.portal.destination||m.reviewArtifactId!==s.submission.reviewArtifact.id||!same(m.revision,s.submission.intent.revision))fail('PORTAL_CONTINUATION_REQUEST_ID_CONFLICT');
  return done;
 };
 const ready=(t:Task)=>{if(!(t.status==='ready'||interrupted(t))||t.pending||t.recovery!=='clean'||!t.preparation)fail('PORTAL_CONTINUATION_TASK_NOT_READY');budgeted(t);};
 const first=live(),replay=retained(first);if(replay)return replay;ready(first);
 const shown=preparationBrowserReview(o.tasks,o.store,ns,o.taskId,{expectedRevision:approval.expectedRevision,...o.target.selection},o.target.portal);
 if(shown.fingerprint!==approval.fingerprint)fail('PORTAL_CONTINUATION_REVIEW_CHANGED');
 const values=new Map(shown.review.post.fields.map(f=>[f.name,f.value]));
 if(o.target.required.controls.some(n=>!values.get(n)?.trim()))fail('PORTAL_CONTINUATION_REQUIRED_EMPTY');
 await o.preflight(o.cancel?AbortSignal.any([o.cancel,o.browser.authority.signal]):o.browser.authority.signal);
 if(o.cancel?.aborted)fail('PORTAL_CONTINUATION_CANCELLED');
 // A concurrent same-request continuation may have finished meanwhile: return its retained fact.
 const checked=live(),settled=retained(checked);if(settled)return settled;ready(checked);shown.assertCurrent();
 const host=await open();
 try{
  // Synchronous tail: no await between the final authority/review checks, approval and recovery.
  const t=live(),settled=retained(t);if(settled)return settled;ready(t);shown.assertCurrent();if(o.cancel?.aborted)fail('PORTAL_CONTINUATION_CANCELLED');
  const granted=host.approve(shown.review,approval.requestId);
  try{
   const manifest=o.store.put(ns,Buffer.from(JSON.stringify({kind:MANIFEST,version:1,requestId:approval.requestId,approvalId:granted.id,reviewArtifactId:granted.artifact.id,fingerprint:shown.fingerprint,sourceHash:shown.sourceHash,revision:shown.review.revision,destination:shown.destination,required:o.target.required,fields:shown.fields.map(f=>({fieldId:f.id,name:f.name})),files:shown.files.map(f=>({artifactId:f.artifactId,field:f.field,filename:f.filename,sha256:f.sha256}))})),'application/json',[granted.artifact.id]).artifact;
   o.tasks.recordPreparationAction(ns,{action:'resume',actionId:approval.requestId,disposition:'portal_approved',taskId:o.taskId,runId:t.run.id,generation:t.generation,observedAt:new Date().toISOString(),caller:o.caller,intentHash:manifest.sha256});
   o.tasks.recover(o.taskId);
  }catch(error){
   // An approval never outlives a failed owner-action audit: revoke it before reporting the failure.
   try{await host.revoke(granted.id);}catch(revoke){fail('PORTAL_CONTINUATION_APPROVAL_REVOKE_FAILED',new AggregateError([error,revoke]));}
   throw error;
  }
  return await drive(o,deadlineMs,host,host.tools,true);
 }finally{await host.close();}
}

/** Read-only receipt reconciliation for a retained uncertain submission. Registers ONLY
 * browser.verify_submission, so no fill/upload/submit can be admitted. Needs no new approval. */
export async function reconcilePreparationPortal(o:PortalContinuationOptions):Promise<PortalContinuationOutcome>{
 const deadlineMs=validOptions(o);
 const {live,host:open}=scoped(o);
 const check=(t:Task)=>{
  const done=verified(t);if(done)return done;
  if(!t.browser?.submission)fail('PORTAL_CONTINUATION_NO_SUBMISSION');
  // Generic interrupted-write/cancelled recovery remains coordinator-owned.
  if(t.status!=='blocked'||t.pending||t.recovery!=='clean')fail('PORTAL_CONTINUATION_TASK_NOT_RECONCILABLE');
  budgeted(t);return undefined;
 };
 const prior=check(live());if(prior)return prior;
 await o.preflight(o.cancel?AbortSignal.any([o.cancel,o.browser.authority.signal]):o.browser.authority.signal);
 if(o.cancel?.aborted)fail('PORTAL_CONTINUATION_CANCELLED');
 const host=await open();
 try{
  const again=check(live());if(again)return again;if(o.cancel?.aborted)fail('PORTAL_CONTINUATION_CANCELLED');
  o.tasks.recover(o.taskId);
  return await drive(o,deadlineMs,host,host.tools.filter(t=>t.name==='browser.verify_submission'),false);
 }finally{await host.close();}
}
