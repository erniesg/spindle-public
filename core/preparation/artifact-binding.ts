import {createHash} from 'node:crypto';
import type {Task} from '../agent/contracts.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import type {PreparationRecord,PreparationArtifactBinding} from './types.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fieldHash=(f:PreparationRecord['fields'][number])=>hash([f.value,f.unresolved]);
const fieldState=(p:PreparationRecord)=>hash(p.fields.map(f=>[f.id,fieldHash(f)]).sort(([a],[b])=>a!.localeCompare(b!)));
/** Field IDs come only from trusted factory/grounding wrappers, not model declarations. */
export function preparationArtifactBinding(p:PreparationRecord,sha256:string,fieldIds:readonly string[]|undefined):PreparationArtifactBinding{
 return {revision:p.revision,sha256,fields:fieldIds===undefined?null:Object.fromEntries([...new Set(fieldIds)].map(id=>{const f=p.fields.find(f=>f.id===id);if(!f)throw Error('UNKNOWN_ARTIFACT_FIELD_DEPENDENCY');return [id,fieldHash(f)];})),fieldStateHash:fieldState(p)};
}
function inspection(store:EvidenceStore,ns:Namespace,p:PreparationRecord,id:string){
 const roots=new Set<string>(),fields:Record<string,string>={};let unknown=false,visits=0;
 function walk(key:string,path:Set<string>):boolean{
  if(++visits>128||path.has(key))throw Error('ARTIFACT_DEPENDENCY_LINEAGE_BOUND');
  const source=p.sources.find(s=>s.id===key||s.snapshotArtifactId===key);
  if(source){const actual=store.source(ns,source.id),a=store.artifact(ns,source.snapshotArtifactId);if(actual.sha256!==source.sha256||a.sha256!==source.sha256||actual.snapshotArtifactId!==source.snapshotArtifactId)throw Error('ARTIFACT_SOURCE_BINDING_CHANGED');roots.add(JSON.stringify([source.provider,source.providerId??source.id,source.sha256]));return true;}
  const a=store.artifact(ns,key),b=p.artifactBindings?.[key];let current=!!b&&b.sha256===a.sha256&&p.artifactRevisions?.[key]===b.revision&&b.revision<=p.revision;
  if(!b||b.fields===null){unknown=true;current=current&&b!.revision===p.revision&&b!.fieldStateHash===fieldState(p);}
  else for(const [field,value]of Object.entries(b.fields)){fields[field]=value;current=current&&p.fields.some(f=>f.id===field&&fieldHash(f)===value);}
  const next=new Set(path).add(key);for(const parent of a.derivedFrom)current=walk(parent,next)&&current;
  return current;
 }
 const current=walk(id,new Set());return {current,roots:[...roots].sort().join('|'),fields,unknown};
}
export function preparationArtifactCurrent(store:EvidenceStore,ns:Namespace,p:PreparationRecord,id:string):boolean{return inspection(store,ns,p,id).current;}
const preparedMimes=new Set(['application/pdf','image/png','image/jpeg','image/webp']);
/** Prior immutable downloads remain historical. Each affected prepared-output family
 * needs a current replacement with its corrected fields and exact source lineage.
 * Evidence and genuinely source-only outputs carry forward without regeneration. */
export function assertPreparationArtifactsCurrent(store:EvidenceStore,ns:Namespace,task:Task):void{
 const p=task.preparation!,sources=new Set(p.sources.map(s=>s.snapshotArtifactId));
 const page=(id:string)=>{const data=task.observations.find(o=>o.artifacts.some(a=>a.id===id))?.data as {kind?:string;metadata?:{render?:{pageIndex:number}}}|undefined;return data?.kind==='spindle.document.v1'?data.metadata?.render?.pageIndex:undefined;};
 const outputs=p.artifactIds.filter(id=>!sources.has(id)&&preparedMimes.has(store.artifact(ns,id).mimeType)).map(id=>({id,a:store.artifact(ns,id),binding:inspection(store,ns,p,id),page:page(id)}));
 for(const stale of outputs.filter(o=>!o.binding.current)){
  const changed=Object.keys(stale.binding.fields).filter(id=>!p.fields.some(f=>f.id===id&&fieldHash(f)===stale.binding.fields[id]));
  if(!outputs.some(candidate=>candidate.binding.current&&candidate.a.mimeType===stale.a.mimeType&&candidate.binding.roots===stale.binding.roots&&candidate.page===stale.page&&changed.every(id=>candidate.binding.fields[id]!==undefined)))throw Error('DEPENDENT_OUTPUT_ARTIFACT_STALE');
 }
}
