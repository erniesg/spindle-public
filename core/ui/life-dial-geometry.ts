// Typed ESM port of owner-approved dist/life-dial.js, export ba2f72a002 (Sites v85).
// Source SHA256 dbf6461a462ccbf7c51646e41e62e286f7a3691b38c4771498156cb9a12480ff.
// Retains geometry, drawFace and the default 'taper' hand branch. Unused hand variants omitted.
// Colour/font values are supplied by the shared theme, never a second palette.
export const YEARS=80, WEEKS=4174;
const TAU=Math.PI*2, TOP=-Math.PI/2;
export const boundary=(year:number,count=WEEKS)=>Math.floor(year*count/YEARS);
export interface Point {x:number;y:number;r:number;year:number;week:number;length:number}
export interface Layout {cx:number;cy:number;radius:number;inner:number;points:Point[]}
export interface Colors {ink:string;sub:string;edge:string;now:string}
export interface Fonts {body:string;display:string}
export interface FaceOptions {hand?:boolean;centre?:boolean;handAge?:number;centreValue?:number}
export function geometry(width:number,height:number,count=WEEKS):Layout {
 const radius=Math.max(20,Math.min(width/2-25,height/2-24));
 const cx=width/2,cy=height/2,inner=radius*.295,points:Point[]=[];
 for(let year=0;year<YEARS;year++){
  const start=boundary(year,count),length=boundary(year+1,count)-start;
  const angle=TOP+TAU*year/YEARS;
  const dot=Math.max(.25,Math.min(1.25*radius/232,(radius*.90-inner)/length*.31));
  for(let week=0;week<length;week++){
   const r=inner+(radius*.90-inner)*(week+.5)/length;
   points.push({x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r,r:dot,year,week,length});
  }
 }
 return {cx,cy,radius,inner,points};
}
// A single open-ended hand marks age. The week marker belongs to the grid.
export function drawFace(ctx:CanvasRenderingContext2D,layout:Layout,age:number,colors:Colors,fonts:Fonts,options:FaceOptions={}){
 const {cx,cy,radius}=layout,scale=Math.min(1,radius/232);
 ctx.save();ctx.setLineDash([]);ctx.lineCap='butt';
 ctx.font=`400 ${radius<160?8:10}px ${fonts.body}`;ctx.textAlign='center';ctx.textBaseline='middle';
 for(let year=0;year<YEARS;year++){
  const a=TOP+TAU*year/YEARS,major=year%10===0;
  const r1=radius*.95,r2=r1+(major?7:3.5)*scale;
  ctx.strokeStyle=major?colors.sub:colors.edge;ctx.lineWidth=.65;
  ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r1,cy+Math.sin(a)*r1);
  ctx.lineTo(cx+Math.cos(a)*r2,cy+Math.sin(a)*r2);ctx.stroke();
  if(major){ctx.fillStyle=colors.sub;ctx.fillText(year===0?'0 / 80':String(year),cx+Math.cos(a)*(radius+12),cy+Math.sin(a)*(radius+12));}
 }
 const angle=TOP+TAU*(options.handAge??age)/YEARS;
 if(options.hand!==false)drawHand(ctx,layout,angle,colors.now);
 if(options.centre===false){ctx.restore();return;}
 const size=Math.min(42,radius*.22);
 ctx.fillStyle=colors.ink;ctx.font=`400 ${size}px ${fonts.display}`;ctx.fillText(String(options.centreValue??age),cx,cy-3);
 ctx.fillStyle=colors.sub;ctx.font=`400 ${radius<160?7:8}px ${fonts.body}`;ctx.fillText('YEARS',cx,cy+size*.65);ctx.restore();
}
export function drawHand(ctx:CanvasRenderingContext2D,{cx,cy,radius}:Layout,angle:number,color:string){
 const start=radius*.28,end=radius*.94,w=Math.max(2.2,radius*.018);
 ctx.save();ctx.translate(cx,cy);ctx.rotate(angle);ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineCap='round';
 ctx.beginPath();ctx.moveTo(start,-w);ctx.lineTo(end,0);ctx.lineTo(start,w);ctx.closePath();ctx.fill();
 ctx.beginPath();ctx.arc(start,0,w*1.25,0,TAU);ctx.fill();ctx.restore();
}
