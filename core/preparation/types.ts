import type {SourceRef} from '../evidence/types.js';
export interface PreparationCitation {artifactId:string;sourceId:string;sourceVersion:string;spanIds?:string[]}
export interface PreparationField {id:string;label:string;value:string;unresolved:boolean;citations:PreparationCitation[];corrected?:boolean}
export interface PreparationArtifactBinding {revision:number;sha256:string;fields:Record<string,string>|null;fieldStateHash:string;exportKind?:'session'|'draft'}
export const SAVE_EVENT_WINDOW=16;
export interface PreparationSaveHistory {
 coverage:'complete'|'legacy_lower_bound';
 observedUserAttempts:number;observedCapabilityEvents:number;droppedCapabilityEvents:number;
 dropped:{ok:number;needs_input:number;failed:number;error:number;unresolved:number};
 /** Last writer-known actual in-flight IDs, not an authority to replay anything. */
 activeCallIds:string[];
}
export interface PreparationSave {id:string;requestId:string;kind:'draft'|'session';revision:number;generation:number;saveOutputs:boolean;state:'capturing'|'local_saved'|'capture_failed'|'uploading'|'upload_blocked'|'uncertain'|'verified';artifactIds:string[];manifestArtifactId?:string;createdAt:string;error?:string;history?:PreparationSaveHistory;events:{callId?:string;tool:string;args:unknown;result?:import('../agent/contracts.js').ToolResult;error?:string}[]}
/** Bound factual history only. Upload intents, snapshot bytes and status are never pruned.
 * In-flight calls are protected; completed/error facts move to the tail on update.
 * Legacy counts are lower bounds from retained evidence, not invented lifetime totals. */
export function boundSaveHistory(save:PreparationSave,activeIds?:ReadonlySet<string>):boolean{
 let changed=false;
 if(!save.history){save.history={coverage:'legacy_lower_bound',observedUserAttempts:0,observedCapabilityEvents:save.events.length,droppedCapabilityEvents:0,dropped:{ok:0,needs_input:0,failed:0,error:0,unresolved:0},activeCallIds:[]};changed=true;}
 const history=save.history,active=activeIds??new Set(history.activeCallIds);
 const protectedIds=save.events.filter(e=>e.callId&&active.has(e.callId)&&!e.result&&!e.error).map(e=>e.callId!);
 if(JSON.stringify(history.activeCallIds)!==JSON.stringify(protectedIds)){history.activeCallIds=protectedIds;changed=true;}
 const protectedSet=new Set(protectedIds);let remaining=SAVE_EVENT_WINDOW;
 const keep=new Set<number>();
 for(let i=save.events.length-1;i>=0;i--){const e=save.events[i]!;if(e.callId&&protectedSet.has(e.callId))keep.add(i);else if(remaining-->0)keep.add(i);}
 if(keep.size!==save.events.length){
  save.events=save.events.filter((e,i)=>{if(keep.has(i))return true;history.droppedCapabilityEvents++;history.dropped[e.result?e.result.status:e.error?'error':'unresolved']++;return false;});changed=true;
 }
 return changed;
}
export type PreparationStep='discovery'|'read'|'ocr'|'photo'|'pdfFill'|'pdfRender'|'draft'|'session'|'driveOutput';
export interface PreparationExecution {state:'queued'|'running'|'idle'|'interrupted';phase:string;observedAt:string;reason?:'service_shutdown'|'owner_cancel'|'runtime_stop'}
export interface PreparationStepStatus {status:'running'|'ok'|'failed'|'needs_input';observedAt:string;origin:'runtime'|'manual_probe'|'user_save';code?:string}
/** Observed account API activity, not proof a human initiated it. No retrospective attribution. */
export interface PreparationAction {action:'request'|'resume'|'correct'|'cancel'|'save'|'source'|'run_start';actionId:string;observedAt:string;disposition:string;taskId:string;runId:string;generation:number;caller:'account_api';sessionCorrelation?:string;intentHash?:string}
export interface PreparationRecord {
 execution?:PreparationExecution;steps?:Partial<Record<PreparationStep,PreparationStepStatus>>;
 connectionId:string;rootId:string;incarnation:string;rootRevision:number;googleAccountId:string;
 requestId:string;request:string;revision:number;processingConsent:boolean;saveOutputs:boolean;
 sources:SourceRef[];sourceNames?:Record<string,string>;sourceDescriptions?:Record<string,string>;artifactRevisions?:Record<string,number>;artifactBindings?:Record<string,PreparationArtifactBinding>;artifactIds:string[];fields:PreparationField[];
 saves?:PreparationSave[];
 revisions:{revision:number;fieldId:string;value:string}[];
 uploads:{revision:number;artifactId:string;name:string;state:'intent'|'uncertain'|'verified';intent:unknown;providerId?:string;providerVersion?:string;url?:string}[];
 modelBudget:{limitUsd:number;maximumDecisionCalls:number;maximumVisionCalls:number;decisionCalls:number;visionCalls:number;reservedUsd:number};
}
export interface PreparationRequest {connectionId:string;rootId:string;request:string;requestId:string;processingConsent:true;saveOutputs:boolean;newIntent?:boolean}
export interface PreparationReceipt {taskId:string;revision:number;state:string}
