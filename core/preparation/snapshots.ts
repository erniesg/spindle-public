import type {ArtifactRef} from '../evidence/types.js';
import type {ToolContext,ToolResult} from '../agent/contracts.js';
import type {PreparationExportContext} from './tools.js';
import {preparationSession,visibleRecord} from './session.js';
import {preparationArtifactBinding,preparationArtifactCurrent} from './artifact-binding.js';
/** Shared registered local export capability, usable by a model or an authenticated
 * user save action. No model/provider/Google call, status transition or recovery reset. */
export function exportPreparation(c:PreparationExportContext,ctx:ToolContext,kind:'draft'|'session',buildIdentity:string,sourceIdentity?:{revision:string;tree?:string}):ToolResult{
 ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('STALE_SAVE_REVISION');
 const task=c.tasks.get(c.taskId),p=task.preparation!,session=preparationSession(task,c.sessions,buildIdentity,sourceIdentity);
 const sourceIds=p.sources.map(s=>s.id).slice(0,100),artifacts:ArtifactRef[]=[];
 const put=(body:unknown,exportKind:'session'|'draft')=>{
  ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('STALE_SAVE_REVISION');
  const a=c.store.put(c.namespace,Buffer.from(JSON.stringify(body,null,2)),'application/json',sourceIds).artifact;artifacts.push(a);
  c.tasks.update(c.taskId,t=>{if(!ctx.isCurrent()||t.preparation!.revision!==p.revision)throw Error('STALE_SAVE_REVISION');const current=t.preparation!;current.artifactIds.push(a.id);(current.artifactRevisions??={})[a.id]=p.revision;(current.artifactBindings??={})[a.id]={...preparationArtifactBinding(current,a.sha256,current.fields.map(f=>f.id)),exportKind};const save=current.saves?.find(s=>s.id===c.saveSnapshotId);save?.artifactIds.push(a.id);});
  return a;
 };
 const sessionArtifact=put(session,'session');
 let selected=[sessionArtifact.id],manifest=sessionArtifact;
 if(kind==='draft'){
  const current=p.artifactIds.filter(id=>!p.sources.some(s=>s.snapshotArtifactId===id)&&['application/pdf','image/png','image/jpeg','image/webp'].includes(c.store.artifact(c.namespace,id).mimeType)&&preparationArtifactCurrent(c.store,c.namespace,p,id));
  const describe=(id:string)=>{const a=c.store.artifact(c.namespace,id);return {id,mimeType:a.mimeType,sha256:a.sha256,bytes:a.bytes,creationRevision:p.artifactRevisions?.[id]};};
  const body={kind:'spindle.preparation-draft.v1',taskId:task.id,revision:p.revision,status:task.status,recovery:task.recovery,pending:task.pending??null,blocker:visibleRecord(task.blocker)??null,cutoff:session.cutoff,sourceIdentity:sourceIdentity??null,buildIdentity,
   artifacts:current.map(describe),omittedHistoricalArtifacts:p.artifactIds.filter(id=>!p.sources.some(s=>s.snapshotArtifactId===id)&&!preparationArtifactCurrent(c.store,c.namespace,p,id)).map(id=>({id,reason:'historical_or_unknown_binding'})),
   hasGeneratedPdf:current.some(id=>c.store.artifact(c.namespace,id).mimeType==='application/pdf'),missing:current.some(id=>c.store.artifact(c.namespace,id).mimeType==='application/pdf')?[]:['No current generated PDF exists; no filled PDF was invented.'],
   fields:visibleRecord(p.fields),sources:session.sources,extractions:task.observations.filter(o=>(o.data as {kind?:string})?.kind==='spindle.ocr.v1'||(o.data as {operation?:string})?.operation==='extract_text').map(o=>visibleRecord(o)),errors:task.observations.filter(o=>o.status!=='ok').map(o=>visibleRecord(o)),session:{artifactId:sessionArtifact.id,sha256:sessionArtifact.sha256}};
  manifest=put(body,'draft');selected=[...current,sessionArtifact.id,manifest.id];
 }
 c.tasks.update(c.taskId,t=>{if(!ctx.isCurrent())throw Error('STALE_SAVE_REVISION');const save=t.preparation!.saves?.find(s=>s.id===c.saveSnapshotId);if(save){save.artifactIds=selected;save.manifestArtifactId=manifest.id;save.state='local_saved';}});
 return {callId:ctx.callId,status:'ok',data:{kind:kind==='draft'?'spindle.draft-export.v1':'spindle.session-export.v1',revision:p.revision,artifactId:manifest.id,sha256:manifest.sha256,sessionArtifactId:sessionArtifact.id,artifactIds:selected,status:task.status,cutoff:session.cutoff},artifacts,evidence:[],observations:['Immutable local snapshot of actual retained work/errors and exact revision/cutoff. Excludes its future uploads or final status; no model resumed and no PDF invented.']};
}
