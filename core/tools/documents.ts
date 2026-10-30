import { spawn } from 'node:child_process';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ToolContext, ToolDefinition } from '../agent/contracts.js';
import { EvidenceStore } from '../evidence/store.js';
import { resolveInput } from '../evidence/inputs.js';
import {renderGeometry} from './document-geometry.js';
const MAX=12*1024*1024;
interface DocumentIssue {code:string;field?:string;nextAction:string}
const issueCodes=new Set(['invalid_page','invalid_placement','placement_bounds','render_mismatch','render_unavailable','input_unavailable','no_editable_fields','no_text_layer','text_too_large','invalid_text_encoding','text_extraction_unavailable','field_overflow','unknown_field','field_type','unsupported_field','unsupported_glyph','unsupported_pdf','unsupported_font','missing_required_field']);
function validIssues(value:unknown):value is DocumentIssue[] {return Array.isArray(value)&&value.length<=256&&value.every(x=>x&&issueCodes.has(x.code)&&typeof x.nextAction==='string'&&x.nextAction.length<=256&&(x.field===undefined||(typeof x.field==='string'&&x.field.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(x.field))));}
class DocumentFailure extends Error {constructor(readonly issues:DocumentIssue[]) {super('Document validation blocked this operation; no output published.');}}
function loadFont(path:string,license:string|undefined) {
 if(!isAbsolute(path)||!license||license.length>256||/[\u0000-\u001f\u007f]/.test(license))throw new DocumentFailure([{code:'unsupported_font',nextAction:'Configure an absolute trusted font path and embedding-license identifier.'}]);
 let fd:number|undefined;
 try {
  fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>4*1024*1024)throw Error();
  const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length) {const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)throw Error();offset+=n;}
  if(readSync(fd,Buffer.alloc(1),0,1,null)!==0)throw Error();
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),embeddingLicense:license};
 } catch {throw new DocumentFailure([{code:'unsupported_font',nextAction:'Configure an available regular licensed font file no larger than 4 MiB.'}]);}
 finally {if(fd!==undefined)closeSync(fd);}
}
function current(ctx:ToolContext) {ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('Stale document operation');if(!ctx.scope.grants.includes('document.processing'))throw Error('Document processing not granted');}
function worker(request:unknown,signal:AbortSignal):Promise<any> {
 return new Promise((resolve,reject)=>{
  const body=Buffer.from(JSON.stringify(request));if(body.length>MAX){reject(new DocumentFailure([{code:'unsupported_pdf',nextAction:'The combined PDF/font request exceeds 12 MiB; use a smaller supported input or rendering font.'}]));return;}
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./document-worker.js',import.meta.url))],{env,stdio:['pipe','pipe','pipe']});
  let size=0,errors=0,stopped=false;const chunks:Buffer[]=[];
  const stop=()=>{stopped=true;child.kill('SIGKILL');};const timer=setTimeout(stop,15000);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>MAX)stop();else chunks.push(b);});child.stderr.on('data',(b:Buffer)=>{errors+=b.length;if(errors>8192)stop();});child.stdin.on('error',()=>{});
  child.on('error',()=>{cleanup();reject(new DocumentFailure([{code:'unsupported_pdf',nextAction:'The local PDF worker is unavailable; retry when the configured runtime is available.'}]));});
  child.on('close',code=>{cleanup();if(code!==0||stopped){reject(new DocumentFailure([{code:'unsupported_pdf',nextAction:'The PDF worker failed or exceeded its resource limits; inspect a bounded supported PDF.'}]));return;}try{const result=JSON.parse(Buffer.concat(chunks).toString());if(!validIssues(result.issues))throw Error();if(result.error){reject(new DocumentFailure(result.issues));return;}resolve(result);}catch{reject(new DocumentFailure([{code:'unsupported_pdf',nextAction:'The PDF worker returned an invalid response; no output was published.'}]));}});child.stdin.end(body);
 });
}
function render(pdf:Buffer,page:number,executable:string,signal:AbortSignal):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(executable,['-cropbox','-singlefile','-scale-to','1600','-png','-f',String(page),'-l',String(page),'-'],{env,stdio:['pipe','pipe','pipe']});
  let size=0,errors=0,stopped=false;const chunks:Buffer[]=[];
  const stop=()=>{stopped=true;child.kill('SIGKILL');};const timer=setTimeout(stop,15000);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>8*1024*1024)stop();else chunks.push(b);});child.stderr.on('data',(b:Buffer)=>{errors+=b.length;if(errors>8192)stop();});child.stdin.on('error',()=>{});
  child.on('error',()=>{cleanup();reject(new DocumentFailure([{code:'render_unavailable',nextAction:'The configured PDF renderer is unavailable; retry when it is installed and executable.'}]));});
  child.on('close',code=>{cleanup();const bytes=Buffer.concat(chunks);if(code!==0||stopped||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))reject(new DocumentFailure([{code:'render_unavailable',nextAction:'The PDF renderer failed or exceeded its bounds; no preview was published.'}]));else resolve(bytes);});child.stdin.end(pdf);
 });
}
// Only this owned process is killed; this is a resource bound, not an OS sandbox.
function extractText(pdf:Buffer,page:number,executable:string,deadlineMs:number,signal:AbortSignal):Promise<string> {
 return new Promise((resolve,reject)=>{
  const failure=(code:string)=>new DocumentFailure([{code,nextAction:code==='no_text_layer'?'No text layer is available on this page. Render this page and use OCR.':code==='text_too_large'?'This page exceeds the text limit; render it and use bounded OCR regions.':'Text extraction unavailable. Render this page and use OCR.'}]);
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(executable,['-f',String(page),'-l',String(page),'-layout','-enc','UTF-8','-','-'],{env,stdio:['pipe','pipe','pipe']});
  let size=0,errors=0,reason='';const chunks:Buffer[]=[];
  const stop=(code:string)=>{if(!reason)reason=code;child.kill('SIGKILL');};
  const abort=()=>stop('text_extraction_unavailable');const timer=setTimeout(abort,deadlineMs);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>65536)stop('text_too_large');else if(!reason)chunks.push(b);});
  child.stderr.on('data',(b:Buffer)=>{errors+=b.length;if(errors>8192)stop('text_extraction_unavailable');});
  child.stdin.on('error',()=>{});
  child.on('error',()=>{reason='text_extraction_unavailable';});
  child.on('close',code=>{
   cleanup();if(reason||code!==0){reject(failure(reason||'text_extraction_unavailable'));return;}
   let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{reject(failure('invalid_text_encoding'));return;}
   if(!text.trim()){reject(failure('no_text_layer'));return;}resolve(text);
  });child.stdin.end(pdf);
 });
}
function parse(v:unknown,operation:string):any {
 const a=v as any;const allowed=operation==='overlay'?['inputId','pageIndex','coordinateSpace','placements']:operation==='render'?['inputId','pageIndex']:operation==='edit'?['inputId','values']:operation==='export'?['inputId','flatten','format','pageIndex']:operation==='extract_text'?['inputId','pageIndex']:['inputId'];
 if(!a || typeof a!=='object'||Array.isArray(a)||typeof a.inputId!=='string'||!a.inputId.length||a.inputId.length>256||Object.keys(a).some(k=>!allowed.includes(k)))throw Error('Invalid document arguments');
 if(['extract_text','render','overlay'].includes(operation)&&(!Number.isInteger(a.pageIndex)||a.pageIndex<0||a.pageIndex>=100))throw Error('Invalid page index');
 if(operation==='overlay') {
  const c=a.coordinateSpace;
  if(!c||typeof c!=='object'||Array.isArray(c)||!['page_points','render_pixels'].includes(c.kind)||Object.keys(c).some(k=>!['kind','imageArtifactId'].includes(k))||(c.kind==='page_points'?c.imageArtifactId!==undefined:typeof c.imageArtifactId!=='string'||!c.imageArtifactId.length||c.imageArtifactId.length>256))throw Error('Invalid coordinate space');
  if(!Array.isArray(a.placements)||a.placements.length<1||a.placements.length>128||a.placements.some((p:any)=>!p||p.type!=='text'||Object.keys(p).some(k=>!['type','box','value','fontSize'].includes(k))||typeof p.value!=='string'||p.value.length>4096||!Number.isFinite(p.fontSize)||p.fontSize<1||p.fontSize>144||!p.box||Object.keys(p.box).length!==4||Object.keys(p.box).some(k=>!['x','y','width','height'].includes(k))||!Object.values(p.box).every(Number.isFinite)))throw Error('Invalid bounded text placements');
 }
 if(operation==='export') {if(a.format!==undefined&&!['pdf','png'].includes(a.format))throw Error('Invalid export format');if(a.format!=='png'&&a.flatten!==true)throw Error('Explicit flatten true required');if(a.pageIndex!==undefined&&(!Number.isInteger(a.pageIndex)||a.pageIndex<0||a.pageIndex>=100||a.format!=='png'))throw Error('Invalid page index');}
 if(operation==='edit'&&(!a.values||typeof a.values!=='object'||Array.isArray(a.values)||Object.keys(a.values).length>256||Object.entries(a.values).some(([k,v])=>k.length>256||!(typeof v==='string'||typeof v==='boolean'||(Array.isArray(v)&&v.every(x=>typeof x==='string'))))))throw Error('Invalid field values');
 if(Buffer.byteLength(JSON.stringify(a))>32768)throw Error('Arguments too large');return a;
}
/** Reusable local PDF operations; no template names or destination writes. */
export function createDocumentTools(store:EvidenceStore,options:{pdftoppmExecutable?:string;pdftotextExecutable?:string;textDeadlineMs?:number;renderFontPath?:string;renderFontLicense?:string}={}):ToolDefinition[] {
 if(options.pdftoppmExecutable!==undefined&&!isAbsolute(options.pdftoppmExecutable))throw Error('Configure an absolute trusted PDF renderer');
 if(options.pdftotextExecutable!==undefined&&!isAbsolute(options.pdftotextExecutable))throw Error('Configure an absolute trusted text extractor');
 const textDeadlineMs=options.textDeadlineMs??15000;if(!Number.isInteger(textDeadlineMs)||textDeadlineMs<1||textDeadlineMs>15000)throw Error('Invalid text deadline');
 return ['inspect','edit','export','extract_text','overlay','render'].map(operation=>({name:`document.${operation}`,version:'1',effect:operation==='inspect'?'read':'write_local',capabilities:['document.processing'],
 inputSchema:{jsonSchema:{type:'object',description:operation==='overlay'?'Create a new PDF with explicit measured text placements, preserving its original. Inspect capabilities first. This performs no semantic field mapping or signature/payment/submission.':operation==='render'?'Render one actual zero-based PDF page to a full-image PNG with parser-derived crop/rotation and actual pixel transform metadata.':operation==='edit'?'Edit discovered AcroForm fields by exact name; flat PDFs instead require explicit document.overlay placements.':'Operate on an opaque scoped current PDF source or derived artifact ID; never a filesystem path or URL.',properties:{inputId:{type:'string',maxLength:256,description:'Use data.artifact.id or data.source.id returned by successful drive.read (not a folder-listing artifact). A provider file ID resolves only AFTER its bytes are admitted to this task; otherwise first drive.read an observed files[].id. Never use the request snapshot or guess IDs.'},...(operation==='overlay'?{pageIndex:{type:'integer',minimum:0,maximum:99},coordinateSpace:{description:'Explicit top-left origin of the displayed visible CropBox AFTER actual source rotation; x right, y down. page_points are physical PDF points (1/72 inch). render_pixels are full-image pixels of the exact document.render PNG for this PDF/page, not a cropped/resized OCR image. Font size always remains physical points. Geometry is derived by the tool, never supplied by the model.',oneOf:[{type:'object',properties:{kind:{const:'page_points'}},required:['kind'],additionalProperties:false},{type:'object',properties:{kind:{const:'render_pixels'},imageArtifactId:{type:'string',maxLength:256}},required:['kind','imageArtifactId'],additionalProperties:false}]},placements:{type:'array',minItems:1,maxItems:128,items:{type:'object',properties:{type:{const:'text'},box:{type:'object',description:'Explicit bounded rectangle in coordinateSpace units. x/y are the top-left (not the text baseline); the entire rectangle must fit the displayed page/image. Text must fit measured font metrics; no shrinking or clipping.',properties:{x:{type:'number',minimum:0},y:{type:'number',minimum:0},width:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0}},required:['x','y','width','height'],additionalProperties:false},value:{type:'string',maxLength:4096},fontSize:{type:'number',description:'Physical PDF points, including when the box uses render_pixels. Choose explicitly; overflow is refused rather than shrunk.',minimum:1,maximum:144}},required:['type','box','value','fontSize'],additionalProperties:false}}}:operation==='render'?{pageIndex:{type:'integer',minimum:0,maximum:99}}:operation==='edit'?{values:{type:'object',additionalProperties:{anyOf:[{type:'string'},{type:'boolean'},{type:'array',items:{type:'string'}}]}}}:operation==='export'?{flatten:{const:true},format:{enum:['pdf','png']},pageIndex:{type:'integer',minimum:0,maximum:99}}:operation==='extract_text'?{pageIndex:{type:'integer',minimum:0,maximum:99}}:{})},required:operation==='overlay'?['inputId','pageIndex','coordinateSpace','placements']:operation==='edit'?['inputId','values']:['extract_text','render'].includes(operation)?['inputId','pageIndex']:['inputId'],additionalProperties:false},parse:v=>parse(v,operation)},
 outputSchema:{jsonSchema:{type:'object',properties:{kind:{const:'spindle.document.v1'},operation:{type:'string'},inputId:{type:'string'},inputHash:{type:'string'},outputId:{type:'string'},outputHash:{type:'string'},metadata:{type:'object'},parameters:{type:'object'},issues:{type:'array',maxItems:256,items:{type:'object',properties:{code:{type:'string',enum:[...issueCodes]},field:{type:'string',maxLength:128},nextAction:{type:'string',maxLength:256}},required:['code','nextAction'],additionalProperties:false}},renderAssets:{type:'array',items:{type:'object',properties:{sha256:{type:'string'},name:{type:'string'},embeddingLicense:{type:'string'}},required:['sha256','name','embeddingLicense']}},nextAction:{type:'string'}},required:['kind','operation','inputId']},parse(v:unknown){const a=v as any;if(a?.kind!=='spindle.document.v1'||typeof a.inputId!=='string'||typeof a.operation!=='string')throw Error('Invalid document result');if(a.issues!==undefined&&!validIssues(a.issues))throw Error('Invalid document issues');return v;}},
 async invoke(value,ctx) {
  current(ctx);const args=parse(value,operation);const inputId=args.inputId;
  let publicationStarted=false;
  try {
   const input=resolveInput(store,ctx,inputId);if(input.artifact.mimeType!=='application/pdf'||input.bytes.length>8*1024*1024)throw Error('Select a bounded PDF');
   const revalidate=()=>{current(ctx);const latest=resolveInput(store,ctx,inputId);if(latest.artifact.sha256!==input.artifact.sha256)throw new DocumentFailure([{code:'input_unavailable',nextAction:'The selected source changed; inspect its current version before retrying.'}]);};
   const png=operation==='render'||operation==='export'&&args.format==='png';
   const font=['edit','overlay'].includes(operation)&&options.renderFontPath!==undefined?loadFont(options.renderFontPath,options.renderFontLicense):undefined;
   let placements=args.placements;
   if(operation==='overlay'&&args.coordinateSpace.kind==='render_pixels') {
    const image=resolveInput(store,ctx,args.coordinateSpace.imageArtifactId);
    if(image.artifact.mimeType!=='image/png')throw new DocumentFailure([{code:'render_mismatch',nextAction:'Use the exact PNG returned by document.render for this input and page.'}]);
    const inspection=await worker({operation:'inspect',pdf:input.bytes.toString('base64')},ctx.signal);current(ctx);
    if(!inspection.metadata.pages[args.pageIndex])throw new DocumentFailure([{code:'invalid_page',nextAction:'Choose an actual page from document.inspect.'}]);
    if(inspection.metadata.editingCapabilities.overlay!=='supported')throw new DocumentFailure([{code:'unsupported_pdf',nextAction:'Preserve signed/signature or credential-bearing originals; choose a safe unsigned source.'}]);
    if(!options.pdftoppmExecutable)throw new DocumentFailure([{code:'render_unavailable',nextAction:'Configure a trusted Poppler renderer before using pixel coordinates.'}]);
    const canonical=await render(input.bytes,args.pageIndex+1,options.pdftoppmExecutable,ctx.signal);current(ctx);
    if(createHash('sha256').update(canonical).digest('hex')!==image.artifact.sha256||!image.artifact.derivedFrom.includes(inputId))throw new DocumentFailure([{code:'render_mismatch',nextAction:'Render this exact current PDF/page and use its returned image artifact.'}]);
    const geometry=renderGeometry(inspection.metadata.pages[args.pageIndex],canonical,input.artifact.sha256);
    placements=args.placements.map((p:any)=>({...p,box:{x:p.box.x/geometry.scale.x,y:p.box.y/geometry.scale.y,width:p.box.width/geometry.scale.x,height:p.box.height/geometry.scale.y}}));
   }
   const result=await worker({operation:png||operation==='extract_text'?'inspect':operation,pdf:input.bytes.toString('base64'),values:args.values,flatten:args.flatten,pageIndex:args.pageIndex,placements,renderFont:font?.bytes.toString('base64')},ctx.signal);current(ctx);
   if(operation==='extract_text') {
    // Signed sources may be read, never rewritten. Credential-bearing forms cannot
    // be sent to Poppler, whose plain-text preview cannot redact password values.
    if(result.metadata.fields.some((field:any)=>field.password===true))throw new DocumentFailure([{code:'unsupported_pdf',nextAction:'Credential text preview is unsupported; preserve the original. No extractor started.'}]);
    if(args.pageIndex>=result.metadata.pages.length)throw new DocumentFailure([{code:'invalid_page',nextAction:'Choose an actual page from document.inspect.'}]);
    if(!options.pdftotextExecutable)throw new DocumentFailure([{code:'text_extraction_unavailable',nextAction:'Configure a trusted Poppler pdftotext executable, or render the page and use OCR.'}]);
    const text=await extractText(input.bytes,args.pageIndex+1,options.pdftotextExecutable,textDeadlineMs,ctx.signal);current(ctx);
    revalidate();publicationStarted=true;const artifact=store.put(input.namespace,Buffer.from(text,'utf8'),'text/plain',[inputId]).artifact;current(ctx);
    return {callId:ctx.callId,status:'ok',data:{kind:'spindle.document.v1',operation,inputId,inputHash:input.artifact.sha256,outputId:artifact.id,outputHash:artifact.sha256,parameters:{pageIndex:args.pageIndex},metadata:{text,pageIndex:args.pageIndex,pageCount:result.metadata.pages.length,outputLimitBytes:65536,textLayerCoverage:'unverified',semanticVerification:false},issues:[]},artifacts:[artifact],evidence:[...input.roots].map(([sourceId,sourceVersion])=>({id:`${artifact.id}:${sourceId}`,artifactId:artifact.id,sourceId,sourceVersion})),observations:['Poppler returned the selected page text layer without stdout truncation; engine coverage and semantic accuracy are unverified. Not OCR. Source bytes are unchanged; pageIndex is zero-based. Other pages were not read.']};
   }
   let rendered:Buffer|undefined;
   if(png) {if(result.metadata.fields.some((field:any)=>field.password===true))throw new DocumentFailure([{code:'unsupported_pdf',nextAction:'Credential preview is unsupported; preserve the original. No renderer started.'}]);if(!options.pdftoppmExecutable)throw new DocumentFailure([{code:'render_unavailable',nextAction:'Configure a trusted Poppler PDF renderer.'}]);if((args.pageIndex??0)>=result.metadata.pages.length)throw new DocumentFailure([{code:'invalid_page',nextAction:'Choose an actual page from document.inspect.'}]);rendered=await render(input.bytes,(args.pageIndex??0)+1,options.pdftoppmExecutable,ctx.signal);current(ctx);
    result.metadata.render={...renderGeometry(result.metadata.pages[args.pageIndex??0],rendered,input.artifact.sha256),imageHash:createHash('sha256').update(rendered).digest('hex')};
   }
   const data:Record<string,unknown>={kind:'spindle.document.v1',operation,inputId,inputHash:input.artifact.sha256,parameters:operation==='overlay'?{pageIndex:args.pageIndex,coordinateSpace:args.coordinateSpace,placements:args.placements,resolvedPagePlacements:placements}:operation==='render'?{pageIndex:args.pageIndex}:operation==='edit'?{values:args.values}:operation==='export'?{format:args.format??'pdf',...(png?{pageIndex:args.pageIndex??0}:{flatten:true})}:{},metadata:result.metadata,issues:result.issues,...(font?{renderAssets:[{sha256:font.sha256,name:result.renderFontName,embeddingLicense:font.embeddingLicense}]}:{})};
   const artifacts=[];
   if(rendered) {revalidate();publicationStarted=true;const output=store.put(input.namespace,rendered,'image/png',[inputId]).artifact;artifacts.push(output);data.outputId=output.id;data.outputHash=output.sha256;}
   if(result.pdf!==undefined) {
    if(typeof result.pdf!=='string'||result.pdf.length>MAX)throw Error('Invalid PDF output');const bytes=Buffer.from(result.pdf,'base64');if(bytes.length>8*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF bytes');current(ctx);
    revalidate();publicationStarted=true;const output=store.put(input.namespace,bytes,'application/pdf',[inputId]).artifact;artifacts.push(output);data.outputId=output.id;data.outputHash=output.sha256;
   }
   current(ctx);return {callId:ctx.callId,status:'ok',data,artifacts,evidence:artifacts.flatMap(a=>[...input.roots].map(([sourceId,sourceVersion])=>({id:`${a.id}:${sourceId}`,artifactId:a.id,sourceId,sourceVersion}))),observations:['Actual PDF fields and versioned bytes; full operation provenance is retained in this observation. Appearance still requires inspection; glyph coverage is checked for edited values, not universal PDF or Windows acceptance.']};
  } catch(error) {
   // Publication/storage errors (including errors after commit) are uncertain writes,
   // not expected PDF validation failures. Preserve the original exception even if
   // cancellation/currentness concurrently changed; Runtime owns reconciliation.
   if(publicationStarted||(error as NodeJS.ErrnoException)?.code?.startsWith('ERR_SQLITE'))throw error;
   current(ctx);return {callId:ctx.callId,status:'failed',data:{kind:'spindle.document.v1',operation,inputId,issues:error instanceof DocumentFailure?error.issues:[{code:'input_unavailable',nextAction:'Inspect a current permitted PDF and retry the supported operation; no output was published.'}],nextAction:error instanceof DocumentFailure?(error.issues[0]?.nextAction??'Inspect the document before retrying.'):'Inspect a permitted current PDF and its capabilities; continue independent work.'},artifacts:[],evidence:[],observations:['No document operation accepted; input values omitted from failure metadata.'],error:{code:'document_operation_failed',message:error instanceof DocumentFailure?(error.issues[0]?.nextAction??'Document validation blocked; no output published.'):'Document operation unavailable or validation blocked; no output published.',producer:`document.${operation}`}};
  }
 }}));
}
