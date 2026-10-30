import type { ToolDefinition, ToolContext } from '../agent/contracts.js';
import { EvidenceStore, digest } from '../evidence/store.js';
import { parseOcrRecord, spanId, ocrUncertainty, resolveOcr, type OcrRecord, type OcrSpan } from '../evidence/ocr.js';
import { jpegDimensions } from './ocr-image-metadata.js';
import {ocrOutputSchema} from './ocr-schema.js';
import {isEvidenceStoreFault,resolveInput} from '../evidence/inputs.js';
import {canonicalizeImage,renderImageRegions} from './images.js';
const MAX_RESPONSE=2*1024*1024;
function input(value:unknown):{sourceId:string} { const a=value as {sourceId:string}; if (!a || typeof a.sourceId !== 'string' || !a.sourceId.length || a.sourceId.length>256 || Object.keys(a).some(k=>k!=='sourceId')) throw new Error('Expected sourceId only'); return a; }
function current(ctx:ToolContext) { if(ctx.signal.aborted || !ctx.isCurrent()) throw new Error('Stale OCR operation'); }
async function bounded(response:Response, signal:AbortSignal):Promise<unknown> {
 if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('OCR backend unavailable'); }
 const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
 try { for (;;) { signal.throwIfAborted(); const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>MAX_RESPONSE) throw new Error('OCR response too large'); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
 finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export interface NimOcrOptions { store:EvidenceStore; endpoint:string; allowLoopback?:boolean; fetch?:typeof fetch; authorize:(context:ToolContext, endpoint:URL)=>boolean; timeoutMs?:number }
/** Explicit self-hosted NIM contract; not the hosted NVIDIA API. No fallback. */
export function createOcrTool(options:NimOcrOptions):ToolDefinition {
 const endpoint=new URL(options.endpoint);
 if(endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/ocr' || !(endpoint.protocol==='https:' || (options.allowLoopback && endpoint.protocol==='http:' && ['127.0.0.1','[::1]'].includes(endpoint.hostname)))) throw new Error('Select HTTPS NIM /v1/ocr or explicit numeric loopback');
 const timeout=options.timeoutMs??30000; if(!Number.isInteger(timeout)||timeout<1||timeout>120000) throw new Error('Invalid OCR timeout');
 return {name:'ocr.document',version:'1',effect:'write_local',capabilities:['image.processing'],inputSchema:{jsonSchema:{type:'object',properties:{sourceId:{type:'string',minLength:1,maxLength:256}},required:['sourceId'],additionalProperties:false},parse:input},outputSchema:ocrOutputSchema,async invoke(args,ctx) {
  const {sourceId}=input(args); current(ctx);
  if(!ctx.scope.grants.includes('image.processing') || !options.authorize(ctx,new URL(endpoint))) throw new Error('Image processing not granted');
  const ns={workspaceId:ctx.workspaceId,accountId:ctx.accountId};
  let record:OcrRecord;
  try {
  const source=options.store.source(ns,sourceId);
  if(!ctx.scope.sources.some(s=>s.id===source.id && s.sha256===source.sha256 && s.snapshotArtifactId===source.snapshotArtifactId)) throw new Error('Source not permitted');
  const meta=options.store.artifact(ns,source.snapshotArtifactId); if(meta.bytes>8*1024*1024) throw new Error('Image exceeds OCR bound');
  const bytes=options.store.read(ns,source.snapshotArtifactId);
  if(digest(bytes)!==source.sha256) throw new Error('Original image hash mismatch');
  let width:number,height:number;
  if(source.mimeType==='image/jpeg') ({width,height}=jpegDimensions(bytes));
  else {
  if(source.mimeType!=='image/png' || bytes.length<33 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8)!==13 || bytes.toString('ascii',12,16)!=='IHDR' || digest(bytes)!==source.sha256) throw new Error('Original PNG required');
  width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20); if(!width||!height||width>16384||height>16384||width*height>40000000) throw new Error('PNG dimensions exceed OCR bound');
  // eXIf can carry orientation. Refuse it rather than silently rotate source geometry.
  for(let pos=8;pos+12<=bytes.length;) { const n=bytes.readUInt32BE(pos); if(n>bytes.length-pos-12) throw new Error('Invalid PNG chunks'); if(bytes.toString('ascii',pos+4,pos+8)==='eXIf') throw new Error('PNG orientation metadata unsupported'); pos+=n+12; }
  }
  const signal=AbortSignal.any([ctx.signal,AbortSignal.timeout(timeout)]);
  let raw:any;
  try { raw=await bounded(await (options.fetch??fetch)(endpoint,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json'},body:JSON.stringify({input:[{type:'image_url',url:`data:${source.mimeType};base64,${bytes.toString('base64')}`}],merge_levels:['word']})}),signal); } catch { throw new Error('OCR request failed or exceeded bounds'); }
  if(typeof raw?.model!=='string' || !Array.isArray(raw.data) || raw.data.length!==1 || raw.data[0].index!==0 || !Array.isArray(raw.data[0].text_detections) || raw.data[0].text_detections.length>10000) throw new Error('Invalid NIM OCR response');
  const spans:OcrSpan[]=raw.data[0].text_detections.map((d:any,index:number)=> { const text=d?.text_prediction?.text; const span:Omit<OcrSpan,'id'>={text,polygon:d?.bounding_box?.points,uncertainty:typeof text==='string'?ocrUncertainty(text,'not-assessed'):'unresolved'}; if(d?.text_prediction?.confidence!==undefined) span.confidence=d.text_prediction.confidence; return {...span,id:spanId(source.id,source.sha256,index,span)}; });
  record=parseOcrRecord({kind:'spindle.ocr.v1',sourceId:source.id,sourceVersion:source.sha256,sourceWidthPx:width,sourceHeightPx:height,coordinateSpace:'normalized-0-1',producer:{backend:'self-hosted-nim',model:raw.model},spans});
  signal.throwIfAborted(); current(ctx);
  if(!ctx.scope.grants.includes('image.processing') || !options.authorize(ctx,new URL(endpoint))) throw new Error('Image processing not granted');
  } catch(error) {
   if(isEvidenceStoreFault(error))throw error;
   current(ctx);
   const message=error instanceof Error ? error.message : 'OCR unavailable';
   if(message==='Image processing not granted' || message==='Source not permitted') throw error;
   return {callId:ctx.callId,status:'failed',data:{kind:'spindle.ocr.failure.v1',nextAction:'Check the original PNG/JPEG and OCR backend, or continue independent work.'},artifacts:[],evidence:[],observations:['OCR produced no artifact.'],error:{code:'ocr_unavailable',message,producer:'ocr.document'}};
  }
  current(ctx);
  const {sourceId:recordSource,sourceVersion,spans}=record;
  const {artifact}=options.store.put(ns,Buffer.from(JSON.stringify(record)),'application/vnd.spindle.ocr+json',[recordSource]);
  return {callId:ctx.callId,status:'ok',data:record,artifacts:[artifact],evidence:[{id:artifact.id,artifactId:artifact.id,sourceId:recordSource,sourceVersion,spanIds:spans.map(s=>s.id)}],observations:['Exact returned OCR text; no missing digits inferred. Coordinates are backend-reported, not pixel-accuracy acceptance. Confidence is not verification.']};
 }};
}

function regionInput(value:unknown):{ocrArtifactId:string;spanIds:string[]} {
 const v=value as {ocrArtifactId:string;spanIds:string[]};
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='ocrArtifactId,spanIds'||typeof v.ocrArtifactId!=='string'||!v.ocrArtifactId.length||v.ocrArtifactId.length>256||!Array.isArray(v.spanIds)||v.spanIds.length<1||v.spanIds.length>64||new Set(v.spanIds).size!==v.spanIds.length||v.spanIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw Error('Select persisted OCR artifact/span IDs only');
 return v;
}
/** Local private citation preview; no model-supplied coordinates, text, files or remote calls. */
export function createOcrRegionTool(options:{store:EvidenceStore;pythonExecutable?:string}):ToolDefinition {
 return{name:'ocr.render_regions',version:'1',effect:'write_local',capabilities:['image.processing'],
 inputSchema:{jsonSchema:{type:'object',properties:{ocrArtifactId:{type:'string',minLength:1,maxLength:256},spanIds:{type:'array',minItems:1,maxItems:64,uniqueItems:true,items:{type:'string',pattern:'^[a-f0-9]{64}$'}}},required:['ocrArtifactId','spanIds'],additionalProperties:false},parse:regionInput},
 outputSchema:{jsonSchema:{anyOf:[{type:'object',required:['kind','nextAction'],properties:{kind:{const:'spindle.ocr.failure.v1'},nextAction:{type:'string'}}},{type:'object',required:['kind','ocrArtifactId','inputArtifactId','inputHash','outputId','outputHash','coordinateProvenance','regions','preview'],properties:{kind:{const:'spindle.ocr.regions.v1'},ocrArtifactId:{type:'string'},inputArtifactId:{type:'string'},inputHash:{type:'string'},canonicalHash:{type:'string'},outputId:{type:'string'},outputHash:{type:'string'},coordinateProvenance:{enum:['model-estimated','backend-reported']},regions:{type:'array'},preview:{type:'object'}}}]},parse(v:unknown){const r=v as any;if(r?.kind==='spindle.ocr.failure.v1')return ocrOutputSchema.parse(v);if(r?.kind!=='spindle.ocr.regions.v1'||typeof r.outputId!=='string'||typeof r.outputHash!=='string'||!Array.isArray(r.regions)||!['model-estimated','backend-reported'].includes(r.coordinateProvenance))throw Error('Invalid OCR region preview');return v;}},
 async invoke(args,ctx) {
  current(ctx);if(!ctx.scope.grants.includes('image.processing'))throw Error('Image processing not granted');
  const {ocrArtifactId,spanIds}=regionInput(args),ns={workspaceId:ctx.workspaceId,accountId:ctx.accountId};
  let record:OcrRecord,regions:ReturnType<typeof resolveOcr>,png:Buffer,inputArtifactId:string,inputHash:string,canonicalHash:string,preview:unknown;
  const active=()=>{current(ctx);if(!ctx.scope.grants.includes('image.processing'))throw Error('Image processing not granted');};
  let revalidate:()=>void=active;
  try {
   const ocr=resolveInput(options.store,ctx,ocrArtifactId);
   if(ocr.artifact.mimeType!=='application/vnd.spindle.ocr+json')throw Error('Not OCR evidence');
   record=parseOcrRecord(JSON.parse(ocr.bytes.toString('utf8')));
   if(ocr.roots.size!==1||ocr.roots.get(record.sourceId)!==record.sourceVersion)throw Error('Wrong OCR source scope');
   regions=resolveOcr(options.store,ns,ocrArtifactId,record.sourceId,record.sourceVersion,spanIds);
   inputArtifactId=regions[0]!.snapshotArtifactId;
   const input=resolveInput(options.store,ctx,inputArtifactId);inputHash=input.artifact.sha256;
   revalidate=()=>{active();const now=resolveInput(options.store,ctx,inputArtifactId),currentOcr=resolveInput(options.store,ctx,ocrArtifactId);if(now.artifact.sha256!==inputHash||currentOcr.artifact.sha256!==ocr.artifact.sha256||now.roots.size!==1||now.roots.get(record.sourceId)!==record.sourceVersion)throw Error('OCR preview source changed');resolveOcr(options.store,ns,ocrArtifactId,record.sourceId,record.sourceVersion,spanIds);};
   const canonical=await canonicalizeImage(input.bytes,ctx.signal,options.pythonExecutable);revalidate();
   canonicalHash=canonical.canonicalHash;
   if(canonical.originalHash!==inputHash||(record.canonicalHash&&record.canonicalHash!==canonicalHash)||record.sourceWidthPx!==canonical.orientedDimensions[0]||record.sourceHeightPx!==canonical.orientedDimensions[1])throw Error('OCR canonical image changed');
   if(record.imageGeometry)for(const key of ['encodedDimensions','orientedDimensions','canonicalDimensions','orientation','sourceToEncoded','canonicalToSource'] as const)if(JSON.stringify(record.imageGeometry[key])!==JSON.stringify(canonical[key]))throw Error('OCR preview geometry changed');
   const canonicalBytes=Buffer.from(canonical.image,'base64');if(digest(canonicalBytes)!==canonicalHash)throw Error('OCR canonical hash mismatch');
   const selected=spanIds.map(id=>record.spans.find(s=>s.id===id)!);
   const rendered=await renderImageRegions(canonicalBytes,selected.map(s=>({polygon:s.polygon,uncertainty:s.uncertainty})),record.coordinateProvenance!,ctx.signal,options.pythonExecutable);revalidate();
   if(rendered.metadata?.format!=='PNG'||typeof rendered.image!=='string')throw Error('Invalid OCR preview image');
   png=Buffer.from(rendered.image,'base64');if(png.length!==rendered.metadata.bytes||png.length>8*1024*1024)throw Error('Invalid OCR preview bounds');
   preview={...rendered.metadata,imageBounds:rendered.imageBounds,coordinateSystem:'canonical-pixel-edges',canonicalDimensions:canonical.canonicalDimensions,displayOnly:true,pixelAccuracyVerified:false,formSemanticsVerified:false};
  }catch(error){
   if(isEvidenceStoreFault(error))throw error;active();
   return{callId:ctx.callId,status:'failed',data:{kind:'spindle.ocr.failure.v1',nextAction:'Select current permitted persisted OCR/span IDs with unchanged input and decoder geometry. This is local display only; no provider retry.'},artifacts:[],evidence:[],observations:['No OCR preview artifact published.'],error:{code:'ocr_regions_unavailable',message:'OCR regions unavailable or input/geometry changed',producer:'ocr.render_regions'}};
  }
  revalidate();
  const output=options.store.put(ns,png,'image/png',[ocrArtifactId,inputArtifactId]).artifact;
  return{callId:ctx.callId,status:'ok',data:{kind:'spindle.ocr.regions.v1',ocrArtifactId,inputArtifactId,inputHash,canonicalHash,outputId:output.id,outputHash:output.sha256,coordinateProvenance:record.coordinateProvenance,regions,preview},artifacts:[output],evidence:[{id:ocrArtifactId,artifactId:ocrArtifactId,sourceId:record.sourceId,sourceVersion:record.sourceVersion,spanIds}],observations:['Local private overlay on the exact revalidated canonical image. Nebius coordinates are MODEL-ESTIMATED, not ground truth/pixel accuracy. Polygon-derived boxes are not form semantics; uncertainty and original evidence are unchanged.']};
 }};
}
