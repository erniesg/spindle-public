import type {Task} from '../agent/contracts.js';
import type {AgentSessionStore} from '../models/agent-session-store.js';
import {boundSaveHistory,SAVE_EVENT_WINDOW} from './types.js';
const keys=new Set(('kind effect name args calls callId itemId reason items id title state dependsOn blocker result status data artifacts evidence observations error code message producer inputId parameters values flatten format pageIndex folderId fileId pageToken artifactId outputId inputHash outputHash operation metadata issues nextAction source sourceId sourceVersion sourceWidthPx sourceHeightPx coordinateSpace spans spanIds text confidence uncertainty polygon x y width height crop backgroundRGB maxBytes quality mask cloneFrom mimeType sha256 bytes createdAt derivedFrom version provider providerId providerVersion snapshotArtifactId retrievedAt listing files nextPageToken parts checks passed semanticVision semantic backgroundVerified visualQualityVerified inputArtifactId canonicalHash ocrArtifactId regions preview imageBounds displayOnly pixelAccuracyVerified formSemanticsVerified sourcePixelDimensions imageHash pageHash pagePolygon pageBbox pageCoordinateSpace page pageGeometry documentArtifactId documentHash renderArtifactId renderHash renderPixelDimensions pagePoints cropBox userUnit pdfToPage inputToRender coordinateSystem coordinateProvenance bbox imageGeometry encodedDimensions orientedDimensions canonicalDimensions canonicalToSource sourceToEncoded geometryBasis originalOrientation coverage maximumSpans geometry encoded oriented canonical orientation canonicalToOriented orientedToEncoded scaleX scaleY rotation pageCount pages fields label value unresolved citations corrected intent verification providerVersion url revision rootId accountId connectionEpoch size dimensions mode dpi units bounds rect fontSize textLayerCoverage semanticVerification coverage truncated maximumSpans backend model usage inputTokens outputTokens reservationDisposition budgetScope').split(' '));
const secretKey=/(?:password|secret|token|cookie|authorization|credential|verifier|authurl|endpoint|relativepath|filepath|system|developer|reasoning|base64)/i;
/** Visible text is data; redact recognizable credentials/authorization URLs and host paths.
 * This is not a raw log scrubber: only known structured records ever enter it. */
function text(s:string):string{return s.slice(0,32768).replace(/\b(password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|cookie)\s*(?::|=|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[credential omitted]').replace(/https?:\/\/[^\s"<>]*(?:oauth|accounts\.google|[?&](?:code|state|token|key)=)[^\s"<>]*/gi,'[authorization URL omitted]').replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._~+\/-]+/g,'[credential omitted]').replace(/(?:\/(?:home|tmp|var|Users)\/|[A-Z]:\\)[^\s"<>]*/g,'[host path omitted]');}
export function visibleRecord(value:unknown,depth=0):unknown {
 if(depth>12)return '[bounded]';
 if(typeof value==='string')return text(value);
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(Array.isArray(value))return value.slice(0,256).map(v=>visibleRecord(v,depth+1));
 if(!value||typeof value!=='object')return undefined;
 const record=value as Record<string,unknown>;
 if([record.id,record.label].some(v=>typeof v==='string'&&/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\b/i.test(v)))return {redacted:true};
 const result:Record<string,unknown>={};
 for(const [k,v]of Object.entries(value)){
  if(k==='values'&&v&&typeof v==='object'&&!Array.isArray(v)){
   result[k]=Object.fromEntries(Object.entries(v).slice(0,256).filter(([name,value])=>name.length<=256&&!secretKey.test(name)&&(typeof value==='string'||typeof value==='boolean'||Array.isArray(value)&&value.every(x=>typeof x==='string'))).map(([name,value])=>[text(name),Array.isArray(value)?value.slice(0,256).map(x=>text(x as string)):typeof value==='string'?text(value):value]));
  }else if(!secretKey.test(k)&&keys.has(k))result[k]=visibleRecord(v,depth+1);
 }
 return result;
}
export function preparationSession(task:Task,sessions:AgentSessionStore,buildIdentity:string,sourceIdentity?:{revision:string;tree?:string}){
 const ns={workspaceId:task.sourceEvent.workspaceId,accountId:task.sourceEvent.accountId},p=task.preparation!;
 return {kind:'spindle.visible-session.v1',taskId:task.id,runId:task.run.id,revision:p.revision,status:task.status,recovery:task.recovery,pending:task.pending??null,blocker:visibleRecord(task.blocker),nextAction:visibleRecord(task.nextAction),processingConsent:p.processingConsent,mode:p.saveOutputs?'drive_outputs':'local_draft',saveOutputs:p.saveOutputs,sourceIdentity:sourceIdentity??null,buildIdentity,
  cutoff:{cursor:task.run.cursor,observations:task.observations.length,description:'Committed visible records and in-progress intents at this cutoff. Excludes this export result, its future upload and future final status; consult authenticated task status for the receipt.'},
  messages:[{role:'user',content:text(p.request)},...p.revisions.map(r=>({role:'user',content:`Correction ${r.fieldId}: ${text(r.value)}`,revision:r.revision})),...task.decisions.filter(d=>d.kind==='ready').map(d=>({role:'assistant',content:text(d.result)}))],
  checklist:visibleRecord(task.checklist),decisions:task.decisions.map(d=>visibleRecord(d)),results:task.observations.map(o=>visibleRecord(o)),
  sources:p.sources.map(s=>({id:s.id,provider:s.provider,providerId:s.providerId,providerVersion:s.providerVersion,sha256:s.sha256,snapshotArtifactId:s.snapshotArtifactId,mimeType:s.mimeType})),fields:visibleRecord(p.fields),
  outputs:p.uploads.map(u=>({artifactId:u.artifactId,revision:u.revision,state:u.state,providerId:u.providerId,providerVersion:u.providerVersion,url:u.url})),
  modelCalls:sessions.list(ns,task.id).map(e=>({runId:e.runId,cursor:e.cursor,model:e.model,configDigest:e.configDigest,reservation:e.reservation,decision:e.response&&visibleRecord(e.response.decision),usage:e.response?.usage??null,responsePersisted:!!e.response})),
  saveActions:(p.saves??[]).map(original=>{const s=structuredClone(original);boundSaveHistory(s);return {id:s.id,kind:s.kind,revision:s.revision,state:s.state,artifactIds:s.artifactIds,history:{...s.history,windowLimit:SAVE_EVENT_WINDOW,windowOrder:'last_fact_update'},events:s.events.map(e=>({origin:'user_save',callId:e.callId,name:e.tool,args:visibleRecord(e.args),result:visibleRecord(e.result),error:visibleRecord(e.error)}))};}),
  visionCalls:sessions.operations(ns,task.id),
  budget:{...p.modelBudget},receipt:{path:'/preparation/status',taskId:task.id}};
}
