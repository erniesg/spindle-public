import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFSignature, PDFDict, PDFArray, PDFRef, PDFName, StandardFonts, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {pageGeometry,inverse,transform} from './document-geometry.js';
const MAX=12*1024*1024;
class ValidationFailure extends Error {
 constructor(readonly code:string,readonly nextAction:string,readonly field?:string) {super(code);}
}
function fail(code:string,nextAction:string,field?:string):never {throw new ValidationFailure(code,nextAction,field?.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,128));}
async function run(r:any) {
 let renderFontName:string|undefined;
 if(!r || !['inspect','edit','overlay','export'].includes(r.operation) || typeof r.pdf!=='string') throw Error('Invalid request');
 const bytes=Buffer.from(r.pdf,'base64'); if(bytes.length>8*1024*1024) throw Error('PDF too large');
 const doc=await PDFDocument.load(bytes,{updateMetadata:false});
 if(doc.isEncrypted) throw Error('Encrypted PDF unsupported');
 // Walk direct and indirect graphs once, including nested action dictionaries.
 const seen=new Set<unknown>();let nodes=0;let signed=false;
 const inspect=(object:unknown,depth=0):void=>{
  if(depth>64 || ++nodes>100000) throw Error('PDF graph exceeds bounds');
  if(object instanceof PDFRef) object=doc.context.lookup(object);
  if(seen.has(object))return;seen.add(object);
  if(object instanceof PDFDict) {
   const type=object.get(PDFName.of('Type'));
   if((type instanceof PDFName && type.decodeText()==='Sig') || (object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents')))) signed=true;
   for(const key of object.keys()) {
    const name=key.decodeText();
    if(['AA','OpenAction','JS','JavaScript','Launch','EmbeddedFiles','RichMedia','XFA','Encrypt'].includes(name)) throw Error('Active PDF content unsupported');
    const value=object.get(key);
    if(name==='S' && value instanceof PDFName && ['JavaScript','Launch','SubmitForm','ImportData','GoToR','GoToE','Rendition','Movie','Sound','SetOCGState','Hide','ResetForm'].includes(value.decodeText())) throw Error('Active PDF action unsupported');
    inspect(value,depth+1);
   }
  } else if(object instanceof PDFArray) for(let i=0;i<object.size();i++)inspect(object.get(i),depth+1);
 };
 for(const [,object] of doc.context.enumerateIndirectObjects()) inspect(object);
 if(r.operation!=='inspect' && signed) throw Error('Signed source modification unsupported');
 const form=doc.getForm(); if(form.hasXFA()) throw Error('XFA unsupported');
 const fields=form.getFields(); if(fields.length>256 || doc.getPageCount()>100) throw Error('PDF structure exceeds bounds');
 // Discovery describes this source, not a promise that every value/font fits.
 const editableFields=fields.filter(f=>!signed&&!f.isReadOnly()&&!(f instanceof PDFTextField&&f.isPassword())&&(f instanceof PDFTextField||f instanceof PDFCheckBox||f instanceof PDFDropdown||f instanceof PDFOptionList));
 const credentialFieldsPresent=fields.some(f=>f instanceof PDFTextField&&f.isPassword());
 const editingCapabilities={editableFieldNames:editableFields.map(f=>f.getName()),fieldEditing:editableFields.length?'supported':'unsupported',overlay:!signed&&!credentialFieldsPresent&&!fields.some(f=>f instanceof PDFSignature)?'supported':'unsupported',signedSource:signed,credentialFieldsPresent};
 const pages=doc.getPages().map(pageGeometry);
 const descriptions=()=>fields.map(f=>{
  const base={name:f.getName(),type:f.constructor.name,required:f.isRequired(),readOnly:f.isReadOnly(),widgets:f.acroField.getWidgets().map(w=>w.getRectangle())};
  if(f instanceof PDFTextField) return {...base,password:f.isPassword(),maxLength:f.getMaxLength(),multiline:f.isMultiline(),value:f.isPassword()?'[redacted]':f.getText()??''};
  if(f instanceof PDFCheckBox) return {...base,value:f.isChecked()};
  if(f instanceof PDFDropdown || f instanceof PDFOptionList) return {...base,options:f.getOptions(),value:f.getSelected()};
  return base;
 });
 if(r.operation==='edit') {
  if(!editableFields.length) fail('no_editable_fields','This source has no supported editable fields. Inspect page geometry and use document.overlay with explicit bounded placements; preserve the original.');
  if(fields.some(f=>f instanceof PDFSignature && f.acroField.dict.get(PDFName.of('V'))!==undefined)) throw Error('Signed source modification unsupported');
  const values=r.values; if(!values || typeof values!=='object' || Array.isArray(values) || Object.keys(values).length>256) throw Error('Invalid values');
  let font;
  if(r.renderFont!==undefined) {
   if(typeof r.renderFont!=='string'||r.renderFont.length>6*1024*1024) fail('unsupported_font','Configure a bounded supported licensed rendering font.');
   try {doc.registerFontkit(fontkit);font=await doc.embedFont(Buffer.from(r.renderFont,'base64'),{subset:true});}
   catch {fail('unsupported_font','Configure a supported licensed TrueType or OpenType rendering font.');}
  } else font=await doc.embedFont(StandardFonts.Helvetica);
  if(r.renderFont!==undefined) renderFontName=font.name.replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,128);
  const coverage=new Set(font.getCharacterSet());
  const checkGlyphs=(text:string,name:string)=>{if([...text.replace(/[\r\n]/g,'')].some(c=>!coverage.has(c.codePointAt(0)!)))fail('unsupported_glyph','Configure a licensed rendering font covering this field, or choose another supported template.',name);};
  for(const [name,value] of Object.entries(values)) {
   try {
   const f=fields.find(f=>f.getName()===name); if(!f) fail('unknown_field','Inspect the current PDF and choose an existing field name.',name);
   if(f.isReadOnly() || f instanceof PDFSignature || (f instanceof PDFTextField && f.isPassword())) fail('unsupported_field','Choose an editable non-credential field; preserve signed originals.',name);
   if(f instanceof PDFTextField) {
    if(typeof value!=='string') fail('field_type','Supply text for this text field.',name);
    if(value.length>4096 || (f.getMaxLength()!==undefined && value.length>f.getMaxLength()!)) fail('field_overflow','Shorten this field or select a template with sufficient space.',name);
    checkGlyphs(value,name);
    const lines=value.split(/\r?\n/); if(!f.isMultiline() && lines.length>1) fail('field_overflow','Use one line or choose a multiline template field.',name);
    const da=f.acroField.getDefaultAppearance()??'';
    const sizes=[...da.matchAll(/\/[^\s]+\s+([\d.]+)\s+Tf\b/g)];
    const size=Number(sizes.at(-1)?.[1]);
    if(!Number.isFinite(size)||size<=0) fail('unsupported_field','Set a positive explicit font size in the source template.',name);
    // Measure the actual preserved template size; never shrink to conceal overflow.
    for(const w of f.acroField.getWidgets()) { const rect=w.getRectangle(); if(lines.some(l=>font.widthOfTextAtSize(l,size)>rect.width-4) || lines.length*size*1.2>rect.height-4) fail('field_overflow','Shorten this field or select a template with sufficient space.',name); }
    f.setText(value); f.setFontSize(size); f.updateAppearances(font);
   } else if(f instanceof PDFCheckBox) {if(typeof value!=='boolean') fail('field_type','Supply true or false for this checkbox.',name);value?f.check():f.uncheck();}
   else if(f instanceof PDFDropdown || f instanceof PDFOptionList) {
    const selected=typeof value==='string'?[value]:value;
    if(!Array.isArray(selected) || !selected.every(v=>typeof v==='string' && f.getOptions().includes(v)) || (!f.isMultiselect() && selected.length>1)) fail('field_type','Choose only the available options and respect single-selection fields.',name);
    for(const text of f instanceof PDFOptionList?f.getOptions():selected) checkGlyphs(text,name);
    f.select(selected as string[]); f.updateAppearances(font);
   } else fail('unsupported_field','Choose a supported text, checkbox or selection field.',name);
   } catch(error) {if(error instanceof ValidationFailure)throw error;fail('unsupported_field','Inspect this field and choose a supported editable template field.',name);}
  }
 }
 if(r.operation==='overlay') {
  if(editingCapabilities.overlay!=='supported')fail('unsupported_pdf','Preserve signed/signature or credential-bearing originals; choose a safe unsigned source.');
  const geometry=pages[r.pageIndex];if(!Number.isInteger(r.pageIndex)||!geometry)fail('invalid_page','Choose an actual zero-based page from document.inspect.');
  const placements=r.placements;
  if(!Array.isArray(placements)||placements.length<1||placements.length>128)fail('invalid_placement','Supply 1 to 128 bounded text placements.');
  let font;
  if(r.renderFont!==undefined) {
   if(typeof r.renderFont!=='string'||r.renderFont.length>6*1024*1024)fail('unsupported_font','Configure a bounded licensed rendering font.');
   try {doc.registerFontkit(fontkit);font=await doc.embedFont(Buffer.from(r.renderFont,'base64'),{subset:true});}
   catch {fail('unsupported_font','Configure a supported licensed TrueType or OpenType font.');}
   renderFontName=font.name.replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,128);
  } else font=await doc.embedFont(StandardFonts.Helvetica);
  const coverage=new Set(font.getCharacterSet()),toPdf=inverse(geometry.pdfToPage),page=doc.getPage(r.pageIndex);
  for(const p of placements) {
   if(!p||p.type!=='text'||typeof p.value!=='string'||p.value.length>4096||/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(p.value)||!Number.isFinite(p.fontSize)||p.fontSize<1||p.fontSize>144)fail('invalid_placement','Supply literal text, a font size from 1 to 144 points, and a bounded box.');
   const b=p.box;
   if(!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>geometry.pagePoints.width+1e-7||b.y+b.height>geometry.pagePoints.height+1e-7)fail('placement_bounds','Keep every placement inside the displayed page CropBox.');
   if([...p.value.replace(/\n/g,'')].some(c=>!coverage.has(c.codePointAt(0)!)))fail('unsupported_glyph','Configure a licensed rendering font covering the literal text.');
   const lines=p.value.split('\n'),size=p.fontSize;
   const ascent=font.heightAtSize(size,{descender:false}),height=font.heightAtSize(size),stride=Math.max(size*1.2,height);
   if(lines.some((line:string)=>font.widthOfTextAtSize(line,size)>b.width)||height+(lines.length-1)*stride>b.height)fail('field_overflow','Enlarge the explicit box or shorten text; text is never silently shrunk or clipped.');
   for(let i=0;i<lines.length;i++) {
    const [x,y]=transform(toPdf,b.x,b.y+ascent+i*stride);
    page.drawText(lines[i],{x,y,font,size:size/geometry.userUnit,rotate:degrees(geometry.rotation),lineHeight:stride/geometry.userUnit});
   }
  }
 }
 const metadata={editingCapabilities,pages,limits:{inputPdfBytes:8*1024*1024,outputPdfBytes:8*1024*1024,pages:100,fields:256,placements:128,workerEnvelopeBytes:MAX,fontBytes:4*1024*1024},fields:descriptions(),appearanceValidated:false,semanticVerification:false,missingRequiredFields:fields.filter(f=>f.isRequired()&&((f instanceof PDFTextField&&!f.getText())||(f instanceof PDFCheckBox&&!f.isChecked())||((f instanceof PDFDropdown||f instanceof PDFOptionList)&&f.getSelected().length===0))).map(f=>f.getName())};
 const issues=metadata.missingRequiredFields.map(field=>({code:'missing_required_field',field:field.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,128),nextAction:'Supply the missing required field before treating this document as complete.'}));
 if(r.operation==='inspect') return {metadata,issues};
 if(r.operation==='export') {
  if(r.flatten!==true) throw Error('Export requires explicit flatten true');
  if(fields.some(f=>f instanceof PDFSignature || (f instanceof PDFTextField && f.isPassword()))) throw Error('Signature or credential export unsupported');
  form.flatten({updateFieldAppearances:false});
 }
 const output=await doc.save(); if(output.length>8*1024*1024) throw Error('Output too large');
 return {metadata,issues,renderFontName,pdf:Buffer.from(output).toString('base64')};
}
let size=0;const chunks:Buffer[]=[];
for await(const chunk of process.stdin) {size+=chunk.length;if(size>MAX) throw Error('Request too large');chunks.push(chunk);}
try {const result=await run(JSON.parse(Buffer.concat(chunks).toString('utf8'))); const out=JSON.stringify(result);if(Buffer.byteLength(out)>MAX)throw Error('Response too large');process.stdout.write(out);}
catch(error) {const issue=error instanceof ValidationFailure?{code:error.code,field:error.field,nextAction:error.nextAction}:{code:'unsupported_pdf',nextAction:'Choose a bounded supported unsigned PDF without active content; inspect the template before retrying.'};process.stdout.write(JSON.stringify({issues:[issue],error:'Document validation blocked this operation; no output published.'}));}
