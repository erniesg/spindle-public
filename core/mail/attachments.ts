import type {AgentStore} from '../storage/agent-store.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import {preparationArtifactCurrent} from '../preparation/artifact-binding.js';
import {MailFailure,mailLimits,type MailAttachment} from '../connectors/google/outgoing.js';
export interface MailSourceSelection {taskId:string;revision:number;artifacts:(MailAttachment&{mimeType:string;bytes:number})[]}
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v);
function fail(code:string):never{throw new MailFailure(code);}
function source(tasks:AgentStore,namespace:Namespace,id:unknown){if(!valid(id))fail('MAIL_SOURCE_UNAVAILABLE');const task=tasks.taskInNamespace(namespace,id as string);if(!task?.preparation)fail('MAIL_SOURCE_UNAVAILABLE');return task!;}
const extensions:Record<string,string>={'application/pdf':'.pdf','image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','application/json':'.json','text/plain':'.txt'};
const extension=(mime:string)=>extensions[mime]??'.bin';
/** Human attachment names: a completed form keeps its source's name; a prepared photo is an ID photo. */
function friendly(store:EvidenceStore,namespace:Namespace,p:NonNullable<ReturnType<AgentStore['get']>['preparation']>,id:string,mime:string):string{
 const ext=extension(mime);if(p.sources.some(s=>s.snapshotArtifactId===id))return 'source-'+id.slice(0,8)+ext;
 const seen=new Set<string>();let frontier=[id];
 while(frontier.length){const next:string[]=[];for(const a of frontier){if(seen.has(a))continue;seen.add(a);const src=p.sources.find(s=>s.snapshotArtifactId===a);
  if(src){const raw=(src.providerId&&(p as {sourceNames?:Record<string,string>}).sourceNames?.[src.providerId])||'';const base=raw.replace(/\.[A-Za-z0-9]{2,5}$/,'').replace(/[^\p{L}\p{N} ._()-]/gu,'').trim().slice(0,60);
   if(mime==='application/pdf'&&base)return `${base} (completed).pdf`;}
  try{next.push(...store.artifact(namespace,a).derivedFrom);}catch{/* missing parent: fall back below */}}frontier=next;}
 return mime.startsWith('image/')?'ID photo'+ext:'prepared-'+id.slice(0,8)+ext;
}
/** Explicit owner-selected CURRENT prepared outputs; never arbitrary same-account IDs or paths. */
export function selectMailAttachments(tasks:AgentStore,store:EvidenceStore,namespace:Namespace,taskId:unknown,ids:unknown):MailSourceSelection|undefined {
 if(taskId===undefined&&ids===undefined)return;
 if(!Array.isArray(ids)||ids.length>mailLimits.attachments||ids.some(id=>!valid(id))||new Set(ids).size!==ids.length)fail('MAIL_INVALID_ATTACHMENTS');
 if(!ids.length)return;
 const task=source(tasks,namespace,taskId),p=task.preparation!;
 const artifacts=ids.map(id=>{if(!p.artifactIds.includes(id)||!preparationArtifactCurrent(store,namespace,p,id))fail('MAIL_ATTACHMENT_NOT_CURRENT');const a=store.artifact(namespace,id);return {artifactId:a.id,sha256:a.sha256,mimeType:a.mimeType,bytes:a.bytes,name:friendly(store,namespace,p,a.id,a.mimeType)};});
 if(artifacts.reduce((total,a)=>total+a.bytes,0)>mailLimits.mime)fail('MAIL_ATTACHMENT_TOTAL_TOO_LARGE');
 return {taskId:task.id,revision:p.revision,artifacts};
}
export function assertMailAttachmentsCurrent(tasks:AgentStore,store:EvidenceStore,namespace:Namespace,selection:MailSourceSelection|undefined){
 if(!selection)return;const task=source(tasks,namespace,selection.taskId),p=task.preparation!;
 if(p.revision!==selection.revision)fail('MAIL_SOURCE_CHANGED');
 for(const ref of selection.artifacts){if(!p.artifactIds.includes(ref.artifactId)||!preparationArtifactCurrent(store,namespace,p,ref.artifactId))fail('MAIL_ATTACHMENT_NOT_CURRENT');const a=store.artifact(namespace,ref.artifactId);if(a.sha256!==ref.sha256||a.mimeType!==ref.mimeType||a.bytes!==ref.bytes)fail('MAIL_ATTACHMENT_NOT_CURRENT');}
}
export function mailAttachmentsComplete(selection:MailSourceSelection|undefined,actual:readonly MailAttachment[]):boolean {
 const keys=(values:readonly MailAttachment[])=>values.map(a=>a.artifactId+':'+a.sha256).sort();
 return JSON.stringify(keys(selection?.artifacts??[]))===JSON.stringify(keys(actual));
}
export function mailSources(tasks:AgentStore,store:EvidenceStore,namespace:Namespace,taskId:unknown){
 if(taskId===undefined)return {tasks:tasks.tasks(namespace).filter(t=>t.preparation).map(t=>({taskId:t.id,revision:t.preparation!.revision,request:t.requestedOutcome.slice(0,160)}))};
 const task=source(tasks,namespace,taskId),p=task.preparation!;
 return {taskId:task.id,revision:p.revision,artifacts:p.artifactIds.flatMap<Record<string,unknown>>(id=>{try{if(!preparationArtifactCurrent(store,namespace,p,id))return [];const a=store.artifact(namespace,id);return [{artifactId:a.id,sha256:a.sha256,mimeType:a.mimeType,bytes:a.bytes,name:friendly(store,namespace,p,a.id,a.mimeType)}];}catch{return [{artifactId:id,unavailable:true}];}})};
}
