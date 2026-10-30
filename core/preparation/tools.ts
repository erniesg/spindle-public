import type {ToolDefinition} from '../agent/contracts.js';
import {resolveOcr} from '../evidence/ocr.js';
import {resolveInput} from '../evidence/inputs.js';
import type {PreparationField} from './types.js';
import type {PreparationContext} from './service.js';
import {exportPreparation} from './snapshots.js';
export type PreparationExportContext=Pick<PreparationContext,'taskId'|'namespace'|'tasks'|'store'|'sessions'|'scope'>&{saveSnapshotId?:string;
 /** Names the owner saved in Account settings; recorded values a letter or two away from one stay unresolved. */
 documentNames?:()=>Promise<readonly string[]>};
import {preparationArtifactCurrent} from './artifact-binding.js';
import {identifierProblem,documentNameProblem} from './identifiers.js';
class GroundingFailure extends Error {}
const empty={jsonSchema:{type:'object',properties:{},additionalProperties:false},parse(v:unknown){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length)throw Error('Expected empty arguments');return v;}};
const output={jsonSchema:{type:'object'},parse(v:unknown){if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid preparation result');return v;}};
export function preparationTools(c:PreparationExportContext,buildIdentity:string,sourceIdentity?:{revision:string;tree?:string}):ToolDefinition[]{
 return [
  {name:'session.export',version:'1',artifactFieldIds:()=>c.tasks.get(c.taskId).preparation!.fields.map(f=>f.id),capabilities:['preparation.session'],effect:'write_local',inputSchema:empty,outputSchema:output,
   async invoke(_args,ctx){return exportPreparation(c,ctx,'session',buildIdentity,sourceIdentity);}},
  {name:'draft.export',version:'1',artifactFieldIds:()=>c.tasks.get(c.taskId).preparation!.fields.map(f=>f.id),capabilities:['preparation.draft'],effect:'write_local',inputSchema:empty,outputSchema:output,
   async invoke(_args,ctx){return exportPreparation(c,ctx,'draft',buildIdentity,sourceIdentity);}},
  {name:'preparation.record_fields',version:'1',capabilities:['preparation.fields'],effect:'write_local',
   inputSchema:{jsonSchema:{type:'object',properties:{fields:{type:'array',maxItems:100,items:{type:'object',properties:{id:{type:'string'},label:{type:'string'},value:{type:'string'},unresolved:{type:'boolean'},citations:{type:'array',items:{type:'object',properties:{artifactId:{type:'string'},sourceId:{type:'string'},sourceVersion:{type:'string'},spanIds:{type:'array',items:{type:'string'}}},required:['artifactId','sourceId','sourceVersion'],additionalProperties:false}}},required:['id','label','value','unresolved','citations'],additionalProperties:false}}},required:['fields'],additionalProperties:false},
    parse(v:unknown){const raw=v as {fields:PreparationField[]};if(!raw||Object.keys(raw).join()!=='fields'||!Array.isArray(raw.fields)||raw.fields.length>100)throw Error('Invalid fields');
     // Field ids are internal keys: whitespace is normalized rather than refused (models write "nr ic").
     // Work on a copy so the model's own arguments (repetition-guard key, transcript) stay as sent.
     const a={fields:raw.fields.map(f=>f&&typeof f==='object'&&typeof f.id==='string'?{...f,id:f.id.trim().replace(/\s+/g,'_')}:f)};
     if(new Set(a.fields.map(f=>f?.id)).size!==a.fields.length)throw Error('Invalid fields: field ids must be unique');for(const f of a.fields){const why=!f?'not an object':Object.keys(f).find(k=>!['id','label','value','unresolved','citations'].includes(k))?`unknown key "${Object.keys(f).find(k=>!['id','label','value','unresolved','citations'].includes(k))}"`:!/^[A-Za-z0-9_-]{1,128}$/.test(f.id)?'id must use only letters, digits, _ or -':typeof f.label!=='string'||f.label.length>256?'label must be a string of at most 256 characters':typeof f.value!=='string'||f.value.length>8192?'value must be a string':typeof f.unresolved!=='boolean'?'unresolved must be true or false':!Array.isArray(f.citations)||f.citations.length>16?'citations must be an array of at most 16':f.unresolved&&f.value!==''?'an unresolved field must have an empty value':undefined;if(why)throw Error(`Invalid grounded field ${JSON.stringify(f?.id)}: ${why}`);for(const e of f.citations)if(!e||Object.keys(e).some(k=>!['artifactId','sourceId','sourceVersion','spanIds'].includes(k))||![e.artifactId,e.sourceId,e.sourceVersion].every(x=>typeof x==='string'&&x.length>0&&x.length<256)||e.spanIds!==undefined&&(!Array.isArray(e.spanIds)||!e.spanIds.length||e.spanIds.length>100||e.spanIds.some(x=>typeof x!=='string')))throw Error('Invalid citation');}return a;}},outputSchema:output,
   async invoke(args,ctx){const a=args as {fields:PreparationField[]},task=c.tasks.get(c.taskId),p=task.preparation!;
    const known=await c.documentNames?.()??[];
    try{for(const f of a.fields){
     const previous=p.fields.find(x=>x.id===f.id);if(previous?.corrected&&f.value!==previous.value)throw new GroundingFailure('Explicit correction takes precedence');
     if(f.unresolved||previous?.corrected)continue;
     if(!f.value||!f.citations.length)throw new GroundingFailure('Grounding required for nonblank values');
     let grounded=false,cited='';const masked=(v:string)=>/(?:[*•●█]{2,}|\b(?:redacted|masked|illegible|unreadable|unknown)\b)/i.test(v);
     for(const e of f.citations){
      const source=p.sources.find(s=>s.id===e.sourceId&&s.sha256===e.sourceVersion);if(!source||!p.artifactIds.includes(e.artifactId))throw new GroundingFailure('Citation outside task sources');
      const artifact=c.store.artifact(c.namespace,e.artifactId);let text='';
      if(artifact.mimeType==='application/vnd.spindle.ocr+json')text=((()=>{try{return resolveOcr(c.store,c.namespace,e.artifactId,e.sourceId,e.sourceVersion,e.spanIds??[]);}catch(error){throw new GroundingFailure(`Citation does not match that OCR result (${error instanceof Error?error.message:'invalid'}): cite spanIds exactly as listed in the OCR observation for artifact ${e.artifactId}`);}})() as {text:string;uncertainty?:string}[]).filter(s=>s.uncertainty!=='unresolved').map(s=>s.text).join('\n');
      else if(artifact.mimeType==='text/plain'){const input=resolveInput(c.store,ctx,e.artifactId);if(!input.roots.has(e.sourceId))throw new GroundingFailure('Citation lineage mismatch');text=input.bytes.toString('utf8');}
      else throw new GroundingFailure('Select persisted OCR spans or extracted text, not model-created prose');
      cited+='\n'+text;
      if(text.includes(f.value)&&!masked(f.value))grounded=true;
     }
     // A value may join several cited spans (e.g. two account holders) or differ only in spacing/punctuation/case:
     // every word of it must still appear in the cited text.
     const norm=(v:string)=>v.toUpperCase().replace(/[^\p{L}\p{N}]/gu,'');
     if(!grounded&&!masked(f.value)){const words=f.value.split(/[\s,;\/&]+/).map(norm).filter(Boolean),all=norm(cited);grounded=words.length>0&&words.every(w=>all.includes(w));}
     if(!grounded)throw new GroundingFailure(`Field ${f.id} ("${f.label.slice(0,60)}") value "${f.value.slice(0,80)}" is not in its cited text. Citable (resolved) text: "${cited.replace(/\s+/g,' ').slice(0,300)}". Unresolved OCR spans (readers disagreed) are excluded: leave disagreed values unresolved (blank) instead of guessing.`);
     const invalid=identifierProblem(f.label,f.value);
     if(invalid)throw new GroundingFailure(`Field ${f.id} ("${f.label.slice(0,60)}"): ${invalid}. Re-read a tighter zoom of that line, or record it unresolved (blank) for the owner to confirm; never adjust characters to make the check pass.`);
     const near=documentNameProblem(f.value,known);
     if(near)throw new GroundingFailure(`Field ${f.id} ("${f.label.slice(0,60)}"): ${near}. Record this field unresolved (blank) so the owner confirms it in review; do not substitute the saved name yourself.`);
    }}catch(error){if(!(error instanceof GroundingFailure))throw error;return {effect:'none',callId:ctx.callId,status:'failed',data:{kind:'spindle.preparation-grounding-failure.v1',nextAction:error.message},artifacts:[],evidence:[],observations:['No field changed. Resolve evidence/correction conflicts from actual observations.'],error:{code:'FIELD_GROUNDING_REQUIRED',message:error.message,producer:'preparation.record_fields'}};}
    ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('Stale field update');
    c.tasks.update(c.taskId,t=>{for(const f of a.fields){const previous=t.preparation!.fields.find(x=>x.id===f.id);if(previous?.corrected)continue;if(previous)Object.assign(previous,structuredClone(f));else t.preparation!.fields.push(structuredClone(f));}});
    return {callId:ctx.callId,status:'ok',data:{fields:c.tasks.get(c.taskId).preparation!.fields},artifacts:[],evidence:a.fields.flatMap(f=>f.citations.map(e=>({id:`${f.id}:${e.artifactId}`,artifactId:e.artifactId,sourceId:e.sourceId,sourceVersion:e.sourceVersion,spanIds:e.spanIds}))),observations:['Field values grounded in retained extractions; unresolved values remain blank; explicit user corrections preserved.']};}}
 ];
}
/** General edit boundary: caller can wrap the existing PDF factory, without another PDF engine. */
export function groundedDocumentTool(tool:ToolDefinition,c:PreparationContext):ToolDefinition{
 if(!['document.edit','document.overlay'].includes(tool.name))return tool;
 return {...tool,artifactFieldIds(args){const a=args as {values?:Record<string,unknown>;placements?:{text?:unknown;value?:unknown}[]};const values=(a.values?Object.values(a.values):a.placements?.map(p=>p.text??p.value)??[]).flat().map(String);return c.tasks.get(c.taskId).preparation!.fields.filter(f=>!f.unresolved&&values.includes(f.value)).map(f=>f.id);},async invoke(args,ctx){const a=args as {values?:Record<string,unknown>;placements?:{text?:unknown;value?:unknown}[]};const values=a.values?Object.values(a.values):a.placements?.map(p=>p.text??p.value)??[];const p=c.tasks.get(c.taskId).preparation!,fields=p.fields;
  if(p.revision>1){const input=resolveInput(c.store,ctx,(args as {inputId:string}).inputId).artifact;if(!preparationArtifactCurrent(c.store,c.namespace,p,input.id))return {effect:'none',callId:ctx.callId,status:'failed',data:{kind:'spindle.document.v1',operation:tool.name.split('.')[1],inputId:(args as {inputId:string}).inputId,nextAction:'Regenerate corrected PDF from its original or current-revision artifact, not an earlier filled output'},artifacts:[],evidence:[],observations:['No PDF edit invoked.'],error:{code:'CORRECTION_ORIGINAL_REQUIRED',message:'Earlier revision cannot be edited in place',producer:tool.name}};}
  for(const value of values){for(const part of Array.isArray(value)?value:[value])if(part!==''&&part!==false&&!fields.some(f=>!f.unresolved&&(f.value===String(part))))return {effect:'none',callId:ctx.callId,status:'failed',data:{kind:'spindle.document.v1',operation:tool.name.split('.')[1],inputId:(args as {inputId:string}).inputId,nextAction:'Record source-grounded fields or ask for explicit user corrections before filling'},artifacts:[],evidence:[],observations:['No PDF edit invoked.'],error:{code:'FIELD_GROUNDING_REQUIRED',message:'Document fill value needs source-grounded field or explicit correction',producer:tool.name}};}
  const result=await tool.invoke(args,ctx);
  // Approved document factory returns these validation failures only before publication;
  // genuine storage/postcommit exceptions escape this wrapper unchanged.
  return result.status!=='ok'&&!result.artifacts.length?{...result,effect:'none'}:result;
 }};
}
