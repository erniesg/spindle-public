import type {ToolContext} from '../agent/contracts.js';
import {resolveInput} from '../evidence/inputs.js';
import {parseOcrPageGeometry} from '../evidence/ocr.js';
import type {PreparationContext} from './service.js';
type Affine=[number,number,number,number,number,number];
export interface PreparationPageGeometry {
 documentArtifactId:string;documentHash:string;pageIndex:number;renderArtifactId:string;renderHash:string;
 renderPixelDimensions:[number,number];pagePoints:[number,number];rotation:0|90|180|270;cropBox:[number,number,number,number];userUnit:number;
 pdfToPage:Affine;inputToRender:Affine;coordinateSystem:'displayed-crop-top-left-points';
}
const multiply=(a:Affine,b:Affine):Affine=>[a[0]*b[0]+a[1]*b[3],a[0]*b[1]+a[1]*b[4],a[0]*b[2]+a[1]*b[5]+a[2],a[3]*b[0]+a[4]*b[3],a[3]*b[1]+a[4]*b[4],a[3]*b[2]+a[4]*b[5]+a[5]];
/** Normalize actual persisted PDF render/image observations, never model-supplied page geometry.
 * PDF uses [a,b,c,d,e,f]; OCR uses row-major [a,c,e,b,d,f]. No page0 default. */
export function preparationPageGeometry(c:PreparationContext,ctx:ToolContext,inputArtifactId:string):PreparationPageGeometry|undefined {
 const task=c.tasks.get(c.taskId);let visits=0;
 function walk(id:string):{page:PreparationPageGeometry;width:number;height:number}|undefined {
  if(++visits>32)throw Error('PAGE_GEOMETRY_LINEAGE_BOUND');
  const artifact=c.store.artifact(c.namespace,id);
  const observation=[...task.observations].reverse().find(o=>o.status==='ok'&&o.artifacts.some(a=>a.id===id&&a.sha256===artifact.sha256));
  if(!observation)return undefined;
  const d=observation.data as any;if(d.outputId!==id||d.outputHash!==artifact.sha256)return undefined;
  if(d.kind==='spindle.document.v1'&&(d.operation==='render'||d.operation==='export'&&d.parameters?.format==='png')){
   const r=d.metadata?.render,pdf=resolveInput(c.store,ctx,d.inputId).artifact;
   if(!r||r.sourceHash!==pdf.sha256||d.inputHash!==pdf.sha256||r.imageHash!==artifact.sha256||!Number.isInteger(r.pageIndex)||r.pageIndex!==d.parameters?.pageIndex||!Array.isArray(r.pdfToPage)||r.pdfToPage.length!==6||!r.pdfToPage.every(Number.isFinite)||![r.pagePoints?.width,r.pagePoints?.height,r.pixelDimensions?.width,r.pixelDimensions?.height].every(n=>Number.isFinite(n)&&n>0)||![0,90,180,270].includes(r.rotation))throw Error('INVALID_PERSISTED_RENDER_GEOMETRY');
   const png=c.store.read(c.namespace,id,8*1024*1024);if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.readUInt32BE(16)!==r.pixelDimensions.width||png.readUInt32BE(20)!==r.pixelDimensions.height)throw Error('RENDER_GEOMETRY_HASH_DIMENSIONS_MISMATCH');
   const [a,b,cc,d0,e,f]=r.pdfToPage;
   return {width:r.pixelDimensions.width,height:r.pixelDimensions.height,page:{documentArtifactId:pdf.id,documentHash:pdf.sha256,pageIndex:r.pageIndex,renderArtifactId:id,renderHash:artifact.sha256,renderPixelDimensions:[r.pixelDimensions.width,r.pixelDimensions.height],pagePoints:[r.pagePoints.width,r.pagePoints.height],rotation:r.rotation,cropBox:[r.cropBox.x,r.cropBox.y,r.cropBox.width,r.cropBox.height],userUnit:r.userUnit,pdfToPage:[a,cc,e,b,d0,f],inputToRender:[1,0,0,0,1,0],coordinateSystem:'displayed-crop-top-left-points'}};
  }
  if(d.kind==='spindle.image.v1'&&['crop_resize','retouch','remove_background','text_overlay'].includes(d.operation)){
   const input=resolveInput(c.store,ctx,d.inputId).artifact;if(input.sha256!==d.inputHash)return undefined;const parent=walk(input.id);if(!parent)return undefined;
   const width=d.metadata?.width,height=d.metadata?.height;if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)return undefined;
   let transform:Affine=[1,0,0,0,1,0];
   if(d.operation==='crop_resize'){const crop=d.parameters?.crop;if(!Array.isArray(crop)||crop.length!==4||!crop.every(Number.isFinite)||crop[0]<0||crop[1]<0||crop[2]<=crop[0]||crop[3]<=crop[1]||crop[2]>parent.width||crop[3]>parent.height||width!==d.parameters.width||height!==d.parameters.height)return undefined;transform=[(crop[2]-crop[0])/width,0,crop[0],0,(crop[3]-crop[1])/height,crop[1]];}
   else if(width!==parent.width||height!==parent.height)return undefined;
   return {width,height,page:{...parent.page,inputToRender:multiply(parent.page.inputToRender,transform)}};
  }
  return undefined;
 }
 const page=walk(inputArtifactId)?.page;if(page)parseOcrPageGeometry(page);return page;
}
