import { PDFName, PDFNumber, type PDFPage } from 'pdf-lib';
export type Matrix = [number,number,number,number,number,number];
export interface PageGeometry {
 pageIndex:number; width:number;height:number;mediaBox:{x:number;y:number;width:number;height:number};cropBox:{x:number;y:number;width:number;height:number};
 rotation:number;userUnit:number;pagePoints:{width:number;height:number};coordinateSystem:'displayed_crop_top_left_points';pdfToPage:Matrix;
}
/** PDF affine convention: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export function transform(m:Matrix,x:number,y:number):[number,number] {return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
export function inverse(m:Matrix):Matrix {
 const [a,b,c,d,e,f]=m,det=a*d-b*c;if(!Number.isFinite(det)||det===0)throw Error('Invalid page transform');
 return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
}
export function pageGeometry(page:PDFPage,pageIndex:number):PageGeometry {
 const mediaBox=page.getMediaBox(),rawCrop=page.getCropBox();
 // The visible page is CropBox intersect MediaBox (Poppler -cropbox).
 const x=Math.max(mediaBox.x,rawCrop.x),y=Math.max(mediaBox.y,rawCrop.y);
 const w=Math.min(mediaBox.x+mediaBox.width,rawCrop.x+rawCrop.width)-x,h=Math.min(mediaBox.y+mediaBox.height,rawCrop.y+rawCrop.height)-y;
 const cropBox={x,y,width:w,height:h};
 const unit=page.node.get(PDFName.of('UserUnit'));const userUnit=unit instanceof PDFNumber?unit.asNumber():1;
 const rawRotation=page.getRotation().angle,rotation=((rawRotation%360)+360)%360;
 if(![0,90,180,270].includes(rotation)||![...Object.values(mediaBox),...Object.values(cropBox),userUnit].every(Number.isFinite)||w<=0||h<=0||userUnit<=0||userUnit>75000)throw Error('Unsupported page geometry');
 const u=userUnit;
 const pdfToPage:Matrix=rotation===0?[u,0,0,-u,-u*x,u*(y+h)]:rotation===90?[0,u,u,0,-u*y,-u*x]:rotation===180?[-u,0,0,u,u*(x+w),-u*y]:[0,-u,-u,0,u*(y+h),u*(x+w)];
 return {pageIndex,width:page.getWidth(),height:page.getHeight(),mediaBox,cropBox,rotation,userUnit,pagePoints:{width:(rotation%180?h:w)*u,height:(rotation%180?w:h)*u},coordinateSystem:'displayed_crop_top_left_points',pdfToPage};
}
export function renderGeometry(page:PageGeometry,png:Buffer,sourceHash:string) {
 if(png.length<33||png.toString('ascii',12,16)!=='IHDR')throw Error('Invalid PNG geometry');
 const width=png.readUInt32BE(16),height=png.readUInt32BE(20);if(width<1||height<1||width>1600||height>1600)throw Error('Invalid rendered dimensions');
 const scale={x:width/page.pagePoints.width,y:height/page.pagePoints.height};const [a,b,c,d,e,f]=page.pdfToPage;
 return {...page,sourceHash,pixelDimensions:{width,height},coordinateSystem:'displayed_crop_top_left_pixels',scale,pdfToImage:[a*scale.x,b*scale.y,c*scale.x,d*scale.y,e*scale.x,f*scale.y] as Matrix,pageToImage:[scale.x,0,0,scale.y,0,0] as Matrix};
}
