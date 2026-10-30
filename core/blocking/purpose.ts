import {resourceIdentity} from './policy.js';

// Shared browser/host boundary only. No capture, provider call, persistence or
// permission grant. The authenticated host derives scope; wire expectations do not.
export const PURPOSE_TIMEOUT_MS=1500;
export const PURPOSE_PAGE_TEXT_BYTES=4096;
export const PURPOSE_STATE_BYTES=6144;
export type PurposeField='resource'|'purpose'|'title'|'summary'|'pageText';
export interface PurposeTextSource {resource:string;evidenceId:string}
export interface PurposeScope {
 modelRevision:string;consentRevision:number;fields:readonly PurposeField[];
 // Derived by the admitted current-page binding, never supplied by the model.
 pageTextSource?:Readonly<PurposeTextSource>;
}
export interface PurposeIdentity {
 requestId:string;resource:string;purpose:string;policyVersion:number;
 modelRevision:string;consentRevision:number;evidenceId:string;
}
export interface PurposeInput extends PurposeIdentity {metadata:Readonly<{title?:string;summary?:string}>;pageText?:string}
export interface PurposeTicket {readonly input:Readonly<PurposeInput>;readonly startedAt:number;readonly deadline:number}
export type PurposeReason='classified'|'uncertain'|'unavailable'|'timeout'|'cancelled'|'stale'|'busy'|'not-authorised'|'malformed'|'budget-denied';
export type PurposeVerdict={verdict:'allow'|'deny'|'unknown';reason:PurposeReason};
export interface PurposeReply extends PurposeIdentity, PurposeVerdict {authority:'none'}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const identityKeys=['requestId','resource','purpose','policyVersion','modelRevision','consentRevision','evidenceId'] as const;
const requestKeys=['requestId','resource','purpose','policyVersion','expectedModelRevision','expectedConsentRevision','title','summary','pageText'];
const reasons:readonly PurposeReason[]=['classified','uncertain','unavailable','timeout','cancelled','stale','busy','not-authorised','malformed','budget-denied'];

/** Project already-permitted metadata under a separate trusted processing scope.
 * Authentication, source/provenance admission and scope revocation belong to the
 * host binding. Recording/enrollment data is neither read nor an input here.
 * now is the caller's local monotonic operation time, never a capture clock.
 */
export function preparePurpose(raw:unknown,scope:PurposeScope|undefined,now:number):PurposeTicket|undefined {
 if(!scope||!revision(scope.consentRevision)||typeof scope.modelRevision!=='string'
  ||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(scope.modelRevision)
  ||!Array.isArray(scope.fields)||scope.fields.length>5||new Set(scope.fields).size!==scope.fields.length
  ||scope.fields.some(field=>!['resource','purpose','title','summary','pageText'].includes(field))
  ||!scope.fields.includes('resource')||!scope.fields.includes('purpose'))return;
 if(!object(raw)||Object.keys(raw).some(key=>!requestKeys.includes(key))
  ||typeof raw.requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(raw.requestId)
  ||typeof raw.resource!=='string'||raw.resource.length>2048
  ||typeof raw.purpose!=='string'||!raw.purpose.trim()||raw.purpose.length>120
  ||!revision(raw.policyVersion)||raw.expectedModelRevision!==scope.modelRevision
  ||raw.expectedConsentRevision!==scope.consentRevision||!Number.isFinite(now)||now<0
  ||!Number.isFinite(now+PURPOSE_TIMEOUT_MS)||now+PURPOSE_TIMEOUT_MS<=now)return;
 try {if(resourceIdentity(raw.resource)!==raw.resource)return;}catch{return;}
 const metadata:{title?:string;summary?:string}={};
 for(const [field,limit] of [['title',200],['summary',1000]] as const) {
  // Do not even read a denied optional field, including a getter-bearing input.
  if(!scope.fields.includes(field))continue;
  const value=raw[field];if(value===undefined)continue;
  if(typeof value!=='string'||value.length>limit)return;
  metadata[field]=value;
 }
 let pageText:string|undefined,evidenceId='metadata-only';
 if(scope.fields.includes('pageText')) {
  const value=raw.pageText;
  if(value!==undefined) {
   const source=scope.pageTextSource;
   if(typeof value!=='string'||value.length>PURPOSE_PAGE_TEXT_BYTES
    ||new TextEncoder().encode(value).byteLength>PURPOSE_PAGE_TEXT_BYTES
    ||!source||source.resource!==raw.resource||typeof source.evidenceId!=='string'
    ||!/^[A-Za-z0-9:_/-]{1,128}$/.test(source.evidenceId)||source.evidenceId==='metadata-only')return;
   pageText=value;evidenceId=source.evidenceId;
  }
 }
 const input=Object.freeze({requestId:raw.requestId,resource:raw.resource,purpose:raw.purpose,policyVersion:raw.policyVersion,
  modelRevision:scope.modelRevision,consentRevision:scope.consentRevision,evidenceId,metadata:Object.freeze(metadata),
  ...(pageText===undefined?{}:{pageText})});
 const ticket=Object.freeze({input,startedAt:now,deadline:now+PURPOSE_TIMEOUT_MS});
 if(new TextEncoder().encode(JSON.stringify(purposeState(ticket))).byteLength>PURPOSE_STATE_BYTES)return;
 return ticket;
}

/** Only this projection belongs in a provider request; local control IDs do not. */
export function purposeState(ticket:PurposeTicket):{purpose:string;resource:string;metadata:{title?:string;summary?:string};pageText?:string} {
 const {input}=ticket;
 return {purpose:input.purpose,resource:input.resource,metadata:{...input.metadata},...(input.pageText===undefined?{}:{pageText:input.pageText})};
}

/** A matching suggestion is still not network authority. The extension must also
 * revalidate current tab/navigation and apply its user's eligibility policy.
 * current is a trusted current request/scope snapshot, not echoed model output.
 */
export function fencePurpose(ticket:PurposeTicket,reply:unknown,current:PurposeIdentity|undefined,now:number,signal?:AbortSignal):PurposeVerdict {
 if(signal?.aborted)return {verdict:'unknown',reason:'cancelled'};
 if(!Number.isFinite(now)||now<ticket.startedAt||now>=ticket.deadline)return {verdict:'unknown',reason:'timeout'};
 if(!current||identityKeys.some(key=>current[key]!==ticket.input[key]))return {verdict:'unknown',reason:'stale'};
 if(!object(reply)||Object.keys(reply).sort().join(',')!==[...identityKeys,'authority','verdict','reason'].sort().join(','))return {verdict:'unknown',reason:'malformed'};
 const {authority,verdict,reason}=reply;
 if(authority!=='none'||(verdict!=='allow'&&verdict!=='deny'&&verdict!=='unknown')
  ||!reasons.includes(reason as PurposeReason))return {verdict:'unknown',reason:'malformed'};
 if(identityKeys.some(key=>reply[key]!==ticket.input[key]))return {verdict:'unknown',reason:'stale'};
 if(verdict!=='unknown'&&reason!=='classified')return {verdict:'unknown',reason:'malformed'};
 return {verdict,reason:reason as PurposeReason};
}
