import {digest,type EvidenceStore, type Namespace} from '../evidence/store.js';
import type {AgentStore} from '../storage/agent-store.js';
import type {TaskBrowserReview} from '../agent/browser-host.js';
import {preparationArtifactCurrent} from './artifact-binding.js';

/** Trusted destination configuration, never supplied by a page/model as authority. */
export interface PreparationPortal {
 destination:string;submissionUrl:string;receiptUrl:string;
 encoding:'multipart'|'urlencoded';
 /** Host-owned form constants, e.g. a stable submission identity. */
 constants?:readonly {name:string;value:string}[];
}
export interface PreparationBrowserSelection {
 expectedRevision:number;
 fields:readonly {fieldId:string;name:string;id?:string}[];
 files:readonly {artifactId:string;field:string;filename:string}[];
}
const hash=(value:unknown)=>digest(Buffer.from(JSON.stringify(value)));
export class PreparationBrowserReviewFailure extends Error {}
function fail(code:string):never{throw new PreparationBrowserReviewFailure(code);}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max=8192):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
/** Validate trusted operator configuration before startup claims an owner or serves traffic. */
export function validatePreparationPortal(value:unknown):PreparationPortal {
 if(!record(value)||Object.keys(value).some(k=>!['destination','submissionUrl','receiptUrl','encoding','constants'].includes(k))||!text(value.destination,8192)||!text(value.submissionUrl,8192)||!text(value.receiptUrl,8192)||!['multipart','urlencoded'].includes(value.encoding as string))fail('PREPARATION_BROWSER_INVALID_DESTINATION');
 const target=value as unknown as PreparationPortal;
 let urls:URL[];try{urls=[target.destination,target.submissionUrl,target.receiptUrl].map(s=>new URL(s));}catch{fail('PREPARATION_BROWSER_INVALID_DESTINATION');}
 if(urls.some(u=>!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.origin!==urls[0]!.origin))fail('PREPARATION_BROWSER_INVALID_DESTINATION');
 if(target.constants!==undefined&&(!Array.isArray(target.constants)||target.constants.length>500||!target.constants.every(c=>record(c)&&Object.keys(c).every(k=>['name','value'].includes(k))&&text(c.name,2048)&&typeof c.value==='string'&&c.value.length<=8192)||new Set(target.constants.map(c=>c.name)).size!==target.constants.length))fail('PREPARATION_BROWSER_INVALID_DESTINATION');
 return {...structuredClone(target),destination:urls[0]!.href,submissionUrl:urls[1]!.href,receiptUrl:urls[2]!.href};
}
function validSelection(value:unknown):value is PreparationBrowserSelection {
 if(!record(value)||Object.keys(value).some(k=>!['expectedRevision','fields','files'].includes(k))||!Number.isSafeInteger(value.expectedRevision)||(value.expectedRevision as number)<1||!Array.isArray(value.fields)||value.fields.length>500||!Array.isArray(value.files)||value.files.length>16)return false;
 return value.fields.every(f=>record(f)&&Object.keys(f).every(k=>['fieldId','name','id'].includes(k))&&text(f.fieldId)&&text(f.name)&&(f.id===undefined||typeof f.id==='string'&&f.id.length<=8192))&&value.files.every(f=>record(f)&&Object.keys(f).every(k=>['artifactId','field','filename'].includes(k))&&text(f.artifactId)&&text(f.field)&&text(f.filename,1024));
}

/** Read-only adapter for an EXISTING prepared task, not a new application store or approval.
 * The caller must additionally enforce its current authenticated session/source authority,
 * display this snapshot, and pass the reviewed binding to the existing browser host.
 */
export function preparationBrowserReview(tasks:AgentStore,store:EvidenceStore,namespace:Namespace,taskId:string,selection:PreparationBrowserSelection,portal:PreparationPortal){
 if(!validSelection(selection))fail('PREPARATION_BROWSER_INVALID_SELECTION');
 const ns=Object.freeze({...namespace}),chosen=structuredClone(selection),target=validatePreparationPortal(portal);
 const read=()=>{
  const task=tasks.taskInNamespace(ns,taskId),p=task?.preparation;
  if(!task||!p)fail('PREPARATION_BROWSER_TASK_NOT_FOUND');
  if(task.status==='cancelled'||task.status==='working'||task.pending||task.recovery!=='clean'||task.browser?.recovery==='reconciliation_required')fail('PREPARATION_BROWSER_TASK_NOT_SETTLED');
  if(p.revision!==chosen.expectedRevision||!task.applicationRevision||task.applicationRevision.applicationId!==task.id||task.applicationRevision.revision!==p.revision)fail('PREPARATION_BROWSER_STALE_REVISION');
  const fields=chosen.fields.map(mapping=>{
   const field=p.fields.find(f=>f.id===mapping.fieldId);
   if(!field||field.unresolved||!mapping.name)fail('PREPARATION_BROWSER_FIELD_UNAVAILABLE');
   return {...structuredClone(field),name:mapping.name,...(mapping.id!==undefined?{controlId:mapping.id}:{})};
  });
  const names=[...fields.map(f=>f.name),...(target.constants??[]).map(f=>f.name)];
  if(new Set(names).size!==names.length)fail('PREPARATION_BROWSER_AMBIGUOUS_CONTROL');
  const files=chosen.files.map(file=>{
   if(!p.artifactIds.includes(file.artifactId)||!preparationArtifactCurrent(store,ns,p,file.artifactId))fail('PREPARATION_BROWSER_FILE_NOT_CURRENT');
   const artifact=store.artifact(ns,file.artifactId);store.read(ns,artifact.id,8*1024*1024);
   return {...file,sha256:artifact.sha256,mimeType:artifact.mimeType,bytes:artifact.bytes};
  });
  const review:TaskBrowserReview={revision:structuredClone(task.applicationRevision),controls:[...fields.map(f=>({name:f.name,value:f.value,...(f.controlId!==undefined?{id:f.controlId}:{})})),...(target.constants??[])],post:{url:target.submissionUrl,encoding:target.encoding,fields:[...fields.map(f=>({name:f.name,value:f.value})),...(target.constants??[])],files:files.map(({field,artifactId,filename})=>({field,artifactId,filename}))},receiptUrl:target.receiptUrl};
  const sourceHash=hash([task.generation,p.connectionId,p.incarnation,p.rootRevision,p.googleAccountId,p.sources,fields,files]);
  return {taskId,revision:p.revision,destination:target.destination,fields,files,review,sourceHash};
 };
 const snapshot=read(),fingerprint=hash([snapshot.destination,snapshot.review,snapshot.sourceHash]);
 return {...snapshot,fingerprint,
  /** Recheck BEFORE approval/transition. Execution still needs the host's live authority;
   * this settled-snapshot check grants no session, network effect or retry. */
  assertCurrent(){const current=read();if(hash([current.destination,current.review,current.sourceHash])!==fingerprint||hash([snapshot.destination,snapshot.review,snapshot.sourceHash])!==fingerprint)fail('PREPARATION_BROWSER_REVIEW_CHANGED');}
 };
}
/** Serializable display only; never a browser capability or approval. */
export type PreparationBrowserSnapshot=Omit<ReturnType<typeof preparationBrowserReview>,'assertCurrent'>;
