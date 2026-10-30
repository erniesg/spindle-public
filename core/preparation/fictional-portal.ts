import type {Page} from 'playwright-core';
import type {Task} from '../agent/contracts.js';
import {digest,type EvidenceStore,type Namespace} from '../evidence/store.js';
import type {BrowserReceipt,BrowserSubmissionIntent} from '../tools/browser-forms.js';
import type {TaskBrowserReviewEvidence} from '../agent/browser-host.js';
import {startPortal,type PortalConfig} from '../../examples/application-portal/server.js';
import {preparationArtifactCurrent} from './artifact-binding.js';
import {PreparationBrowserReviewFailure} from './browser-review.js';
import type {PortalContinuationTarget} from './portal-continuation.js';

/** The ONE owned developer-fictional destination: three obvious invented text fields plus
 * a PDF and a PNG upload. Invented/publishable data only; never an unseen site or router. */
export const FICTIONAL_PORTAL:PortalConfig={
 title:'Spindle fictional application portal · invented data only',
 fields:[{name:'applicant_name',label:'Applicant name',required:true,maxLength:200},{name:'contact_email',label:'Contact email',required:true,type:'email',maxLength:200},{name:'programme',label:'Programme',required:true,maxLength:200}],
 attachments:[{name:'statement',label:'Statement (PDF)',required:true,type:'application/pdf',maxBytes:8*1024*1024},{name:'photo',label:'Photo (PNG)',required:true,type:'image/png',maxBytes:8*1024*1024}]
};
const FILES=[{field:'statement',mimeType:'application/pdf',filename:'statement.pdf'},{field:'photo',mimeType:'image/png',filename:'photo.png'}] as const;
const SUBMISSION_IDENTITY='idempotencyKey';
/** Operator mapping from prepared field IDs to the three controls. Prepared IDs are task data; controls are fixed. */
export interface FictionalPortalMapping {fields:readonly {fieldId:string;name:'applicant_name'|'contact_email'|'programme'}[]}
export const DEFAULT_FICTIONAL_MAPPING:FictionalPortalMapping={fields:[{fieldId:'applicant_name',name:'applicant_name'},{fieldId:'contact_email',name:'contact_email'},{fieldId:'programme',name:'programme'}]};

export function validFictionalMapping(value:unknown):FictionalPortalMapping{
 const m=value as FictionalPortalMapping,names=FICTIONAL_PORTAL.fields.map(f=>f.name);
 if(!m||typeof m!=='object'||Object.keys(m).join()!=='fields'||!Array.isArray(m.fields)||m.fields.length!==names.length||!m.fields.every(f=>f&&typeof f==='object'&&Object.keys(f).sort().join()==='fieldId,name'&&typeof f.fieldId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(f.fieldId))||names.some(n=>m.fields.filter(f=>f.name===n).length!==1)||new Set(m.fields.map(f=>f.fieldId)).size!==names.length)throw Error('FICTIONAL_PORTAL_MAPPING_INVALID');
 return structuredClone({fields:m.fields});
}

/** Starts the owned loopback destination (reused fixture logic). The operator owns its lifecycle. */
export function startFictionalPortal(directory:string,port?:number){return startPortal(directory,FICTIONAL_PORTAL,port===undefined?{}:{port});}

/** Current prepared output for one file control: never a raw source snapshot, a session/draft export or
 * a rendered page; the newest current-revision artifact wins and the owner sees its exact hash before approval. */
function preparedFile(task:Readonly<Task>,store:EvidenceStore,ns:Namespace,mimeType:string){
 const p=task.preparation!,sources=new Set(p.sources.map(s=>s.snapshotArtifactId));
 const rendered=(id:string)=>task.observations.some(o=>o.artifacts.some(a=>a.id===id)&&(o.data as {kind?:string;metadata?:{render?:unknown}}|null)?.kind==='spindle.document.v1'&&(o.data as {metadata?:{render?:unknown}}).metadata?.render!==undefined);
 const candidates=p.artifactIds.map((id,index)=>({id,index})).filter(({id})=>!sources.has(id)&&!p.artifactBindings?.[id]?.exportKind&&store.artifact(ns,id).mimeType===mimeType&&!rendered(id)&&preparationArtifactCurrent(store,ns,p,id));
 candidates.sort((a,b)=>(p.artifactRevisions?.[b.id]??0)-(p.artifactRevisions?.[a.id]??0)||b.index-a.index);
 return candidates[0]?.id??(():never=>{throw new PreparationBrowserReviewFailure('PREPARATION_BROWSER_FILE_UNAVAILABLE');})();
}

/** Trusted per-task target: operator origin/mapping/required controls; only the current files are task-derived. */
export function fictionalPortalTarget(origin:string,mapping:FictionalPortalMapping,task:Readonly<Task>,store:EvidenceStore,ns:Namespace):PortalContinuationTarget{
 if(!task.preparation||task.sourceEvent.accountId!==ns.accountId||task.sourceEvent.workspaceId!==ns.workspaceId)throw new PreparationBrowserReviewFailure('PREPARATION_BROWSER_TASK_NOT_FOUND');
 // One submission identity per task, so a replay or reconcile reads the SAME receipt.
 const key='spindle-'+task.id;
 return {portal:{destination:origin+'/',submissionUrl:origin+'/applications',receiptUrl:origin+'/receipts/'+digest(Buffer.from(key)),encoding:'multipart',constants:[{name:SUBMISSION_IDENTITY,value:key}]},
  selection:{fields:mapping.fields.map(f=>({fieldId:f.fieldId,name:f.name})),files:FILES.map(f=>({artifactId:preparedFile(task,store,ns,f.mimeType),field:f.field,filename:f.filename}))},
  required:{controls:[...FICTIONAL_PORTAL.fields.map(f=>f.name),SUBMISSION_IDENTITY],files:FILES.map(f=>f.field)}};
}

/** Trusted receipt parser for this destination only: the persisted receipt must carry exactly the reviewed bytes. */
export async function readFictionalReceipt(page:Page,intent:BrowserSubmissionIntent,_context:unknown,saved:Readonly<TaskBrowserReviewEvidence>):Promise<BrowserReceipt|undefined>{
 let actual:{reference?:unknown;status?:unknown;digest?:unknown};
 try{actual=JSON.parse(await page.locator('pre').first().innerText({timeout:5000}));}catch{return undefined;}
 const value=(name:string)=>saved.review.post.fields.find(f=>f.name===name)?.value;
 // Same canonical order the destination digests: configured fields, then configured attachments.
 const fields=Object.fromEntries(FICTIONAL_PORTAL.fields.map(f=>[f.name,value(f.name)??'']));
 const files=FICTIONAL_PORTAL.attachments.map(a=>{const f=saved.review.post.files.find(f=>f.field===a.name),r=f&&saved.files.find(r=>r.id===f.artifactId&&r.field===f.field);return r?{name:a.name,filename:f!.filename,type:r.mimeType,bytes:r.bytes,sha256:r.sha256}:undefined;});
 if(files.some(f=>!f)||actual.status!=='submitted'||typeof actual.reference!=='string'||!intent.receiptUrl.endsWith('/receipts/'+actual.reference)||actual.digest!==digest(Buffer.from(JSON.stringify({fields,files}))))return undefined;
 return {receiptId:actual.reference,contentHash:actual.digest as string,destination:intent.destination,revision:intent.revision};
}
