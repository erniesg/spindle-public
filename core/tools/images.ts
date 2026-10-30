import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ToolContext, ToolDefinition } from '../agent/contracts.js';
import { EvidenceStore } from '../evidence/store.js';
import { resolveInput,isEvidenceStoreFault } from '../evidence/inputs.js';
import { inspectSemantic, type ImageVisionOptions } from './image-vision.js';
const MAX=32*1024*1024; // base64 JSON of camera-size originals (e.g. 11.5MB JPEG ≈ 15.4MB) and bounded outputs
const helper=fileURLToPath(new URL('../../tools/image-worker/worker.py',import.meta.url));
function current(ctx:ToolContext) { ctx.signal.throwIfAborted(); if(!ctx.isCurrent()) throw new Error('Stale image operation'); if(!ctx.scope.grants.includes('image.processing')) throw new Error('Image processing not granted'); }
function worker(request:unknown, signal:AbortSignal, pythonExecutable:string, modelPath?:string):Promise<any> {
 return new Promise((resolve,reject)=> {
  const body=Buffer.from(JSON.stringify(request)); if(body.length>MAX) {reject(new Error('Image input too large'));return;}
  // Fixed executable/helper, no inherited provider credentials, no model-selected paths.
  const env:NodeJS.ProcessEnv={};
  for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG']) if(process.env[key]) env[key]=process.env[key];
  const child=spawn(pythonExecutable,['-E',helper,...(modelPath ? [modelPath] : [])],{env,stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[]; let size=0, errSize=0; let stopped=false;
  const stop=()=>{stopped=true;child.kill('SIGKILL');};
  const timer=setTimeout(stop,request&&typeof request==='object'&&(request as {operation?:string}).operation==='remove_background'?180000:180000); // BiRefNet-lite on 4 ARM cores ~20-40s with load; others ~2-17s signal.addEventListener('abort',stop,{once:true}); if(signal.aborted) stop();
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>MAX)stop();else chunks.push(b);});
  child.stderr.on('data',(b:Buffer)=>{errSize+=b.length;if(errSize>8192)stop();});
  child.stdin.on('error',()=>{}); child.on('error',()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(new Error('Image worker unavailable'));});
  child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',stop);if(code!==0 || stopped) {
   if(!stopped)try {
    const failure=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(['HEIF_DECODER_UNAVAILABLE','HEIF_DECODER_VERSION'].includes(failure.error)) {reject(Object.assign(new Error('HEIF decoder unavailable: configure trusted Python with pinned pillow-heif==1.8.1'),{code:failure.error}));return;}
    // Only the worker's fixed parameter-validation messages are surfaced, never decoder/library text.
    if(failure.error==='IMAGE_PARAMETERS_INVALID'&&typeof failure.detail==='string'&&failure.detail.length<=300&&/^[\x20-\x7e]+$/.test(failure.detail)) {reject(Object.assign(new Error('Invalid image parameters: '+failure.detail),{code:failure.error}));return;}
   }catch { /* Never expose worker stderr or arbitrary decoder text. */ }
   reject(new Error('Image worker failed, cancelled or exceeded bounds'));return;
  }try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch {reject(new Error('Invalid image response'));}});
  child.stdin.end(body);
 });
}
/** Reuse the same credential-free bounded decoder for separately admitted image consumers. */
/** Optional region: crop box in oriented pixels plus counter-clockwise rotation degrees (zoomed OCR). */
export function canonicalizeImage(bytes:Buffer,signal:AbortSignal,pythonExecutable=process.platform==='win32'?'python.exe':'python3',region?:{box?:number[];rotation?:number|'auto'|{auto:true;offset:number}}) {
 return worker({operation:'canonicalize',parameters:region??{},image:bytes.toString('base64')},signal,pythonExecutable);
}
/** Internal: deterministic form rules/box rows/underlines on a rendered page PNG (pixels). */
export function detectFormLines(png:Buffer,signal:AbortSignal,pythonExecutable=process.platform==='win32'?'python.exe':'python3'):Promise<{width:number;height:number;underlines:number[][];cellRows:number[][][]}> {
 return worker({operation:'form_lines',parameters:{},image:png.toString('base64')},signal,pythonExecutable);
}
/** Internal persisted-region consumer; public OCR tool admits IDs, never model geometry. */
export function renderImageRegions(bytes:Buffer,regions:{polygon:{x:number;y:number}[];uncertainty:string}[],coordinateProvenance:'model-estimated'|'backend-reported',signal:AbortSignal,pythonExecutable=process.platform==='win32'?'python.exe':'python3') {
 return worker({operation:'render_regions',parameters:{regions,coordinateProvenance},image:bytes.toString('base64')},signal,pythonExecutable);
}
const integer={type:'integer',minimum:0,maximum:16384};
const box={type:'array',items:integer,minItems:4,maxItems:4,description:'Pixel box [left,top,right,bottom] of this input image (right>left, bottom>top); not [x,y,width,height].'};
const properties:Record<string,Record<string,unknown>>={
 inspect:{focus:{type:'string',minLength:1,maxLength:256,description:'Optional: what regions to propose, e.g. head-and-shoulders crop box; cheek blemish retouch box.'}},remove_background:{},retouch:{mask:{...box,description:'Approximate box around the blemish (pixels of this image). Inpaint searches a little around it and only replaces blemish-like pixels.'},fill:{enum:['spot','box'],description:'Optional: spot (default) replaces only detected marks; box deliberately fills the whole box.'},cloneFrom:{type:'array',items:integer,minItems:2,maxItems:2,description:'Optional [left,top] of a clean same-size patch outside the mask; omit to inpaint the mask from its surroundings (best for small blemishes).'}},
 text_overlay:{text:{type:'string',minLength:1,maxLength:128,pattern:'^[\\x20-\\x7e]+$',description:'Literal printable ASCII, rendered with the bundled Pillow font; no paths or executable text.'},x:integer,y:integer,fontSize:{type:'integer',minimum:4,maximum:256},colorRGB:{type:'array',items:{type:'integer',minimum:0,maximum:255},minItems:3,maxItems:3},opacity:{type:'integer',minimum:1,maximum:255},strokeRGB:{type:'array',items:{type:'integer',minimum:0,maximum:255},minItems:3,maxItems:3},strokeWidth:{type:'integer',minimum:0,maximum:16}},
 crop_resize:{format:{enum:['JPEG','PNG']},crop:box,width:{type:'integer',minimum:1,maximum:4096},height:{type:'integer',minimum:1,maximum:4096},backgroundRGB:{type:'array',items:{type:'integer',minimum:0,maximum:255},minItems:3,maxItems:3},maxBytes:{type:'integer',minimum:1,maximum:8388608},quality:{type:'integer',minimum:1,maximum:95}},
 fit_photo:{faceBox:{...box,description:'Face box [left,top,right,bottom] in pixels of THIS input image (e.g. image.inspect sourceBox scaled to this image), forehead to chin.'},width:{type:'integer',minimum:64,maximum:4096,description:'Exact output width in pixels (e.g. 400).'},height:{type:'integer',minimum:64,maximum:4096,description:'Exact output height in pixels (e.g. 514).'},headHeight:{type:'integer',minimum:30,maximum:90,description:'Optional: head height (top of hair to chin) as percent of output height; default 70.'},topMargin:{type:'integer',minimum:0,maximum:40,description:'Optional: space above the hair as percent of output height; default 10.'},backgroundRGB:{type:'array',items:{type:'integer',minimum:0,maximum:255},minItems:3,maxItems:3},format:{enum:['JPEG','PNG']},maxBytes:{type:'integer',minimum:1,maximum:8388608},quality:{type:'integer',minimum:1,maximum:95}},
 verify:{width:{type:'integer',minimum:1,maximum:16384},height:{type:'integer',minimum:1,maximum:16384},format:{enum:['PNG','JPEG']},mode:{enum:['RGB','RGBA','L','P','CMYK']},maxBytes:{type:'integer',minimum:1,maximum:8388608}}
};
// Per-operation optional parameters; every other declared parameter is required.
const optional:Record<string,string[]>={inspect:['focus'],retouch:['cloneFrom','fill'],fit_photo:['headHeight','topMargin','backgroundRGB','maxBytes','quality']};
function parseArgs(value:unknown,operation:string):{inputId:string;parameters:Record<string,unknown>} {
 const v=value as any;
 if(!v || typeof v.inputId!=='string' || !v.inputId.length || v.inputId.length>256 || Object.keys(v).some(k=>!['inputId','parameters'].includes(k)) || !v.parameters || typeof v.parameters!=='object' || Array.isArray(v.parameters)) throw new Error('Expected inputId and operation parameters');
 const allowed=Object.keys(properties[operation]!);
 if(Object.keys(v.parameters).some(k=>!allowed.includes(k)) || (operation!=='verify' && allowed.some(k=>k!=='format' && !(optional[operation]??[]).includes(k) && !(k in v.parameters)))) throw new Error('Invalid image parameters');
 if(operation==='verify' && !Object.keys(v.parameters).length) throw new Error('Verification requires constraints');
 function validate(value:unknown,s:any):boolean {
  if(s.enum) return s.enum.includes(value);
  if(s.type==='string') return typeof value==='string'&&value.length>=s.minLength&&value.length<=s.maxLength&&/^[\x20-\x7e]+$/.test(value);
  if(s.type==='integer') return Number.isInteger(value) && (value as number)>=s.minimum && (value as number)<=s.maximum;
  if(s.type==='array') return Array.isArray(value) && value.length>=s.minItems && value.length<=s.maxItems && value.every(x=>validate(x,s.items));
  return false;
 }
 const expect=(s:any):string=>s.enum?`one of ${s.enum.join('|')}`:s.type==='array'?`${s.minItems===s.maxItems?s.minItems:`${s.minItems}-${s.maxItems}`} items of ${expect(s.items)}${s.description?` (${s.description})`:''}`:s.type==='integer'?`integer in [${s.minimum},${s.maximum}]`:s.type==='string'?`printable text of ${s.minLength}-${s.maxLength} characters`:'a valid value';
 // Models often emit pixel coordinates with decimals (e.g. a box scaled from inspect); round them rather than spend a turn on a retry.
 const round=(value:unknown,s:any):unknown=>s?.type==='integer'&&typeof value==='number'&&Number.isFinite(value)?Math.round(value):s?.type==='array'&&Array.isArray(value)?value.map(x=>round(x,s.items)):value;
 const parameters=Object.fromEntries(Object.entries(v.parameters).map(([key,value])=>[key,round(value,properties[operation]![key])]));
 for(const [key,value] of Object.entries(parameters)) if(!validate(value,properties[operation]![key])) throw new Error(`Invalid parameter ${key}: expected ${expect(properties[operation]![key])}`);
 if(JSON.stringify(parameters).length>4096) throw new Error('Parameters too large');
 return {inputId:v.inputId,parameters};
}
/** Actual local pixel tools with optional separately admitted semantic enrichment. */
export function createImageTools(store:EvidenceStore, options:{pythonExecutable?:string;modelPath?:string;vision?:ImageVisionOptions}={}):ToolDefinition[] {
 const pythonExecutable=options.pythonExecutable ?? (process.platform==='win32'?'python.exe':'python3');
 return Object.keys(properties).map(operation=>({name:`image.${operation}`,version:'1',effect:operation==='inspect'||operation==='verify'?'read':'write_local',capabilities:['image.processing'],
 inputSchema:{jsonSchema:{type:'object',properties:{inputId:{type:'string',minLength:1,maxLength:256,description:'Local artifact.id/source.id from a successful scoped source read. A provider file ID resolves only after its actual bytes are admitted to this task. Do not use the user request artifact or a folder listing.'},parameters:{type:'object',minProperties:operation==='verify'?1:0,properties:properties[operation],required:operation==='verify'?[]:Object.keys(properties[operation]!).filter(k=>k!=='format'),additionalProperties:false}},required:['inputId','parameters'],additionalProperties:false},parse:v=>parseArgs(v,operation)},
 outputSchema:{jsonSchema:{type:'object',properties:{kind:{const:'spindle.image.v1'},operation:{type:'string'},inputId:{type:'string'},inputHash:{type:'string'},outputId:{type:'string'},outputHash:{type:'string'},metadata:{type:'object'},checks:{type:'object'},passed:{type:'boolean'},semanticVision:{type:'boolean'},semantic:{type:'object'},backgroundVerified:{type:'boolean'},visualQualityVerified:{type:'boolean'},nextAction:{type:'string'},parameters:{type:'object'},textOverlay:{type:'object'}},required:['kind','operation','inputId']},parse(v:unknown){const d=v as any;if(d?.kind!=='spindle.image.v1'||typeof d.inputId!=='string'||typeof d.operation!=='string')throw new Error('Invalid image result');return v;}},
 async invoke(args,ctx) {
  current(ctx); const {inputId,parameters}=parseArgs(args,operation);
  let publishing=false;
  try {
   if(operation==='remove_background' && !options.modelPath) return {callId:ctx.callId,status:'needs_input',data:{kind:'spindle.image.v1',operation,inputId,nextAction:'Configure the trusted local pinned MODNet model and Python environment.'},artifacts:[],evidence:[],observations:['No local matting model configured; no fallback or download attempted.']};
   const input=resolveInput(store,ctx,inputId);
   if(!['image/png','image/jpeg','image/heif','image/heic'].includes(input.artifact.mimeType)) throw new Error('Select a supported image');
   const revalidate=()=>{current(ctx);const now=resolveInput(store,ctx,inputId);if(now.artifact.id!==input.artifact.id||now.artifact.sha256!==input.artifact.sha256||JSON.stringify([...now.roots])!==JSON.stringify([...input.roots]))throw new Error('Image input changed');};
   const result=await worker({operation,parameters,image:input.bytes.toString('base64')},ctx.signal,pythonExecutable,operation==='remove_background'?options.modelPath:undefined);
   revalidate();
   const {image,...details}=result;
   if(operation==='inspect') {
    details.semantic=await inspectSemantic(store,ctx,inputId,options.vision,(bytes,signal)=>canonicalizeImage(bytes,signal,pythonExecutable),(parameters as {focus?:string}).focus);
    details.semanticVision=details.semantic.status==='ok';
    revalidate();
   }
   const data:Record<string,unknown>={kind:'spindle.image.v1',operation,inputId,inputHash:input.artifact.sha256,parameters,...details};
   const artifacts=[];
   if(image!==undefined) {
    if(typeof image!=='string' || image.length>MAX || !['PNG','JPEG'].includes(result.metadata?.format)) throw new Error('Invalid encoded output');
    const bytes=Buffer.from(image,'base64'); if(bytes.length!==result.metadata.bytes || bytes.length>8*1024*1024) throw new Error('Output size mismatch');
    current(ctx);
    publishing=true;
    const output=store.put(input.namespace,bytes,result.metadata.format==='PNG'?'image/png':'image/jpeg',[inputId]).artifact;
    artifacts.push(output);
    // One publication only. Runtime persists provenance with this observation,
    // avoiding a separately committed sidecar that could hide a successful image.
    data.outputId=output.id; data.outputHash=output.sha256;
   }
   return {callId:ctx.callId,status:'ok',data,artifacts,evidence:artifacts.flatMap(a=>[...input.roots].map(([sourceId,sourceVersion])=>({id:`${a.id}:${sourceId}`,artifactId:a.id,sourceId,sourceVersion}))),observations:[details.semanticVision?'Actual decoded metadata plus admitted semantic edit proposals; not OCR, identity verification, authority or photo-quality acceptance.':operation==='inspect'?'Actual decoded pixel metadata; semantic enrichment unavailable or failed. No full-background or face-quality acceptance.':'Actual decoded pixel metadata; no semantic vision, full-background or face-quality acceptance.']};
  } catch(error) {
   if(publishing||isEvidenceStoreFault(error)) throw error;
   current(ctx);
   // Publication faults are re-thrown above, so this failure committed nothing.
   return {effect:'none',callId:ctx.callId,status:'failed',data:{kind:'spindle.image.v1',operation,inputId,nextAction:'Select a permitted supported image and valid bounded parameters, or continue independent work.'},artifacts:[],evidence:[],observations:['No image operation accepted.'],error:{code:'image_operation_failed',message:error instanceof Error?error.message:'Image unavailable',producer:`image.${operation}`}};
  }
 }}));
}
