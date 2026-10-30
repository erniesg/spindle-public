import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {findLabel,chooseTarget,placementsFor,formLayout,createFormFillTools,type FormLayout} from '../../core/preparation/form-fill.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import type {ToolContext} from '../../core/agent/contracts.js';
const b=(x:number,y:number,width:number,height:number)=>({x,y,width,height});
const word=(text:string,x:number,y:number)=>({text,box:b(x,y,text.length*5,10)});
// Synthetic layout: label with an underline to the right, a label above a box row, and a pre-printed box.
const layout:FormLayout={pageIndex:0,pagePoints:{width:595,height:842},lines:[],
 words:[word('NRIC',100,100),word('(individual)',125,100),word('Account',100,150),word('No.',140,150),word('Fax',100,200),word('6',301,202)],
 underlines:[{x0:200,x1:400,y:110}],
 boxRows:[{box:b(100,165,160,16),cells:Array.from({length:8},(_,i)=>b(100+i*20,165,20,16))},{box:b(300,198,80,16),cells:Array.from({length:4},(_,i)=>b(300+i*20,198,20,16))}]};
test('labels are matched case/punctuation-insensitively and mapped to the nearest free target',()=>{
 const nric=findLabel(layout,'nric (Individual)')!;assert.ok(nric);
 const line=chooseTarget(layout,nric,undefined,new Set())!;assert.equal(line.kind,'line');assert.equal(line.relation,'right');
 const acc=chooseTarget(layout,findLabel(layout,'Account No')!,undefined,new Set())!;assert.equal(acc.kind,'boxes');assert.equal(acc.relation,'below');
 const p=placementsFor(acc,'123-456') as {value:string;box:{x:number}}[];assert.deepEqual(p.map(x=>x.value),['1','2','3','4','5','6']);assert.ok(p[0]!.box.x>=100&&p[0]!.box.x<120);
 const fax=chooseTarget(layout,findLabel(layout,'Fax')!,'boxes',new Set())!;assert.equal(fax.freeCells!.length,3,'pre-printed 6 cell skipped');
 assert.match(placementsFor(fax,'12345') as string,/boxes hold 3/);
 assert.equal(findLabel(layout,'Passport number'),undefined);
 assert.deepEqual(findLabel(layout,'Account No. (as stated in passbook or account statement)'),findLabel(layout,'Account No'),'wrapped small print falls back to the printed label');
});
const env={pdftotext:'/usr/bin/pdftotext',pdftoppm:'/usr/bin/pdftoppm',python:process.env.SPINDLE_IMAGE_PYTHON};
const skip=env.python&&existsSync(env.pdftotext)&&existsSync(env.pdftoppm)?false:'Needs SPINDLE_IMAGE_PYTHON and Poppler';
async function miniForm(){
 const doc=await PDFDocument.create(),page=doc.addPage([595,842]),font=await doc.embedFont(StandardFonts.Helvetica);
 const top=(y:number)=>842-y;page.drawText('Name of Account Holder',{x:60,y:top(110),size:10,font});page.drawLine({start:{x:60,y:top(140)},end:{x:500,y:top(140)},thickness:1,color:rgb(0,0,0)});
 page.drawText('Account No.',{x:60,y:top(180),size:10,font});
 for(let i=0;i<=10;i++)page.drawLine({start:{x:60+i*20,y:top(190)},end:{x:60+i*20,y:top(210)},thickness:1});
 page.drawLine({start:{x:60,y:top(190)},end:{x:260,y:top(190)},thickness:1});page.drawLine({start:{x:60,y:top(210)},end:{x:260,y:top(210)},thickness:1});
 return Buffer.from(await doc.save());
}
test('real PDF: layout finds the underline and box row; fill_by_label writes grounded values and refuses ungrounded ones',{skip},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'form-fill-')),store=new EvidenceStore(dir),ns={workspaceId:'w',accountId:'a'};
 try{
  const pdf=await miniForm(),l=await formLayout(pdf,0,{pdftotextExecutable:env.pdftotext,pdftoppmExecutable:env.pdftoppm,pythonExecutable:env.python},new AbortController().signal);
  assert.ok(l.underlines.some(u=>u.x1-u.x0>400));assert.ok(l.boxRows.some(r=>r.cells.length===10));
  const source=store.put(ns,pdf,'application/pdf',[],{provider:'user'}).source!;
  const fields=[{id:'f1',label:'Holder',value:'TAN AH KOW',unresolved:false,citations:[]},{id:'f2',label:'Account',value:'123-45678',unresolved:false,citations:[]}];
  const c={taskId:'t',namespace:ns,store,tasks:{get:()=>({preparation:{fields,revision:1}})}} as never;
  const overlay=createDocumentTools(store,{renderFontPath:'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',renderFontLicense:'test'}).find(t=>t.name==='document.overlay')!;
  const [,fill]=createFormFillTools(c,overlay,{pdftotextExecutable:env.pdftotext,pdftoppmExecutable:env.pdftoppm,pythonExecutable:env.python});
  const ctx:ToolContext={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source],grants:['document.processing'],destinations:[]},budget:{used:0,limit:9},signal:new AbortController().signal,isCurrent:()=>true};
  const denied=await fill!.invoke(fill!.inputSchema.parse({inputId:source.id,pageIndex:0,entries:[{label:'Account No.',value:'999'}]}),ctx);
  assert.equal(denied.error!.code,'FIELD_GROUNDING_REQUIRED');assert.equal(denied.effect,'none');assert.match(denied.error!.message,/Recorded values: "TAN AH KOW", "123-45678"/);
  const mixed=await fill!.invoke(fill!.inputSchema.parse({inputId:source.id,pageIndex:0,entries:[{label:'Name of Account Holder',value:'TAN AH KOW, LIM'}]}),ctx);
  assert.equal(mixed.error!.code,'FIELD_GROUNDING_REQUIRED','every part of a combined value must be recorded');
  const r=await fill!.invoke(fill!.inputSchema.parse({inputId:source.id,pageIndex:0,entries:[{label:'Name of Account Holder',value:'TAN AH KOW, 123-45678'},{label:'Account No.',value:'123-45678'}]}),ctx);
  assert.equal(r.status,'ok',JSON.stringify(r.error??r.data));assert.ok(r.observations.some(o=>/Account No\. -> 10 character boxes below/.test(o)));
  const out=store.read(ns,r.artifacts[0]!.id);const text=execFileSync(env.pdftotext,['-layout','-','-'],{input:out}).toString();
  assert.match(text,/TAN AH KOW/);assert.match(text.replace(/\s+/g,''),/12345678/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
