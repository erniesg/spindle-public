import {preparePurpose,fencePurpose,type PurposeIdentity,type PurposeVerdict} from '../../core/blocking/purpose.js';
import {JEV_SCOPE_REVISION,buildJevComparison} from '../../core/blocking/jev.js';
import type {PurposeEvidenceSource,PurposeProcessingGrant,PurposeTransport} from '../../core/blocking/wire.js';
let transport:PurposeTransport|undefined;
/** Called only by the shared preview owner with its separate authenticated slot. */
export function installPurposeTransport(value:PurposeTransport){transport=value;}
export interface ResourcePurposeEvidence {
 resource:string;purpose:string;policyVersion:number;source:PurposeEvidenceSource;
 title?:string;summary?:string;pageText:string;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const unknown=(reason:PurposeVerdict['reason']):PurposeVerdict=>({verdict:'unknown',reason});

/** Production browser -> separate host processing grant -> Jev result fence.
 * No native enrollment/recording or manual/path-word allow fallback occurs here.
 */
export async function requestPurposeEligibility(evidence:ResourcePurposeEvidence,current:()=>boolean,signal:AbortSignal):Promise<PurposeVerdict>{
 const send=transport;if(!send)return unknown('unavailable');
 const live=()=>!signal.aborted&&current()&&send===transport;
 try{
  if(!live())return unknown('cancelled');
  const session=await send({action:'session'},signal);
  if(!live())return unknown('stale');
  const sessionValue:unknown=session.ok?session.value:undefined;
  if(!object(sessionValue)||typeof sessionValue.binding!=='string'||sessionValue.configured!==true)return unknown('not-authorised');
  const binding=sessionValue.binding;
  const approved=await send({action:'grant',binding,approved:true,resource:evidence.resource,purpose:evidence.purpose,policyVersion:evidence.policyVersion,
   source:evidence.source,fields:['resource','purpose','title','summary','pageText']},signal);
  if(!live())return unknown('stale');
  if(!approved.ok||!object(approved.value))return unknown('not-authorised');
  const grant=approved.value as unknown as PurposeProcessingGrant;
  if(typeof grant.id!=='string'||!grant.id||grant.binding!==binding||grant.modelRevision!==JEV_SCOPE_REVISION
   ||grant.resource!==evidence.resource||grant.purpose!==evidence.purpose||grant.policyVersion!==evidence.policyVersion
   ||!object(grant.source)||grant.source.resource!==evidence.resource||grant.source.evidenceId!==evidence.source.evidenceId
   ||grant.source.mode!=='static-resource'||!Array.isArray(grant.fields)||grant.fields.join(',')!=='resource,purpose,title,summary,pageText')return unknown('stale');
  // Current binding and exact source come from this request/host grant, never
  // from a model answer. The model receives only purposeState's field projection.
  const raw={requestId:crypto.randomUUID(),resource:evidence.resource,purpose:evidence.purpose,policyVersion:evidence.policyVersion,
   expectedModelRevision:grant.modelRevision,expectedConsentRevision:grant.revision,
   ...(evidence.title===undefined?{}:{title:evidence.title}),...(evidence.summary===undefined?{}:{summary:evidence.summary}),pageText:evidence.pageText};
  const scope={modelRevision:grant.modelRevision,consentRevision:grant.revision,fields:grant.fields,pageTextSource:grant.source};
  let ticket=preparePurpose(raw,scope,performance.now());
  // Preserve admitted metadata when text is missing/weak. Reduce only the text
  // excerpt by whole code points until both shared state and provider body fit.
  while(!ticket||!buildJevComparison(ticket)){
   if(!raw.pageText)return unknown('malformed');
   const points=Array.from(raw.pageText);raw.pageText=points.slice(0,Math.floor(points.length*.75)).join('');
   ticket=preparePurpose(raw,scope,performance.now());
  }
  const result=await send({action:'classify',binding,grantId:grant.id,request:raw},signal);
  if(!result.ok)return unknown(signal.aborted?'cancelled':'unavailable');
  const identity:PurposeIdentity={requestId:raw.requestId,resource:evidence.resource,purpose:evidence.purpose,policyVersion:evidence.policyVersion,
   modelRevision:grant.modelRevision,consentRevision:grant.revision,evidenceId:evidence.source.evidenceId};
  return fencePurpose(ticket,result.value,live()?identity:undefined,performance.now(),signal);
 }catch{return unknown(signal.aborted?'cancelled':'unavailable');}
}
