import {parseOcrRecord} from '../evidence/ocr.js';
export interface OcrFailure {
 kind:'spindle.ocr.failure.v1'; nextAction:string;
 stage?:string; reason?:string; invocation?:'not_invoked'|'invoked_without_completion'|'completed';
 reservation?:'not_reserved'|'unknown'|'settled'|'retained';
}
const dimensions={type:'array',items:{type:'integer',minimum:1,maximum:16384},minItems:2,maxItems:2};
const affine={type:'array',items:{type:'number'},minItems:6,maxItems:6};
/** Shared legacy/Nebius output. Explicit factories, never a model-selected backend. */
export const ocrOutputSchema={jsonSchema:{anyOf:[
 {type:'object',required:['kind','nextAction'],properties:{kind:{const:'spindle.ocr.failure.v1'},nextAction:{type:'string',minLength:1},stage:{type:'string'},reason:{type:'string'},invocation:{enum:['not_invoked','invoked_without_completion','completed']},reservation:{enum:['not_reserved','unknown','settled','retained']}},additionalProperties:false},
 {type:'object',required:['kind','sourceId','sourceVersion','sourceWidthPx','sourceHeightPx','coordinateSpace','producer','spans'],properties:{
  kind:{const:'spindle.ocr.v1'},sourceId:{type:'string'},sourceVersion:{type:'string'},sourceWidthPx:{type:'integer',minimum:1,maximum:16384},sourceHeightPx:{type:'integer',minimum:1,maximum:16384},coordinateSpace:{const:'normalized-0-1'},
  producer:{type:'object',properties:{backend:{enum:['self-hosted-nim','nebius']},model:{type:'string'}},required:['backend','model'],additionalProperties:false},
  coordinateProvenance:{enum:['model-estimated','backend-reported']},
  page:{type:'object',required:['documentArtifactId','documentHash','pageIndex','renderArtifactId','renderHash','renderPixelDimensions','pagePoints','rotation','cropBox','userUnit','pdfToPage','inputToRender','coordinateSystem'],properties:{documentArtifactId:{type:'string'},documentHash:{type:'string',pattern:'^[a-f0-9]{64}$'},pageIndex:{type:'integer',minimum:0,maximum:99},renderArtifactId:{type:'string'},renderHash:{type:'string',pattern:'^[a-f0-9]{64}$'},renderPixelDimensions:dimensions,pagePoints:{type:'array',items:{type:'number',exclusiveMinimum:0},minItems:2,maxItems:2},rotation:{enum:[0,90,180,270]},cropBox:{type:'array',items:{type:'number'},minItems:4,maxItems:4},userUnit:{type:'number',exclusiveMinimum:0},pdfToPage:affine,inputToRender:affine,coordinateSystem:{const:'displayed-crop-top-left-points'}},additionalProperties:false},
  inputArtifactId:{type:'string',minLength:1,maxLength:256},inputHash:{type:'string',pattern:'^[a-f0-9]{64}$'},canonicalHash:{type:'string',pattern:'^[a-f0-9]{64}$'},
  imageGeometry:{type:'object',required:['encodedDimensions','orientedDimensions','canonicalDimensions','orientation','canonicalToSource','sourceToEncoded','geometryBasis'],properties:{encodedDimensions:dimensions,orientedDimensions:dimensions,canonicalDimensions:dimensions,orientation:{type:'integer',minimum:1,maximum:8},originalOrientation:{type:'integer',minimum:1,maximum:8},canonicalToSource:affine,sourceToEncoded:affine,geometryBasis:{enum:['encoded-pixel-edges','libheif-display-raster-edges']}},additionalProperties:false},
  coverage:{type:'object',required:['status','maximumSpans'],properties:{status:{const:'partial'},maximumSpans:{type:'integer',minimum:1,maximum:16}},additionalProperties:false},
  spans:{type:'array',maxItems:10000,items:{type:'object',required:['id','text','uncertainty','polygon'],properties:{id:{type:'string'},text:{type:'string'},confidence:{type:'number',minimum:0,maximum:1},bbox:{type:'object',required:['x','y','width','height'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},width:{type:'number',exclusiveMinimum:0,maximum:1},height:{type:'number',exclusiveMinimum:0,maximum:1}},additionalProperties:false},uncertainty:{enum:['unresolved','not-assessed']},polygon:{type:'array',minItems:3,maxItems:16,items:{type:'object',required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}},additionalProperties:false}}}}}
 }}]},parse(value:unknown){
 const failure=value as OcrFailure;
 if(failure?.kind==='spindle.ocr.failure.v1') {
  if(typeof failure.nextAction!=='string'||!failure.nextAction.length||Object.keys(failure).some(k=>!['kind','nextAction','stage','reason','invocation','reservation'].includes(k))||[failure.stage,failure.reason].some(v=>v!==undefined&&typeof v!=='string')||failure.invocation!==undefined&&!['not_invoked','invoked_without_completion','completed'].includes(failure.invocation)||failure.reservation!==undefined&&!['not_reserved','unknown','settled','retained'].includes(failure.reservation))throw Error('Invalid OCR failure');
  return failure;
 }
 return parseOcrRecord(value);
}};
