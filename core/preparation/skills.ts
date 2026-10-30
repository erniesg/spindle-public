import type {ToolDefinition,Schema} from '../agent/contracts.js';
/** Reusable, versioned playbooks the model loads on demand (procedural knowledge, not authority).
 * Tools still enforce every bound; a skill only says which registered tools to use, in what order, and what to check. */
export interface Skill {name:string;version:string;summary:string;instructions:string}
export const preparationSkills:readonly Skill[]=Object.freeze([
 {name:'application-photo',version:'2',summary:'Prepare an ID/passport/application photo to an exact spec (size, head proportion, white background, touch-ups).',instructions:`
1. Spec. Use the exact size/proportions the request states. If it names a document or agency but no numbers, web.search a generic public query (e.g. "<country> <agency> passport photo requirements pixels"; never names, ID numbers or other personal data), prefer official government sites, web.open_result, and extract: output width x height in pixels, head height (top of hair to chin) as a percent of photo height, top margin, background colour. If nothing reliable is found use 400x514 px, headHeight 70, topMargin 10, white, and say so. Record the spec and its source URL in your result.
2. Source. Use the user's original portrait from discovery (not files marked spindleOutput, not the passbook or form).
3. image.remove_background on the original.
4. image.inspect THAT result with focus "face box from hairline to chin; blemish box". Its sourceBox values are pixels of that image.
5. Touch-ups: official ID/passport photos generally must not be digitally altered (e.g. ICA). Only retouch if the request explicitly asks; then image.retouch with a mask around each blemish and no cloneFrom (spot inpaint replaces only blemish-like pixels and leaves features such as nostrils untouched; if it reports no blemish found, re-inspect rather than forcing fill box). Mention the no-alteration rule in your result.
6. image.fit_photo on the retouched image: faceBox from step 4, width/height/headHeight/topMargin/backgroundRGB from the spec, format JPEG, maxBytes if the spec has a file-size limit.
7. image.verify the output with width, height, format and maxBytes. Check fitPhoto.achievedHeadHeightPercent is within the spec.
8. If saving is enabled: drive.create_artifact the final photo with a descriptive name, session.export, drive.create_artifact the session export, then ready. Otherwise draft.export/session.export, then ready.`},
 {name:'read-document',version:'3',summary:'Read values (names, ID/account numbers) from a photographed or scanned document accurately.',instructions:`
1. image.inspect the document photo (focus: "<what you need, e.g. account details block>") to find where the text is.
2. ocr.document with region (canonical pixels from inspect canonicalBox, generous margin), rotation "auto" (measured deskew; it retries upside-down automatically) and focus (what to read). Only pass a numeric rotation if auto clearly failed. Reading the whole photo is a last resort: small text needs the zoomed, full-resolution read.
3. If spans come back empty or garbled, widen or tighten the region and read again (at most 3 tries).
4. Spans marked unresolved mean the two readers disagreed: keep that value unresolved (do not guess between I/1, B/E, O/0). record_fields also refuses NRIC/FIN values that fail their check letter and names a letter or two away from a name the owner saved: record those unresolved too, never edit characters or substitute the saved name.
5. preparation.record_fields with each value and its OCR citation before using it anywhere else: one field per value (e.g. each joint account holder separately), the value copied verbatim from a resolved span; mark disagreed values unresolved with an empty value.`},
 {name:'fill-form',version:'3',summary:'Fill a PDF form (fillable or flat) with recorded, cited values and verify the result.',instructions:`
1. document.inspect the form. If editingCapabilities.fieldEditing is supported, map recorded fields to editableFieldNames and use document.edit.
2. Flat PDF (no editable fields): document.layout for each page you will fill. It lists printed text lines with positions, underlines and character-box rows (page points). Decide which recorded value belongs to which printed label from the form's own wording.
3. document.fill_by_label with inputId, pageIndex and entries [{label, value}] using the label text exactly as printed (e.g. "NRIC (individual)", "Account No.", "Name of Account Holder(s)"). Code finds the label and writes on the nearest underline or one character per box (separators are dropped for boxes). Add place ("right","below","boxes","line") or occurrence only if the result shows a wrong target. One call per page; chain the output PDF for the next page.
4. Only use values already recorded with preparation.record_fields; leave unresolved fields blank. Where one printed line holds several values (e.g. joint holders' names or NRICs), pass one entry whose value joins the recorded values with ", "; every part must be a recorded value. If a call is refused, change the arguments: re-sending the same call stops the task. Never fill signature, date of signing, banker-only or office-use sections, and never invent values (e.g. bank or branch codes) that no source states.
5. document.render the filled page and image.inspect it to confirm each value sits on the right line or boxes; fix and refill from the original form if not.
6. Save: draft.export (and drive.create_artifact when saving is enabled), session.export, then ready.`},
]);
const names=preparationSkills.map(s=>s.name);
const schema:Schema={jsonSchema:{type:'object',properties:{name:{enum:names,description:preparationSkills.map(s=>`${s.name}: ${s.summary}`).join(' | ')}},required:['name'],additionalProperties:false},parse(v:unknown){const a=v as {name?:unknown};if(!a||typeof a!=='object'||Object.keys(a).join()!=='name'||typeof a.name!=='string'||!names.includes(a.name))throw Error(`Expected {name} one of ${names.join(', ')}`);return a;}};
const output:Schema={jsonSchema:{type:'object'},parse:(v:unknown)=>v};
/** Read-only tool returning a skill playbook; loading changes nothing. */
export function createSkillTool(skills:readonly Skill[]=preparationSkills):ToolDefinition {
 return {name:'skill.load',version:'1',effect:'read',capabilities:[],inputSchema:schema,outputSchema:output,async invoke(value,ctx){
  const {name}=schema.parse(value) as {name:string};const skill=skills.find(s=>s.name===name)!;
  return {callId:ctx.callId,status:'ok',data:{name:skill.name,version:skill.version,instructions:skill.instructions.trim()},artifacts:[],evidence:[],observations:[`Skill ${skill.name} v${skill.version} loaded; follow it with the registered tools.`]};
 }};
}
