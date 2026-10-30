import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ToolContext,ToolDefinition,ToolResult,Schema} from '../agent/contracts.js';
import {resolveInput} from '../evidence/inputs.js';
import type {EvidenceStore} from '../evidence/store.js';
import {detectFormLines} from '../tools/images.js';
import type {PreparationContext} from './service.js';
import {preparationArtifactCurrent} from './artifact-binding.js';
/** Page geometry in PDF points, top-left origin (same space as document.overlay page_points). */
export interface FormLayout {
 pageIndex:number;pagePoints:{width:number;height:number};
 lines:{text:string;box:Box}[];words:{text:string;box:Box}[];
 underlines:{x0:number;x1:number;y:number}[];boxRows:{box:Box;cells:Box[]}[];
}
interface Box {x:number;y:number;width:number;height:number}
export interface FormLayoutOptions {pdftotextExecutable:string;pdftoppmExecutable:string;pythonExecutable?:string}
const run=(file:string,args:string[],signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{execFile(file,args,{timeout:20000,signal,maxBuffer:1024*1024},error=>error?reject(error):resolve());});
const decode=(t:string)=>t.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const round=(n:number)=>Math.round(n*100)/100;
/** Text-layer words (Poppler -bbox-layout) plus rules/box rows detected on a 100dpi render of the same page. */
export async function formLayout(pdf:Buffer,pageIndex:number,options:FormLayoutOptions,signal:AbortSignal):Promise<FormLayout>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-layout-'));
 try{
  const input=join(dir,'in.pdf'),page=String(pageIndex+1);await writeFile(input,pdf,{mode:0o600});
  await run(options.pdftotextExecutable,['-bbox-layout','-f',page,'-l',page,input,join(dir,'words.html')],signal);
  await run(options.pdftoppmExecutable,['-r','100','-f',page,'-l',page,'-png','-singlefile',input,join(dir,'page')],signal);
  const html=await readFile(join(dir,'words.html'),'utf8'),png=await readFile(join(dir,'page.png'));
  const size=/<page width="([\d.]+)" height="([\d.]+)"/.exec(html);if(!size)throw Error('Page has no layout');
  const pagePoints={width:Number(size[1]),height:Number(size[2])};
  const words=[...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m=>({text:decode(m[5]!),box:{x:round(Number(m[1])),y:round(Number(m[2])),width:round(Number(m[3])-Number(m[1])),height:round(Number(m[4])-Number(m[2]))}}));
  const lines:{text:string;box:Box}[]=[];
  for(const w of [...words].sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x)){
   const line=lines.find(l=>Math.abs(l.box.y-w.box.y)<=2&&w.box.x>=l.box.x+l.box.width-1&&w.box.x-(l.box.x+l.box.width)<=12);
   if(line){line.text+=' '+w.text;const right=Math.max(line.box.x+line.box.width,w.box.x+w.box.width);line.box.height=Math.max(line.box.height,w.box.height);line.box.width=round(right-line.box.x);}
   else lines.push({text:w.text,box:{...w.box}});
  }
  const geometry=await detectFormLines(png,signal,options.pythonExecutable);
  const sx=pagePoints.width/geometry.width,sy=pagePoints.height/geometry.height;
  const pt=(c:number[]):Box=>({x:round(c[0]!*sx),y:round(c[1]!*sy),width:round((c[2]!-c[0]!)*sx),height:round((c[3]!-c[1]!)*sy)});
  return {pageIndex,pagePoints,words,lines,
   underlines:geometry.underlines.map(([a,b,y])=>({x0:round(a!*sx),x1:round(b!*sx),y:round(y!*sy)})),
   boxRows:geometry.cellRows.map(row=>{const cells=row.map(pt);return {box:{x:cells[0]!.x,y:cells[0]!.y,width:round(cells.at(-1)!.x+cells.at(-1)!.width-cells[0]!.x),height:cells[0]!.height},cells};})};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const norm=(t:string)=>t.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
/** Locate a printed label as consecutive words on one line (case/punctuation-insensitive). */
export function findLabel(layout:FormLayout,label:string,occurrence=1):Box|undefined{
 const want=norm(label).split(' ').filter(Boolean);if(!want.length)return undefined;
 const words=[...layout.words].sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x).map(w=>({...w,n:norm(w.text)})).filter(w=>w.n);
 let seen=0;
 for(let i=0;i<words.length;i++){
  let j=0,k=i,parts:typeof words=[];
  while(j<want.length&&k<words.length){
   const w=words[k]!;if(parts.length&&(Math.abs(w.box.y-parts[0]!.box.y)>3))break;
   const tokens=w.n.split(' ');if(!tokens.every((t,o)=>want[j+o]===t||(j+o===want.length-1&&want[j+o]!.startsWith(t))))break;
   parts.push(w);j+=tokens.length;k++;
  }
  if(j>=want.length&&++seen===occurrence){const x=Math.min(...parts.map(p=>p.box.x)),y=Math.min(...parts.map(p=>p.box.y)),r=Math.max(...parts.map(p=>p.box.x+p.box.width)),b=Math.max(...parts.map(p=>p.box.y+p.box.height));return {x,y,width:r-x,height:b-y};}
 }
 // Printed small print often wraps onto the next line: fall back to the label without its parenthetical.
 const short=label.replace(/\s*\([^)]*\)?\s*$/,'').trim();
 return short&&short!==label.trim()?findLabel(layout,short,occurrence):undefined;
}
type Place='right'|'below'|'boxes'|'line';
interface Target {kind:'boxes'|'line';relation:'right'|'below';distance:number;row?:{box:Box;cells:Box[]};line?:{x0:number;x1:number;y:number};key:string;freeCells?:Box[]}
/** Nearest fillable target for a label: box rows or underlines, to its right on the same band or just below. */
export function chooseTarget(layout:FormLayout,label:Box,place:Place|undefined,taken:Set<string>):Target|undefined{
 const lb=label.y+label.height,lr=label.x+label.width,cy=label.y+label.height/2,options:Target[]=[];
 for(const [i,row] of layout.boxRows.entries()){
  const key=`row${i}`,b=row.box,rc=b.y+b.height/2;
  // Boxes already holding printed characters (e.g. a pre-printed country code) are skipped.
  const freeCells=row.cells.filter(c=>!layout.words.some(w=>{const x=w.box.x+w.box.width/2,y=w.box.y+w.box.height/2;return x>c.x&&x<c.x+c.width&&y>c.y&&y<c.y+c.height;}));
  if(Math.abs(rc-cy)<=Math.max(10,b.height)&&b.x>=lr-4)options.push({kind:'boxes',relation:'right',distance:b.x-lr,row,key,freeCells});
  else if(b.y>=lb-2&&b.y-lb<=45&&b.x<=label.x+120&&b.x+b.width>=label.x-20)options.push({kind:'boxes',relation:'below',distance:(b.y-lb)+Math.abs(b.x-label.x)*0.3,row,key,freeCells});
 }
 for(const [i,line] of layout.underlines.entries()){
  const key=`line${i}`;
  if(Math.abs(line.y-lb)<=9&&line.x0>=lr-4&&line.x0-lr<=220)options.push({kind:'line',relation:'right',distance:line.x0-lr,line,key});
  else if(line.y>lb+2&&line.y-lb<=45&&line.x0<=label.x+60&&line.x1>=label.x+label.width*0.5)options.push({kind:'line',relation:'below',distance:(line.y-lb)+Math.abs(line.x0-label.x)*0.3,line,key});
 }
 const fits=options.filter(o=>!taken.has(o.key)&&(!place||(place==='boxes'||place==='line'?o.kind===(place==='boxes'?'boxes':'line'):o.relation===place)));
 return fits.sort((a,b)=>a.distance-b.distance)[0];
}
/** Placements in page points; character boxes get one character each, centred. */
export function placementsFor(target:Target,value:string,scale=1):{type:'text';box:Box;value:string;fontSize:number}[]|string{
 if(target.kind==='boxes'){
  // Boxed fields take characters only: separators (- / spaces) are dropped; letters/digits keep order.
  const cells=target.freeCells??target.row!.cells,chars=[...value.replace(/[\s\-\/.]/g,'')];
  if(chars.length>cells.length)return `"${value}" has ${chars.length} characters but the boxes hold ${cells.length}`;
  return chars.map((ch,i)=>{const c=cells[i]!,size=round(Math.min(11,c.height*0.62,c.width*0.95)*scale),w=size*0.62;
   // Centre the glyph: put the baseline ~78% down the cell (cap height ~0.73em sits in the middle).
   const top=Math.max(0,c.y+c.height*0.78-size*0.93);
   return {type:'text' as const,value:ch,fontSize:size,box:{x:round(c.x+Math.max(0.5,(c.width-w)/2)),y:round(top),width:round(Math.min(c.width-1,w+2)),height:round(size*1.2)}};});
 }
 const l=target.line!,width=l.x1-l.x0-4,size=round(Math.min(10,width/Math.max(1,value.length*0.6))*scale),h=size*1.25+1;
 return [{type:'text',value,fontSize:size,box:{x:round(l.x0+2),y:round(Math.max(0,l.y-h-1)),width:round(width),height:round(h)}}];
}
const loose:Schema={jsonSchema:{type:'object'},parse:(v:unknown)=>v};
const layoutArgs:Schema={jsonSchema:{type:'object',properties:{inputId:{type:'string',minLength:1,maxLength:256},pageIndex:{type:'integer',minimum:0,maximum:99}},required:['inputId','pageIndex'],additionalProperties:false},parse(v:unknown){const a=v as {inputId?:unknown;pageIndex?:unknown};if(!a||typeof a!=='object'||Object.keys(a).sort().join()!=='inputId,pageIndex'||typeof a.inputId!=='string'||!a.inputId||!Number.isInteger(a.pageIndex)||(a.pageIndex as number)<0||(a.pageIndex as number)>99)throw Error('Expected {inputId, pageIndex}');return a;}};
const entry={type:'object',properties:{label:{type:'string',minLength:1,maxLength:120,description:'Printed label text on the form, e.g. "NRIC (individual)" or "Account No."'},value:{type:'string',minLength:1,maxLength:200,description:'A recorded field value (preparation.record_fields).'},place:{enum:['right','below','boxes','line'],description:'Optional hint: target to the right/below the label, or a character-box row / underline.'},occurrence:{type:'integer',minimum:1,maximum:5}},required:['label','value'],additionalProperties:false};
const fillArgs:Schema={jsonSchema:{type:'object',properties:{inputId:{type:'string',minLength:1,maxLength:256},pageIndex:{type:'integer',minimum:0,maximum:99},entries:{type:'array',minItems:1,maxItems:30,items:entry}},required:['inputId','pageIndex','entries'],additionalProperties:false},parse(v:unknown){
 const a=v as {inputId?:unknown;pageIndex?:unknown;entries?:unknown};
 if(!a||typeof a!=='object'||Object.keys(a).some(k=>!['inputId','pageIndex','entries'].includes(k))||typeof a.inputId!=='string'||!a.inputId||!Number.isInteger(a.pageIndex)||(a.pageIndex as number)<0||(a.pageIndex as number)>99||!Array.isArray(a.entries)||!a.entries.length||a.entries.length>30)throw Error('Expected {inputId, pageIndex, entries[1..30]}');
 for(const e of a.entries as Record<string,unknown>[])if(!e||typeof e!=='object'||Object.keys(e).some(k=>!['label','value','place','occurrence'].includes(k))||typeof e.label!=='string'||!e.label.trim()||e.label.length>120||typeof e.value!=='string'||!e.value||e.value.length>200||(e.place!==undefined&&!['right','below','boxes','line'].includes(e.place as string))||(e.occurrence!==undefined&&(!Number.isInteger(e.occurrence)||(e.occurrence as number)<1||(e.occurrence as number)>5)))throw Error('Each entry needs label and value (optional place, occurrence)');
 return a;}};
/** document.layout + document.fill_by_label for flat PDFs. The model maps values to printed labels; code finds the
 * geometry and writes through the existing overlay engine. Values must be recorded, resolved fields (as for overlay). */
export function createFormFillTools(c:PreparationContext,overlay:ToolDefinition,options:FormLayoutOptions):ToolDefinition[]{
 const pdfOf=(inputId:string,ctx:ToolContext)=>{const input=resolveInput(c.store,ctx,inputId);if(input.artifact.mimeType!=='application/pdf')throw Error('Input is not a PDF');return input;};
 const failed=(ctx:ToolContext,producer:string,code:string,message:string,data:unknown=null):ToolResult=>({effect:'none',callId:ctx.callId,status:'failed',data,artifacts:[],evidence:[],observations:['No PDF was written.'],error:{code,message:message.slice(0,500),producer}});
 const layout:ToolDefinition={name:'document.layout',version:'1',effect:'read',capabilities:['document.read'],inputSchema:layoutArgs,outputSchema:loose,async invoke(value,ctx){
  const {inputId,pageIndex}=layoutArgs.parse(value) as {inputId:string;pageIndex:number};
  try{const l=await formLayout(pdfOf(inputId,ctx).bytes,pageIndex,options,ctx.signal);
   return {callId:ctx.callId,status:'ok',data:{pageIndex,pagePoints:l.pagePoints,coordinateSpace:'page points, top-left origin',lines:l.lines.slice(0,200),underlines:l.underlines,boxRows:l.boxRows.map(r=>({box:r.box,cells:r.cells.length}))},artifacts:[],evidence:[],observations:['Printed text lines with positions plus detected underlines and character-box rows. Use document.fill_by_label to place recorded values by label.']};}
  catch(error){return failed(ctx,'document.layout','LAYOUT_UNAVAILABLE',error instanceof Error?error.message:'Layout unavailable');}
 }};
 const fill:ToolDefinition&{artifactFieldIds(args:unknown):string[]}={name:'document.fill_by_label',version:'1',effect:'write_local',capabilities:['document.edit'],inputSchema:fillArgs,outputSchema:loose,
  artifactFieldIds(args){const values=((args as {entries?:{value:string}[]}).entries??[]).flatMap(e=>[e.value,...e.value.split(/\s*(?:,|\/|&|\band\b)\s*/i)]);return c.tasks.get(c.taskId).preparation!.fields.filter(f=>!f.unresolved&&values.includes(f.value)).map(f=>f.id);},
  async invoke(value,ctx){
   const {inputId,pageIndex,entries}=fillArgs.parse(value) as {inputId:string;pageIndex:number;entries:{label:string;value:string;place?:Place;occurrence?:number}[]};
   const p=c.tasks.get(c.taskId).preparation!;
   // Same grounding as document.overlay: every value is a recorded, resolved field (or an explicit correction).
   // A value may also combine several recorded values (e.g. joint account holders "A, B") if every part is recorded.
   const recorded=p.fields.filter(f=>!f.unresolved&&f.value).map(f=>f.value);
   const grounded=(v:string)=>recorded.includes(v)||v.split(/\s*(?:,|\/|&|\band\b)\s*/i).filter(Boolean).every(part=>recorded.includes(part));
   const ungrounded=entries.find(e=>!grounded(e.value));
   if(ungrounded)return failed(ctx,'document.fill_by_label','FIELD_GROUNDING_REQUIRED',`"${ungrounded.label}" value "${ungrounded.value}" is not a recorded, resolved field (or a combination of them joined by , / & and). Recorded values: ${recorded.map(v=>`"${v}"`).join(', ').slice(0,300)}.`);
   let input;try{input=pdfOf(inputId,ctx);}catch(error){return failed(ctx,'document.fill_by_label','INPUT_UNAVAILABLE',error instanceof Error?error.message:'Input unavailable');}
   if(p.revision>1&&!preparationArtifactCurrent(c.store,c.namespace,p,input.artifact.id))return failed(ctx,'document.fill_by_label','CORRECTION_ORIGINAL_REQUIRED','Regenerate from the original form or current-revision artifact, not an earlier filled output.');
   let l:FormLayout;try{l=await formLayout(input.bytes,pageIndex,options,ctx.signal);}catch(error){return failed(ctx,'document.fill_by_label','LAYOUT_UNAVAILABLE',error instanceof Error?error.message:'Layout unavailable');}
   const taken=new Set<string>(),plan:{entry:typeof entries[number];target:Target}[]=[],problems:string[]=[];
   for(const e of entries){
    const label=findLabel(l,e.label,e.occurrence);if(!label){problems.push(`label "${e.label}" not found on page ${pageIndex}`);continue;}
    const target=chooseTarget(l,label,e.place,taken);if(!target){problems.push(`no free underline or box row near "${e.label}"${e.place?` (${e.place})`:''}`);continue;}
    taken.add(target.key);plan.push({entry:e,target});
   }
   if(problems.length)return failed(ctx,'document.fill_by_label','LABEL_PLACEMENT_UNRESOLVED',problems.join('; ')+'. Check document.layout lines, adjust the label text, place or occurrence.');
   let last:ToolResult|undefined;
   for(const scale of [1,0.85,0.72]){
    const placements=[];for(const {entry,target} of plan){const r=placementsFor(target,entry.value,scale);if(typeof r==='string')return failed(ctx,'document.fill_by_label','VALUE_DOES_NOT_FIT',r);placements.push(...r);}
    last=await overlay.invoke({inputId,pageIndex,coordinateSpace:{kind:'page_points'},placements},ctx);
    if(last.status==='ok'||!/overflow/i.test(JSON.stringify(last.error??last.data)))break;
   }
   if(last!.status!=='ok')return {...last!,...(last!.artifacts.length?{}:{effect:'none' as const})};
   return {...last!,observations:[...plan.map(({entry,target})=>`${entry.label} -> ${target.kind==='boxes'?`${target.row!.cells.length} character boxes`:'underline'} ${target.relation} of the label`),...last!.observations,'Render the page (document.render) and check placement before saving.']};
  }};
 return [layout,fill];
}
