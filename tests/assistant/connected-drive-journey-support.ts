// Normal-client journey driver and invented-data oracles. No tool dispatch or authentication.
import type {AccountClient,PreparationStatus} from '../../core/account/client.js';
import type {PreparationRequest,PreparationReceipt} from '../../core/preparation/types.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {PDFDocument, StandardFonts} from 'pdf-lib';

export type Outcome = 'PASS'|'FAIL'|'BLOCKED'|'UNRUN';
export interface Check {id:string; status:Outcome; detail:string; evidence?:string[]}
export const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export const journeyOracles=[
 'request_and_terminal_session','selected_root_discovery_read_source_refs',
 'model_ocr_text_page_regions','photo_decoded_pixels_format_dimensions',
 'pdf_fields_or_overlay_and_render','model_selected_drive_upload',
 'generated_artifacts_and_sanitized_session_bundle','drive_parent_version_hash_readback',
 'user_correction_new_revision','originals_and_prior_revisions_unchanged',
 'changed_input_without_orchestration_changes','failure_isolation_restart',
] as const;

/** Not an agent fixture: generates a new blank invented form, then sample oracle bytes.
 * No private form answers are guessed. Unknown fields remain empty. */
export async function inventedPdf(value:string):Promise<Uint8Array> {
 const pdf=await PDFDocument.create();
 pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
 const page=pdf.addPage([400,300]),font=await pdf.embedFont(StandardFonts.Helvetica);
 page.drawText('Invented workshop application - oracle fixture only',{x:20,y:270,size:12,font});
 const form=pdf.getForm(),reference=form.createTextField('workshop_reference');
 reference.addToPage(page,{x:20,y:200,width:300,height:30,font});reference.setText(value);
 form.createTextField('unresolved_do_not_invent').addToPage(page,{x:20,y:140,width:300,height:30,font});
 form.updateFieldAppearances(font);return pdf.save();
}
export async function assertPdf(bytes:Uint8Array,expected:Readonly<Record<string,string>>):Promise<void> {
 const pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>0);
 for(const [name,value] of Object.entries(expected))assert.equal(pdf.getForm().getTextField(name).getText()??'',value,`PDF field ${name}`);
 // Appearance/render correctness is a separate UNRUN oracle, not implied by field text.
}

/** Independent local decode of READBACK bytes, not a task tool or a metadata assertion.
 * Trusted host selects an existing Pillow interpreter; no installation/model/files/network.
 * Pixel samples can check known crop/background facts; visual quality remains separate. */
export function assertPhoto(bytes:Uint8Array,expected:{width:number;height:number;mimeType:'image/png'|'image/jpeg';maxBytes:number;pixels?:{x:number;y:number;rgb:[number,number,number];maxDelta?:number}[]},pythonExecutable=process.platform==='win32'?'python.exe':'python3'):void {
 assert.ok(Number.isSafeInteger(expected.maxBytes)&&expected.maxBytes>0&&bytes.length>0&&bytes.length<=Math.min(expected.maxBytes,32*1024*1024),'Photo byte limit');
 assert.ok([expected.width,expected.height].every(n=>Number.isSafeInteger(n)&&n>0));
 const pixels=expected.pixels??[];assert.ok(pixels.length<=100);
 for(const p of pixels){assert.ok(Number.isSafeInteger(p.x)&&Number.isSafeInteger(p.y)&&p.x>=0&&p.y>=0&&p.x<expected.width&&p.y<expected.height);assert.ok(p.rgb.every(v=>Number.isInteger(v)&&v>=0&&v<=255));}
 const env:NodeJS.ProcessEnv={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
 const code="from PIL import Image,ImageOps; import io,sys,json,warnings; Image.MAX_IMAGE_PIXELS=33554432; warnings.simplefilter('error',Image.DecompressionBombWarning); im=Image.open(io.BytesIO(sys.stdin.buffer.read())); fmt=im.format; frames=getattr(im,'n_frames',1); assert 0<im.width<=16384 and 0<im.height<=16384 and im.width*im.height<=33554432; im.load(); im=ImageOps.exif_transpose(im); rgb=im.convert('RGB'); points=json.loads(sys.argv[1]); print(json.dumps({'format':fmt,'frames':frames,'width':im.width,'height':im.height,'pixels':[list(rgb.getpixel((p['x'],p['y']))) for p in points]}))";
 const decoded=record(JSON.parse(execFileSync(pythonExecutable,['-E','-c',code,JSON.stringify(pixels.map(({x,y})=>({x,y})))],{input:Buffer.from(bytes),env,maxBuffer:16384,timeout:15000,stdio:['pipe','pipe','pipe']}).toString('utf8')));
 assert.equal(decoded.frames,1);assert.equal(decoded.width,expected.width);assert.equal(decoded.height,expected.height);
 assert.equal(decoded.format,expected.mimeType==='image/png'?'PNG':'JPEG','Photo decoded format differs');
 assert.ok(Array.isArray(decoded.pixels));assert.equal(decoded.pixels.length,pixels.length);
 for(let i=0;i<pixels.length;i++){const actual=decoded.pixels[i];assert.ok(Array.isArray(actual)&&actual.length===3);const delta=pixels[i].maxDelta??0;assert.ok(Number.isFinite(delta)&&delta>=0);
  for(let channel=0;channel<3;channel++)assert.ok(Math.abs(Number(actual[channel])-pixels[i].rgb[channel])<=delta,'Photo decoded pixel differs');
 }
}

/** Independent connector readback must supply actual bytes, not just HTTP200/metadata.
 * Caller must obtain this through the authenticated selected-root connector, not a tool reply. */
export function assertDriveReadback(generated:Uint8Array,expected:{rootId:string;id:string;version:string;mimeType:string},readback:{id:string;version:string;mimeType:string;parents:string[];bytes:Uint8Array}) {
 assert.equal(readback.id,expected.id);assert.equal(readback.version,expected.version);
 assert.equal(readback.mimeType,expected.mimeType);assert.deepEqual(readback.parents,[expected.rootId]);
 assert.equal(sha256(readback.bytes),sha256(generated),'Drive readback differs from generated bytes');
}

export interface JourneyBinding {
 /** Host attestation of the RUNNING service, not this harness checkout. */
 sourceHead:string;sourceTree?:string;buildIdentity:string;buildDigest:string;
 models:{endpoint:string;globalLimitUsd:number;maximumWholeTaskReservationUsd:number;decision:{modelId:string;inputContextTokens:number;maxOutputTokens:number};vision:{modelId:string;inputContextTokens:number;maxOutputTokens:number;imageTokensUpperBound:number;imageAccounting:'input-tokens'}};
 decisionConfigDigest:string;visionConfigDigest:string;
 limits:{limitUsd:number;maximumDecisionCalls:number;maximumVisionCalls:number};
}
export interface RetainedArtifact {id:string;mimeType:string;sha256:string;bytes:Uint8Array}
export interface JourneyCheckpoint {
 phase:string;request:PreparationRequest;configuration?:unknown;receipt?:PreparationReceipt;latest?:PreparationStatus;
 /** All observed states, including blocked/uncertain and before a correction. */
 statuses:PreparationStatus[];artifacts:RetainedArtifact[];
}
export interface JourneyOptions {
 ownerId:string;binding:JourneyBinding;
 request:PreparationRequest & {saveOutputs:false};
 /** Operational polling bound, NOT an owner whole-job deadline. No implicit resume/cancel at exhaustion. */
 maxPolls:number;pollIntervalMs:number;signal?:AbortSignal;
 /** Trusted host stores checkpoints/artifacts locally; this driver never writes/uploads evidence. */
 checkpoint:(value:JourneyCheckpoint)=>Promise<void>;
 /** Real user correction in live use, after inspection; not an answer fed to a tool. */
 correction:(status:PreparationStatus,artifacts:readonly RetainedArtifact[])=>Promise<{fieldId:string;value:string}|undefined>;
 /** Host's private source/PDF/photo/render oracle. It must inspect actual bytes, not HTTP200. */
 verifyRevision:(status:PreparationStatus,artifacts:readonly RetainedArtifact[])=>Promise<Check[]>;
}
export interface JourneyResult {
 driverStatus:'PASS'|'FAIL'|'BLOCKED'|'CANCELLED';acceptanceStatus:'UNRUN';
 binding:JourneyBinding;checkpoint:JourneyCheckpoint;checks:Check[];
 /** Exact observed exception retained in memory for host reconciliation; never auto-log provider bodies. */
 error?:unknown;reason?:string;
}
function record(value:unknown):Record<string,unknown> {
 assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value),'Expected protocol object');
 return Object.fromEntries(Object.entries(value));
}
function records(value:unknown):Record<string,unknown>[] {assert.ok(Array.isArray(value),'Expected protocol array');return value.map(record);}
function sessionExports(session:unknown) {
 return records(record(session).results).filter(r=>r.status==='ok'&&r.data!==null&&typeof r.data==='object'&&!Array.isArray(r.data)&&record(r.data).kind==='spindle.session-export.v1');
}
function callIdentity(call:Record<string,unknown>) {return JSON.stringify([call.runId,call.cursor,call.reservation]);}
function digest(value:unknown) {assert.equal(typeof value,'string');assert.match(String(value),/^[a-f0-9]{64}$/);}
function usage(value:unknown) {const u=record(value);for(const k of ['inputTokens','outputTokens'])assert.ok(Number.isSafeInteger(u[k])&&Number(u[k])>=0,'Invalid usage');}
function modelEvidence(status:PreparationStatus,b:JourneyBinding,requireComplete:boolean) {
 const s=record(status.session);assert.equal(s.kind,'spindle.visible-session.v1');
 assert.equal(s.taskId,status.taskId);assert.equal(s.revision,status.revision);assert.equal(s.buildIdentity,b.buildIdentity);
 assert.deepEqual(s.sourceIdentity,{revision:b.sourceHead,...(b.sourceTree?{tree:b.sourceTree}:{})},'Session source identity differs');
 assert.equal(s.mode,'local_draft');assert.equal(s.saveOutputs,false);
 const calls=records(s.modelCalls),vision=records(s.visionCalls),budget=record(s.budget);
 for(const [k,v] of Object.entries(b.limits))assert.equal(budget[k],v,`Session budget ${k}`);
 assert.ok(Number.isFinite(budget.reservedUsd)&&Number(budget.reservedUsd)>=0&&Number(budget.reservedUsd)<=b.limits.limitUsd,'Invalid accounted budget');
 assert.equal(budget.decisionCalls,calls.length);assert.equal(budget.visionCalls,vision.length);
 assert.ok(calls.length<=b.limits.maximumDecisionCalls&&vision.length<=b.limits.maximumVisionCalls,'Call cap exceeded');
 const keys=new Set<string>();
 for(const c of calls){assert.equal(c.model,b.models.decision.modelId);assert.equal(c.configDigest,b.decisionConfigDigest);
  assert.equal(typeof c.runId,'string');assert.ok(Number.isSafeInteger(c.cursor)&&Number(c.cursor)>=0);assert.ok(Number.isSafeInteger(c.reservation)&&Number(c.reservation)>0);
  const key=callIdentity(c);assert.ok(!keys.has(key),'Duplicate model envelope');keys.add(key);
  if(requireComplete){assert.equal(c.responsePersisted,true,'Uncertain model response');usage(c.usage);record(c.decision);}
 }
 for(const c of vision){assert.equal(c.model,b.models.vision.modelId);assert.equal(c.configDigest,b.visionConfigDigest);digest(c.inputHash);
  assert.equal(typeof c.id,'string');assert.ok(records(status.sources).some(source=>Array.isArray(c.sourceIds)&&c.sourceIds.includes(source.id)),'Vision source not in task');
  assert.ok(status.artifacts.some(a=>a.id===c.inputArtifactId),'Vision input not readable');
  if(requireComplete){assert.equal(c.status,'completed','Uncertain/failed vision operation');usage(c.usage);}
 }
 if(requireComplete){
  assert.ok(calls.length>0&&vision.length>0,'No decision/vision evidence; not a live preparation proof');
  assert.ok(records(s.results).length>0,'Missing actual tool results');
  assert.ok(calls.some(c=>['tool','batch'].includes(String(record(c.decision).kind))),'No model-selected tool decision');
  for(const r of records(s.results)){assert.equal(typeof r.callId,'string');assert.ok(['ok','failed','needs_input'].includes(String(r.status)));}
 }
 return s;
}
function assertLocalStatus(s:PreparationStatus,request:PreparationRequest,receipt:PreparationReceipt) {
 assert.equal(s.taskId,receipt.taskId);assert.equal(s.revision,receipt.revision);assert.equal(s.request,request.request);
 assert.equal(s.mode,'local_draft');assert.equal(s.saveOutputs,false);assert.deepEqual(s.outputs,[],'Local draft must not create Drive outputs');
 assert.ok(['working','ready','blocked','cancelled'].includes(s.state),'Unknown preparation state');
}

/** Explicit trusted-host entrypoint. Pass the already authenticated NORMAL AccountClient.
 * No credential discovery, OAuth, generic request(), task tools, runtime, journal or retry path.
 * PASS proves only this driver's protocol checks; full model/source/visual acceptance stays UNRUN.
 */
export async function runLocalDraftJourney(client:AccountClient,options:JourneyOptions):Promise<JourneyResult> {
 const cp:JourneyCheckpoint={phase:'preflight',request:structuredClone(options.request),statuses:[],artifacts:[]},checks:Check[]=[];
 const cancelled=Symbol('explicit_user_cancellation');
 const result=(driverStatus:JourneyResult['driverStatus'],reason?:string,error?:unknown):JourneyResult=>({driverStatus,acceptanceStatus:'UNRUN',binding:options.binding,checkpoint:structuredClone(cp),checks,reason,error});
 const save=async(phase:string)=>{cp.phase=phase;await options.checkpoint(structuredClone(cp));};
 const owner=()=>assert.equal(client.account?.id,options.ownerId,'Authenticated owner changed');
 const cancel=async()=>{
  if(!options.signal?.aborted)return false;
  if(cp.receipt){owner();const r=await client.cancelPreparation(cp.receipt.taskId);assert.equal(r.taskId,cp.receipt.taskId);assert.equal(r.state,'cancelled');cp.receipt=r;}
  await save('cancelled');return true;
 };
 try {
  owner();assert.equal(options.request.processingConsent,true);assert.equal(options.request.saveOutputs,false,'This entrypoint is local draft only');
  assert.ok(Number.isSafeInteger(options.maxPolls)&&options.maxPolls>0);assert.ok(Number.isSafeInteger(options.pollIntervalMs)&&options.pollIntervalMs>=0);
  assert.match(options.binding.sourceHead,/^[a-f0-9]{40}$/);digest(options.binding.buildDigest);digest(options.binding.decisionConfigDigest);digest(options.binding.visionConfigDigest);
  assert.ok(options.binding.buildIdentity.length>0);await save('preflight');
  if(await cancel())return result('CANCELLED');
  owner();const configuration=await client.preparationConfiguration();cp.configuration=structuredClone(configuration);await save('configuration_observed');
  const metadata=record(configuration);assert.equal(metadata.buildIdentity,options.binding.buildIdentity,'Running build differs');
  assert.deepEqual(metadata.sourceIdentity,{revision:options.binding.sourceHead,...(options.binding.sourceTree?{tree:options.binding.sourceTree}:{})},'Running source differs');
  assert.deepEqual(metadata.readiness,{credentials:'lazy_not_checked',processing:'explicit_request_consent_required',writePermission:'not_assumed',liveAcceptance:'unverified'},'Configuration is not live acceptance or credential readiness');
  assert.equal(configuration.configured,true);assert.equal(configuration.requiresProcessingConsent,true);
  assert.ok(configuration.modes.includes('local_draft'));assert.deepEqual(configuration.models,options.binding.models,'Running model caps differ');
  assert.deepEqual(configuration.limits,options.binding.limits,'Running model budget differs');await save('configured');
  if(await cancel())return result('CANCELLED');
  owner();cp.receipt=await client.prepareApplication(options.request);assert.ok(cp.receipt.taskId);assert.ok(Number.isSafeInteger(cp.receipt.revision)&&cp.receipt.revision>0);
  await save('admitted');
  const poll=async():Promise<'ready'|'blocked'|'cancelled'|'poll_limit'>=>{
   for(let i=0;i<options.maxPolls;i++){
    if(await cancel())return 'cancelled';owner();
    const s=await client.preparationTask(cp.receipt!.taskId);cp.latest=structuredClone(s);cp.statuses.push(structuredClone(s));
    // Retain even a contradictory state before asserting it.
    await save('observed');assertLocalStatus(s,options.request,cp.receipt!);
    if(s.state==='cancelled')return 'cancelled';
    if(s.recovery!=='clean'||s.state==='blocked')return 'blocked';
    if(s.state==='ready'){
     assert.ok(!s.blocker,'Ready with blocker');assert.ok(s.checklist.items.every(i=>['done','skipped'].includes(i.state)),'Incomplete checklist');
     assert.ok(s.fields.length>0&&s.fields.every(f=>!f.unresolved),'Unresolved fields');modelEvidence(s,options.binding,true);return 'ready';
    }
    if(i+1<options.maxPolls)await new Promise<void>(resolve=>{
     const done=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolve();};
     const timer=setTimeout(done,options.pollIntervalMs);options.signal?.addEventListener('abort',done,{once:true});if(options.signal?.aborted)done();
    });
   }
   await save('poll_limit');return 'poll_limit';
  };
  const artifacts=async(s:PreparationStatus)=>{
   const all:RetainedArtifact[]=[];const ids=new Set<string>();
   for(const a of s.artifacts){if(await cancel())throw cancelled;owner();assert.ok(!ids.has(a.id),'Duplicate artifact');ids.add(a.id);digest(a.sha256);
    const r=await client.preparationArtifact(s.taskId,a.id);
    assert.equal(r.mimeType,a.mimeType,'Artifact MIME mismatch');assert.equal(r.bytes.length,a.bytes,'Artifact length mismatch');assert.equal(sha256(r.bytes),a.sha256,'Corrupt artifact');
    const retained={id:a.id,mimeType:a.mimeType,sha256:a.sha256,bytes:r.bytes.slice()};all.push(retained);
    if(!cp.artifacts.some(old=>old.id===a.id))cp.artifacts.push(retained);await save('artifact_verified');
   }
   const sources=records(s.sources);assert.ok(sources.some(source=>source.provider==='drive'),'No selected Drive source observed');
   for(const source of sources){digest(source.sha256);const snapshot=all.find(a=>a.id===source.snapshotArtifactId);assert.ok(snapshot,'Source snapshot not readable');assert.equal(snapshot.sha256,source.sha256,'Source snapshot hash differs');
    if(source.provider==='drive'){assert.equal(typeof source.providerId,'string');assert.equal(typeof source.providerVersion,'string');}
   }
   const exports=sessionExports(s.session);
   assert.ok(exports.length>0,'No generated session export');let current=false;
   const exportIds=new Set(exports.map(e=>record(e.data).artifactId)),sourceIds=new Set(sources.map(source=>source.snapshotArtifactId));
   for(const e of exports){const data=record(e.data),artifact=all.find(a=>a.id===data.artifactId);assert.ok(artifact,'Session export not readable');assert.equal(artifact.sha256,data.sha256);
    const exported=record(JSON.parse(new TextDecoder().decode(artifact.bytes)));
    assert.equal(exported.kind,'spindle.visible-session.v1');assert.equal(exported.taskId,s.taskId);assert.equal(exported.buildIdentity,options.binding.buildIdentity);
    assert.deepEqual(exported.sourceIdentity,{revision:options.binding.sourceHead,...(options.binding.sourceTree?{tree:options.binding.sourceTree}:{})},'Export source differs');
    assert.equal(exported.mode,'local_draft');assert.equal(exported.saveOutputs,false);assert.deepEqual(exported.outputs,[]);
    const cutoff=record(exported.cutoff),results=records(exported.results),calls=records(exported.modelCalls);
    assert.ok(Number.isSafeInteger(cutoff.cursor)&&Number(cutoff.cursor)>=0);assert.equal(cutoff.observations,results.length);assert.equal(typeof cutoff.description,'string');
    assert.ok(records(exported.messages).some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.length>0),'Session export lacks user message');
    assert.ok(calls.length>0,'Session export lacks model calls');
    for(const c of calls){assert.equal(c.model,options.binding.models.decision.modelId);assert.equal(c.configDigest,options.binding.decisionConfigDigest);assert.equal(c.responsePersisted,true);usage(c.usage);}
    if(exported.revision===s.revision){
     const covered=results.flatMap(r=>records(r.artifacts));
     assert.ok(all.filter(a=>!sourceIds.has(a.id)&&!exportIds.has(a.id)).every(a=>covered.some(c=>c.id===a.id&&c.sha256===a.sha256)),'Current session export omits prepared artifact evidence');
     current=true;
    }
   }
   assert.ok(current,'Current revision session export missing');
   const verified=await options.verifyRevision(structuredClone(s),structuredClone(all));checks.push(...verified);
   assert.ok(verified.length>0&&verified.every(c=>c.status==='PASS'),'Host artifact oracle not satisfied');return all;
  };
  let state=await poll();if(state!=='ready')return result(state==='cancelled'?'CANCELLED':'BLOCKED',state);
  if(await cancel())return result('CANCELLED');
  const first=cp.latest!,earlier=await artifacts(first);await save('awaiting_user_correction');
  if(await cancel())return result('CANCELLED');
  const correction=await options.correction(structuredClone(first),structuredClone(earlier));
  if(await cancel())return result('CANCELLED');
  if(!correction)return result('BLOCKED','User correction not supplied');
  const field=first.fields.find(f=>f.id===correction.fieldId);assert.ok(field,'Unknown correction field');assert.notEqual(correction.value,field.value,'Correction must change the value');
  owner();const corrected=await client.correctPreparation({taskId:first.taskId,expectedRevision:first.revision,...correction});
  cp.receipt=corrected;await save('correction_admitted');assert.equal(corrected.taskId,first.taskId);assert.equal(corrected.revision,first.revision+1);
  state=await poll();if(state!=='ready')return result(state==='cancelled'?'CANCELLED':'BLOCKED',state);
  const latest=cp.latest!,correctedField=latest.fields.find(f=>f.id===correction.fieldId);
  assert.equal(correctedField?.value,correction.value,'Correction lost');assert.equal(correctedField?.corrected,true,'Explicit correction marker lost');
  for(const field of first.fields)if(field.id!==correction.fieldId){const next=latest.fields.find(f=>f.id===field.id);assert.ok(next,'Unrelated field removed');assert.equal(next.value,field.value,'Unrelated field changed');assert.equal(next.unresolved,field.unresolved);}
  for(const source of records(first.sources)){const next=records(latest.sources).find(s=>s.id===source.id);assert.ok(next,'Earlier source reference removed');
   for(const key of ['id','provider','accountId','providerId','providerVersion','sha256','snapshotArtifactId'])assert.equal(next[key],source[key],`Earlier source ${key} changed`);
  }
  const after=await artifacts(latest);
  const priorCalls=new Set(records(record(first.session).modelCalls).map(callIdentity));
  assert.ok(records(record(latest.session).modelCalls).some(c=>!priorCalls.has(callIdentity(c))),'No new model decision after correction');
  const exportIds=new Set(sessionExports(latest.session).map(e=>record(e.data).artifactId));
  const sourceIds=new Set(records(latest.sources).map(s=>s.snapshotArtifactId));
  assert.ok(after.some(a=>!exportIds.has(a.id)&&!sourceIds.has(a.id)&&!earlier.some(old=>old.id===a.id||old.sha256===a.sha256)),'No new immutable prepared artifact bytes');
  for(const old of earlier){const a=after.find(a=>a.id===old.id);assert.ok(a,'Earlier artifact no longer readable');assert.equal(a.sha256,old.sha256,'Earlier artifact mutated');assert.deepEqual(a.bytes,old.bytes,'Earlier bytes mutated');}
  checks.push({id:'normal_client_revision_and_immutable_readback',status:'PASS',detail:'Normal request/status/artifact/correction only; earlier bytes re-read unchanged. Not full source/model/visual acceptance.'});
  await save('driver_complete');return result('PASS');
 }catch(error){
  if(error===cancelled)return result('CANCELLED');
  // Never re-submit/resume/retry uncertain writes, including lost request/correction/cancel acknowledgements.
  cp.phase='failed';return result('FAIL','Observed client/protocol/oracle failure; reconcile retained checkpoint before any explicit next action',error);
 }
}
