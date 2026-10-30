import { digest, type EvidenceStore, type Namespace } from './store.js';
import { resolveInput } from './inputs.js';
export interface OcrPoint {x:number;y:number}
export interface OcrBox {x:number;y:number;width:number;height:number}
export interface OcrSpan { id:string; text:string; confidence?:number; uncertainty:'unresolved'|'not-assessed'; polygon:OcrPoint[]; bbox?:OcrBox }
/** Trusted actual document.render + image-operation provenance, never model arguments. */
export interface OcrPageGeometry {
 documentArtifactId:string; documentHash:string; pageIndex:number;
 renderArtifactId:string; renderHash:string; renderPixelDimensions:number[];
 pagePoints:number[]; rotation:number; cropBox:number[]; userUnit:number;
 pdfToPage:number[]; inputToRender:number[];
 coordinateSystem:'displayed-crop-top-left-points';
}
export const ocrBoundingBox=(polygon:OcrPoint[]):OcrBox=>{
 const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
 return{x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
};
export const mapOcrPolygon=(polygon:OcrPoint[],m:number[]):OcrPoint[]=>polygon.map(({x,y})=>({x:m[0]!*x+m[1]!*y+m[2]!,y:m[3]!*x+m[4]!*y+m[5]!}));
/** Literal transcription is immutable; x in ordinary words is not redaction. */
export function ocrUncertainty(text:string,returned:OcrSpan['uncertainty']):OcrSpan['uncertainty'] {
 return returned==='unresolved'||!text.trim()||/[*•●?…]|\d[xX]+(?:\d|\b)|(?:^|\s)[xX]+\d|(?:^|\s)[xX]{2,}(?:\s|$)/u.test(text)?'unresolved':'not-assessed';
}
const affine=(v:number[])=>Array.isArray(v)&&v.length===6&&v.every(Number.isFinite)&&Math.abs(v[0]!*v[4]!-v[1]!*v[3]!)>1e-12;
const close=(a:number,b:number)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
export function parseOcrPageGeometry(value:unknown):OcrPageGeometry {
 const p=value as OcrPageGeometry;
 if(!p||Object.keys(p).sort().join(',')!=='coordinateSystem,cropBox,documentArtifactId,documentHash,inputToRender,pageIndex,pagePoints,pdfToPage,renderArtifactId,renderHash,renderPixelDimensions,rotation,userUnit'||![p.documentArtifactId,p.renderArtifactId].every(id=>typeof id==='string'&&id.length>0&&id.length<=256)||!sha(p.documentHash)||!sha(p.renderHash)||!Number.isInteger(p.pageIndex)||p.pageIndex<0||p.pageIndex>=100||!Array.isArray(p.renderPixelDimensions)||p.renderPixelDimensions.length!==2||p.renderPixelDimensions.some(n=>!Number.isInteger(n)||n<1||n>16384)||!Array.isArray(p.pagePoints)||p.pagePoints.length!==2||p.pagePoints.some(n=>!Number.isFinite(n)||n<=0)||!Array.isArray(p.cropBox)||p.cropBox.length!==4||p.cropBox.some(n=>!Number.isFinite(n))||p.cropBox[2]!<=0||p.cropBox[3]!<=0||!Number.isFinite(p.userUnit)||p.userUnit<=0||![0,90,180,270].includes(p.rotation)||!affine(p.pdfToPage)||!affine(p.inputToRender)||p.coordinateSystem!=='displayed-crop-top-left-points')throw Error('Invalid OCR page geometry');
 const [x,y,w,h]=p.cropBox as [number,number,number,number],u=p.userUnit;
 const transforms:Record<number,number[]>={0:[u,0,-x*u,0,-u,(y+h)*u],90:[0,u,-y*u,u,0,-x*u],180:[-u,0,(x+w)*u,0,u,-y*u],270:[0,-u,(y+h)*u,-u,0,(x+w)*u]};
 const dims=p.rotation===90||p.rotation===270?[h*u,w*u]:[w*u,h*u];
 if(!p.pdfToPage.every((n,i)=>close(n,transforms[p.rotation]![i]!))||!p.pagePoints.every((n,i)=>close(n,dims[i]!)))throw Error('OCR page transform does not match crop/rotation');
 return structuredClone(p);
}
export interface OcrImageGeometry {
 encodedDimensions:number[]; orientedDimensions:number[]; canonicalDimensions:number[];
 orientation:number; originalOrientation?:number; canonicalToSource:number[]; sourceToEncoded:number[];
 geometryBasis:'encoded-pixel-edges'|'libheif-display-raster-edges';
}
export interface OcrRecord {
 kind:'spindle.ocr.v1'; sourceId:string; sourceVersion:string; sourceWidthPx:number; sourceHeightPx:number;
 coordinateSpace:'normalized-0-1'; producer:{backend:'self-hosted-nim'|'nebius';model:string};
 inputArtifactId?:string; inputHash?:string; canonicalHash?:string; imageGeometry?:OcrImageGeometry;
 coverage?:{status:'partial';maximumSpans:number}; coordinateProvenance?:'model-estimated'|'backend-reported'; page?:OcrPageGeometry; spans:OcrSpan[];
}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function geometry(g:OcrImageGeometry,r:OcrRecord) {
 if(!g||![g.encodedDimensions,g.orientedDimensions,g.canonicalDimensions].every(d=>Array.isArray(d)&&d.length===2&&d.every(n=>Number.isInteger(n)&&n>0&&n<=16384))||!Number.isInteger(g.orientation)||g.orientation<1||g.orientation>8||!['encoded-pixel-edges','libheif-display-raster-edges'].includes(g.geometryBasis)) throw Error('Invalid OCR geometry');
 const [w,h]=g.encodedDimensions;
 const transforms:Record<number,number[]>={1:[1,0,0,0,1,0],2:[-1,0,w!,0,1,0],3:[-1,0,w!,0,-1,h!],4:[1,0,0,0,-1,h!],5:[0,1,0,1,0,0],6:[0,1,0,-1,0,h!],7:[0,-1,w!,-1,0,h!],8:[0,-1,w!,1,0,0]};
 const expected=g.orientation>=5?[h,w]:[w,h];
 if(g.originalOrientation!==undefined&&(!Number.isInteger(g.originalOrientation)||g.originalOrientation<1||g.originalOrientation>8))throw Error('Invalid original OCR orientation');
 if(JSON.stringify(g.orientedDimensions)!==JSON.stringify(expected)||r.sourceWidthPx!==expected[0]||r.sourceHeightPx!==expected[1]||JSON.stringify(g.sourceToEncoded)!==JSON.stringify(transforms[g.orientation])||JSON.stringify(g.canonicalToSource)!==JSON.stringify([r.sourceWidthPx/g.canonicalDimensions[0]!,0,0,0,r.sourceHeightPx/g.canonicalDimensions[1]!,0])) throw Error('Invalid OCR transform');
}
export function parseOcrRecord(value:unknown):OcrRecord {
 const r=value as OcrRecord;
 if(!r||r.kind!=='spindle.ocr.v1'||typeof r.sourceId!=='string'||!r.sourceId.length||!sha(r.sourceVersion)||r.coordinateSpace!=='normalized-0-1'||!Number.isInteger(r.sourceWidthPx)||!Number.isInteger(r.sourceHeightPx)||r.sourceWidthPx<1||r.sourceHeightPx<1||r.sourceWidthPx>16384||r.sourceHeightPx>16384||!['self-hosted-nim','nebius'].includes(r.producer?.backend)||typeof r.producer.model!=='string'||!r.producer.model.length||r.producer.model.length>256||!Array.isArray(r.spans)||r.spans.length>10000) throw Error('Invalid OCR record');
 const binding=r.inputArtifactId!==undefined||r.inputHash!==undefined||r.canonicalHash!==undefined;
 if((r.producer.backend==='nebius'||binding)&&(typeof r.inputArtifactId!=='string'||!r.inputArtifactId.length||r.inputArtifactId.length>256||!sha(r.inputHash)||!sha(r.canonicalHash))) throw Error('Invalid OCR image binding');
 if(r.imageGeometry!==undefined)geometry(r.imageGeometry,r);
 const coordinateProvenance=r.producer.backend==='nebius'?'model-estimated':'backend-reported';
 if(r.coordinateProvenance!==undefined&&r.coordinateProvenance!==coordinateProvenance)throw Error('Wrong OCR coordinate provenance');
 if(r.page!==undefined) {
  parseOcrPageGeometry(r.page);
  if(!r.imageGeometry||!r.inputArtifactId)throw Error('Page geometry requires exact OCR image binding');
  const [w,h]=r.imageGeometry.encodedDimensions;
  const corners=mapOcrPolygon([{x:0,y:0},{x:w!,y:0},{x:w!,y:h!},{x:0,y:h!}],r.page.inputToRender);
  if(corners.some(p=>p.x< -1e-6||p.y< -1e-6||p.x>r.page!.renderPixelDimensions[0]!+1e-6||p.y>r.page!.renderPixelDimensions[1]!+1e-6))throw Error('OCR input transform outside rendered page');
 }
 if(r.producer.backend==='nebius'&&(!r.imageGeometry||!r.coverage)) throw Error('Missing OCR geometry/coverage');
 if(r.coverage&&(r.coverage.status!=='partial'||!Number.isInteger(r.coverage.maximumSpans)||r.coverage.maximumSpans<1||r.coverage.maximumSpans>64||r.spans.length>r.coverage.maximumSpans)) throw Error('Invalid OCR coverage');
 for(const [index,s] of r.spans.entries()) {
  if(!s||typeof s.text!=='string'||s.text.length>16384||!['unresolved','not-assessed'].includes(s.uncertainty)||(s.confidence!==undefined&&(!Number.isFinite(s.confidence)||s.confidence<0||s.confidence>1))||!Array.isArray(s.polygon)||s.polygon.length<3||s.polygon.length>16||s.polygon.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>1||p.y>1)||s.id!==spanId(r.sourceId,r.sourceVersion,index,s)) throw Error('Invalid OCR span');
  // A line/point is not a highlightable region. Signed shoelace area handles either winding.
  if(s.bbox!==undefined) {
   const expected=ocrBoundingBox(s.polygon);
   if(Object.keys(s.bbox).sort().join(',')!=='height,width,x,y'||(['x','y','width','height'] as const).some(k=>s.bbox![k]!==expected[k]))throw Error('OCR bbox must derive from polygon');
  }
  if(Math.abs(s.polygon.reduce((sum,p,i)=>{const q=s.polygon[(i+1)%s.polygon.length]!;return sum+p.x*q.y-q.x*p.y;},0))<1e-12)throw Error('Empty OCR region');
 }
 return {...r,coordinateProvenance,spans:r.spans.map(s=>({...s,bbox:ocrBoundingBox(s.polygon)}))};
}
/** Check actual immutable artifacts and bounded ancestor lineage, not model-asserted page numbers. */
export function assertOcrPageBinding(store:EvidenceStore,ns:Namespace,sourceId:string,sourceVersion:string,inputArtifactId:string,page:OcrPageGeometry):void {
 const source=store.source(ns,sourceId);
 const ctx={...ns,scope:{sources:[source]}};
 const document=resolveInput(store,ctx,page.documentArtifactId),render=resolveInput(store,ctx,page.renderArtifactId);
 if(source.sha256!==sourceVersion||document.artifact.mimeType!=='application/pdf'||document.artifact.sha256!==page.documentHash||render.artifact.mimeType!=='image/png'||render.artifact.sha256!==page.renderHash||[document,render].some(r=>r.roots.size!==1||r.roots.get(sourceId)!==sourceVersion))throw Error('Wrong OCR page artifact binding');
 const bytes=render.bytes;
 if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==page.renderPixelDimensions[0]||bytes.readUInt32BE(20)!==page.renderPixelDimensions[1])throw Error('Wrong OCR render dimensions');
 function descendant(child:string,parent:string):boolean {
  let visits=0;const seen=new Set<string>();
  const walk=(id:string):boolean=>{
   if(++visits>64)throw Error('OCR page lineage exceeds bounds');
   if(seen.has(id))return false;
   if(id===sourceId)id=source.snapshotArtifactId;
   if(id===parent)return true;seen.add(id);
   return store.artifact(ns,id).derivedFrom.some(walk);
  };
  return walk(child);
 }
 if(!descendant(page.renderArtifactId,page.documentArtifactId)||!descendant(inputArtifactId,page.renderArtifactId))throw Error('OCR image is not the cited rendered page');
}
export function spanId(sourceId:string,version:string,index:number,span:Omit<OcrSpan,'id'>):string { return digest(Buffer.from(JSON.stringify([sourceId,version,index,span.text,span.polygon]))); }
/** Persisted regions only; the exact derived page artifact is never replaced by its root PDF. */
export function resolveOcr(store:EvidenceStore,ns:Namespace,artifactId:string,sourceId:string,sourceVersion:string,spanIds:string[]) {
 const artifact=store.artifact(ns,artifactId);
 if(artifact.mimeType!=='application/vnd.spindle.ocr+json'||!artifact.derivedFrom.includes(sourceId)) throw Error('Not OCR evidence');
 const r=parseOcrRecord(JSON.parse(store.read(ns,artifactId).toString('utf8')));
 const source=store.source(ns,sourceId);store.read(ns,source.snapshotArtifactId);
 if(r.sourceId!==sourceId||r.sourceVersion!==sourceVersion||source.sha256!==sourceVersion||!spanIds.length||spanIds.length>10000) throw Error('Wrong source version');
 let snapshotArtifactId=source.snapshotArtifactId;
 if(r.inputArtifactId) {
  const input=resolveInput(store,{...ns,scope:{sources:[source]}},r.inputArtifactId);
  if(input.artifact.sha256!==r.inputHash||input.roots.size!==1||input.roots.get(sourceId)!==sourceVersion||!['image/png','image/jpeg','image/heif','image/heic'].includes(input.artifact.mimeType)) throw Error('Wrong OCR image binding');
  if(!artifact.derivedFrom.includes(input.artifact.id)) throw Error('Missing OCR input lineage');
  snapshotArtifactId=input.artifact.id;
 }
 if(r.page)assertOcrPageBinding(store,ns,sourceId,sourceVersion,snapshotArtifactId,r.page);
 const imageHash=store.artifact(ns,snapshotArtifactId).sha256;
 return spanIds.map(id=>{
  const s=r.spans.find(s=>s.id===id);if(!s)throw Error('Unknown span');
  // Normalized model boxes refer to oriented pixels; citations open the exact encoded image.
  const [a,b,tx,d,e,ty]=r.imageGeometry?.sourceToEncoded??[1,0,0,0,1,0];
  const polygon=s.polygon.map(p=>{const x=p.x*r.sourceWidthPx,y=p.y*r.sourceHeightPx;return{x:a!*x+b!*y+tx!,y:d!*x+e!*y+ty!};});
  const pagePolygon=r.page?mapOcrPolygon(mapOcrPolygon(polygon,r.page.inputToRender),[r.page.pagePoints[0]!/r.page.renderPixelDimensions[0]!,0,0,0,r.page.pagePoints[1]!/r.page.renderPixelDimensions[1]!,0]):undefined;
  return{spanId:id,text:s.text,uncertainty:s.uncertainty,...(s.confidence!==undefined?{confidence:s.confidence}:{}),sourceId,sourceVersion,snapshotArtifactId,imageHash,...(r.canonicalHash?{canonicalHash:r.canonicalHash}:{}),polygon,bbox:ocrBoundingBox(polygon),sourcePixelDimensions:r.imageGeometry?.encodedDimensions??[r.sourceWidthPx,r.sourceHeightPx],coordinateSpace:'source-pixels' as const,coordinateProvenance:r.coordinateProvenance,...(r.page?{pageIndex:r.page.pageIndex,pageHash:r.page.renderHash,pageGeometry:r.page,pagePolygon,pageBbox:ocrBoundingBox(pagePolygon!),pageCoordinateSpace:r.page.coordinateSystem}:{})};
 });
}
