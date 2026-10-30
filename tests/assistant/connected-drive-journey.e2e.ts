// Deterministic scripted HTTP machinery for the SAME normal-client driver. Never live acceptance.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AccountClient,AccountRequestFailure,type PreparationStatus} from '../../core/account/client.js';
import {assertDriveReadback,assertPdf,assertPhoto,inventedPdf,journeyOracles,runLocalDraftJourney,sha256,
 type Check,type JourneyBinding,type JourneyCheckpoint,type JourneyOptions,type JourneyResult} from './connected-drive-journey-support.js';

const args=process.argv.slice(2);
if(args.length!==3||!['--fixture','--readiness','--live'].includes(args[0])||args[1]!=='--output'||!isAbsolute(args[2])) {
 console.error('Usage: connected-drive-journey.e2e.js --fixture|--readiness|--live --output /absolute/NEW-run-directory');process.exit(2);
}
const mode=args[0].slice(2),output=resolve(args[2]);await mkdir(output,{mode:0o700});
const checks:Check[]=[],startedAt=new Date().toISOString();
async function check(id:string,action:()=>Promise<void>|void,detail:string) {
 try{await action();checks.push({id,status:'PASS',detail});}
 catch(error){checks.push({id,status:'FAIL',detail:`${detail}: ${error instanceof Error?error.message:'Unknown failure'}`});}
}
const git=(...argv:string[])=>execFileSync('git',argv,{encoding:'utf8'}).trim();
async function fileHashes(root:string,prefix=''):Promise<Record<string,string>> {
 const result:Record<string,string>={};
 for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const name=prefix+entry.name;
  if(entry.isDirectory())Object.assign(result,await fileHashes(join(root,entry.name),name+'/'));
  else if(entry.isFile()&&/\.(js|html|css)$/.test(name))result[name]=sha256(await readFile(join(root,entry.name)));
 }return result;
}
const buildRoot=fileURLToPath(new URL('../../',import.meta.url));
const buildFiles={...await fileHashes(join(buildRoot,'core'),'core/'),...await fileHashes(join(buildRoot,'tests/assistant'),'tests/assistant/')};
const identity={sourceHead:git('rev-parse','HEAD'),sourceTree:git('rev-parse','HEAD^{tree}'),sourceStatus:git('status','--porcelain=v1','--untracked-files=all'),
 sourceDiffSha256:sha256(git('diff','HEAD','--','core','tests','package.json','package-lock.json','tsconfig.json')),
 buildManifest:'build-manifest.json',buildDigest:sha256(JSON.stringify(buildFiles)),node:process.version,
 serviceBinding:null,model:null,note:'Local HARNESS build only; not the identity of an unobserved live service'};
await writeFile(join(output,'build-manifest.json'),JSON.stringify(buildFiles,null,2),{mode:0o600});

const ownerId='11111111-1111-4111-8111-111111111111',otherOwner='22222222-2222-4222-8222-222222222222';
const request='Bang! Keep 00172; literal ! $(touch NOT_EXECUTED) `literal` "quoted" \\ backslash\nPrepare the invented workshop application from my selected folder.';
const binding:JourneyBinding={sourceHead:'1'.repeat(40),buildIdentity:'invented-scripted-service',buildDigest:sha256('invented-build'),
 models:{endpoint:'https://api.tokenfactory.nebius.com/v1/chat/completions',globalLimitUsd:32,maximumWholeTaskReservationUsd:0.2,decision:{modelId:'invented-decision',inputContextTokens:8192,maxOutputTokens:1024},vision:{modelId:'invented-vision',inputContextTokens:8192,maxOutputTokens:1024,imageTokensUpperBound:4096,imageAccounting:'input-tokens'}},
 decisionConfigDigest:sha256('invented-decision-config'),visionConfigDigest:sha256('invented-vision-config'),limits:{limitUsd:0.3,maximumDecisionCalls:16,maximumVisionCalls:3}};
const imagePython=process.env.SPINDLE_IMAGE_PYTHON??(process.platform==='win32'?'python.exe':'python3');
let inventedPhoto:Uint8Array|undefined;
function photoFixture(){
 if(!inventedPhoto){const env:NodeJS.ProcessEnv={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  inventedPhoto=execFileSync(imagePython,['-E','-c',"from PIL import Image; import sys; im=Image.new('RGB',(8,10),(255,255,255)); im.putpixel((4,5),(12,34,56)); im.save(sys.stdout.buffer,format='PNG')"],{env,maxBuffer:16384,timeout:15000,stdio:['pipe','pipe','pipe']});
 }return inventedPhoto;
}
type Scenario='normal'|'blocked'|'uncertain'|'corrupt'|'wrong-mime'|'wrong-length'|'false-ready'|'no-model'|'wrong-model'|'wrong-build'|'wrong-budget'|'wrong-config'|'foreign'|'poll-limit'|'changed-owner'|'lost-correction'|'lost-admission'|'mutated-earlier'|'stale-correction'|'local-upload'|'missing-export'|'stale-export'|'no-correction-model'|'ready-uncertain'|'wrong-source'|'uncertain-model'|'failed-vision'|'empty-export'|'incomplete-export'|'unrelated-field'|'source-version';

/** Scripted HTTP responses ONLY: no AgentRuntime/provider/tool execution; never supplied to a live run. */
async function fixture(scenario:Scenario='normal',inputValue='00172') {
 let revision=1,value=inputValue,polls=0,cancelled=false;const requests:{path:string;body:unknown;status:number}[]=[],checkpoints:JourneyCheckpoint[]=[];
 const artifacts=new Map<string,{bytes:Uint8Array;mimeType:string}>();
 const pdf=await inventedPdf(value);artifacts.set('source',{bytes:new TextEncoder().encode('invented source'),mimeType:'text/plain'});
 artifacts.set('pdf-1',{bytes:pdf,mimeType:'application/pdf'});artifacts.set('photo-1',{bytes:photoFixture().slice(),mimeType:'image/png'});
 const source={id:'invented-source',provider:'drive',providerId:'invented-file',providerVersion:'7',sha256:sha256('invented source'),snapshotArtifactId:'source'};
 function session() {
  return {kind:'spindle.visible-session.v1',taskId:'invented-task',runId:'invented-run',revision,status:'ready',mode:'local_draft',saveOutputs:false,
   buildIdentity:scenario==='wrong-build'?'another-build':binding.buildIdentity,sourceIdentity:{revision:scenario==='wrong-source'?'2'.repeat(40):binding.sourceHead},
   messages:[{role:'user',content:request}],sources:[source],outputs:[],decisions:[{kind:'tool',name:'document.edit',args:{}}],
   // Deliberately scripted model/vision metadata: not an actual model call or live evidence.
   modelCalls:scenario==='no-model'?[]:Array.from({length:scenario==='no-correction-model'?1:revision},(_,i)=>({runId:`invented-run-${i+1}`,cursor:1,reservation:i+1,model:scenario==='wrong-model'?'wrong':binding.models.decision.modelId,configDigest:binding.decisionConfigDigest,responsePersisted:scenario!=='uncertain-model',decision:{kind:'tool',name:'document.edit',args:{}},usage:{inputTokens:10,outputTokens:5}})),
   visionCalls:[{id:'invented-vision-call',model:binding.models.vision.modelId,configDigest:binding.visionConfigDigest,inputArtifactId:'source',inputHash:source.sha256,sourceIds:[source.id],status:scenario==='failed-vision'?'failed':'completed',usage:{inputTokens:10,outputTokens:5}}],
   budget:{...binding.limits,decisionCalls:scenario==='no-model'?0:scenario==='no-correction-model'?1:revision,visionCalls:1,reservedUsd:scenario==='wrong-budget'?1:0.01},
   results:[{callId:'invented-read',status:'ok',data:{kind:'invented-read'},artifacts:[]},
    ...Array.from({length:revision},(_,i)=>({callId:`invented-edit-${i+1}`,status:'ok',data:{kind:'invented-prepared'},artifacts:[...artifacts].filter(([id])=>id===`pdf-${i+1}`||i===0&&id==='photo-1').map(([id,a])=>({id,sha256:sha256(a.bytes)}))})),
    ...Array.from({length:revision},(_,i)=>({callId:`invented-export-${i+1}`,status:'ok',data:{kind:'spindle.session-export.v1',artifactId:`session-${i+1}`,sha256:sha256(artifacts.get(`session-${i+1}`)?.bytes??'missing')},artifacts:[]}))]};
 }
 function putExport(){
  const visible=session(),results=visible.results.filter(r=>r.callId!==`invented-export-${revision}`&&!(scenario==='incomplete-export'&&r.callId.startsWith('invented-edit')));
  const body={...visible,revision:scenario==='stale-export'?0:revision,status:'working',results,
   ...(scenario==='empty-export'?{modelCalls:[]}:{ }),cutoff:{cursor:revision,observations:results.length,description:'Before this export; scripted fixture only'}};
  artifacts.set(`session-${revision}`,{bytes:new TextEncoder().encode(JSON.stringify(body)),mimeType:'application/json'});
 }
 putExport();
 function status():PreparationStatus {
  const state=cancelled?'cancelled':scenario==='poll-limit'?'working':scenario==='ready-uncertain'?'ready':scenario==='blocked'||scenario==='uncertain'?'blocked':polls===1?'working':'ready';
  return {taskId:'invented-task',revision,state,saveOutputs:false,mode:'local_draft',request,
   checklist:{revision:1,reason:'invented',items:[{id:'form',title:'Invented form',state:'done',dependsOn:[]}]},
   recovery:scenario==='uncertain'||scenario==='ready-uncertain'?'reconciliation_required':'clean',nextAction:scenario==='uncertain'?'Inspect retained local write checkpoint; do not repeat operation':'Review invented draft',
   ...(scenario==='blocked'||scenario==='uncertain'?{blocker:scenario==='uncertain'?'Interrupted local write requires reconciliation':'Unsupported input backend'}:{}),
   fields:[{id:'workshop_reference',label:'Workshop reference',value,unresolved:scenario==='false-ready',citations:[],...(revision>1?{corrected:true}:{})},
    {id:'workshop_name',label:'Workshop',value:scenario==='unrelated-field'&&revision>1?'changed unexpectedly':'Invented workshop',unresolved:false,citations:[]}],
   sources:[{...source,providerVersion:scenario==='source-version'&&revision>1?'8':source.providerVersion}],session:session(),
   artifacts:[...artifacts].filter(([id])=>!(scenario==='missing-export'&&id.startsWith('session-'))).map(([id,a])=>({id,mimeType:a.mimeType,sha256:sha256(a.bytes),bytes:a.bytes.length})),
   outputs:scenario==='local-upload'?[{artifactId:'pdf-1',revision,state:'intent'}]:[]};
 }
 const transport:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;const body=init?.body?JSON.parse(String(init.body)):undefined;
  assert.equal(init?.method,'POST');assert.equal(init?.credentials,'same-origin');
  let code=200;let result:unknown;
  if(path==='/session')result={account:{id:ownerId,name:'Invented owner'},csrf:'a'.repeat(64)};
  else if(path==='/logout')result={status:'signed_out'};
  else if(path==='/preparation/config')result={configured:true,models:scenario==='wrong-config'?null:binding.models,limits:binding.limits,modes:['local_draft','drive_outputs'],requiresProcessingConsent:true,sourceIdentity:{revision:binding.sourceHead},buildIdentity:binding.buildIdentity,readiness:{credentials:'lazy_not_checked',processing:'explicit_request_consent_required',writePermission:'not_assumed',liveAcceptance:'unverified'}};
  else if(path==='/preparation/request'){
   assert.deepEqual(body,{connectionId:'invented-connection',rootId:'invented-root',request,requestId:'invented-request',processingConsent:true,saveOutputs:false});
   code=202;result={taskId:'invented-task',revision,state:'working'};
  }else if(path==='/preparation/status'){
   assert.deepEqual(body,{taskId:'invented-task'});polls++;
   if(scenario==='foreign'){code=404;result={code:'PREPARATION_NOT_FOUND'};}else result=status();
  }else if(path==='/preparation/artifact'){
   assert.equal(body.taskId,'invented-task');const a=artifacts.get(body.artifactId);assert.ok(a);
   const bytes=scenario==='corrupt'&&body.artifactId==='pdf-1'?await inventedPdf('98765'):scenario==='wrong-length'?new Uint8Array():a.bytes;
   requests.push({path,body,status:200});return new Response(Buffer.from(bytes),{headers:{'Content-Type':scenario==='wrong-mime'?'text/plain':a.mimeType}});
  }else if(path==='/preparation/correct'){
   assert.deepEqual(body,{taskId:'invented-task',expectedRevision:revision,fieldId:'workshop_reference',value:'00931'});
   if(scenario==='stale-correction'){code=409;result={code:'STALE_PREPARATION_REVISION'};}
   else{revision++;value=body.value;polls=0;artifacts.set(`pdf-${revision}`,{bytes:await inventedPdf(value),mimeType:'application/pdf'});
    if(scenario==='mutated-earlier')artifacts.set('pdf-1',{bytes:await inventedPdf('88888'),mimeType:'application/pdf'});putExport();result={taskId:'invented-task',revision,state:'working'};}
  }else if(path==='/preparation/cancel'){assert.deepEqual(body,{taskId:'invented-task'});cancelled=true;result={taskId:'invented-task',revision,state:'cancelled'};}
  else throw Error(`Unexpected route ${path}; no OAuth/Google/resume/tools allowed`);
  requests.push({path,body,status:code});
  if(scenario==='lost-admission'&&path==='/preparation/request'||scenario==='lost-correction'&&path==='/preparation/correct')throw Error('INVENTED_LOST_ACK');
  return new Response(JSON.stringify(result),{status:code,headers:{'Content-Type':'application/json'}});
 };
 const client=new AccountClient('http://127.0.0.1',transport,true);await client.restore();
 const options:JourneyOptions={ownerId,binding,request:{connectionId:'invented-connection',rootId:'invented-root',request,requestId:'invented-request',processingConsent:true,saveOutputs:false},maxPolls:4,pollIntervalMs:0,
  async checkpoint(cp){checkpoints.push(cp);},async correction(){return {fieldId:'workshop_reference',value:'00931'};},
  async verifyRevision(s,all){const a=all.find(a=>a.id===`pdf-${s.revision}`);assert.ok(a);await assertPdf(a.bytes,{workshop_reference:s.fields[0].value,unresolved_do_not_invent:''});
   const photo=all.find(a=>a.id==='photo-1');assert.ok(photo);assertPhoto(photo.bytes,{width:8,height:10,mimeType:'image/png',maxBytes:1024,pixels:[{x:0,y:0,rgb:[255,255,255]},{x:4,y:5,rgb:[12,34,56]}]},imagePython);
   return [{id:`fixture_pdf_photo_revision_${s.revision}`,status:'PASS',detail:'Scripted readback PDF reopened and invented photo decoded/pixel-checked; not model editing/render/quality proof'}];}};
 return {client,options,requests,checkpoints,getStatus:status,otherOwner};
}
function failure(r:JourneyResult,pattern:RegExp){assert.equal(r.driverStatus,'FAIL');assert.ok(r.error instanceof Error);assert.match(r.error.message,pattern);}
async function fixtures(){
 await check('normal_client_202_running_local_ready_correction_immutable_bytes',async()=>{
  const f=await fixture(),r=await runLocalDraftJourney(f.client,f.options);assert.equal(r.driverStatus,'PASS',r.error instanceof Error?r.error.stack:undefined);
  assert.equal(r.acceptanceStatus,'UNRUN');assert.equal(r.checkpoint.latest?.revision,2);
  assert.deepEqual(r.checkpoint.statuses.map(s=>[s.revision,s.state]),[[1,'working'],[1,'ready'],[2,'working'],[2,'ready']]);
  assert.equal(f.requests.find(r=>r.path==='/preparation/request')?.status,202);
  assert.equal(r.checkpoint.latest?.request,request);assert.ok(request.includes('Bang!'));assert.ok(f.checkpoints.some(c=>c.phase==='awaiting_user_correction'));
  assert.equal(f.requests.filter(r=>r.path==='/preparation/request').length,1);assert.equal(f.requests.filter(r=>r.path==='/preparation/correct').length,1);
  await writeFile(join(output,'scripted-driver-proof.json'),JSON.stringify({label:'SCRIPTED_HTTP_FIXTURE_NOT_LIVE',requests:f.requests,phases:f.checkpoints.map(c=>c.phase),status:r.driverStatus,acceptance:r.acceptanceStatus},null,2),{mode:0o600});
 },'Same exported driver with real AccountClient/JSON transport, scripted 202/running/ready, local bytes, user-like revision and re-read earlier bytes; literal Bang and punctuation unchanged');
 await check('changed_input_same_driver_same_oracle',async()=>{
  for(const input of ['00172','00408']){const f=await fixture('normal',input),r=await runLocalDraftJourney(f.client,f.options);assert.equal(r.driverStatus,'PASS');
   const first=r.checkpoint.artifacts.find(a=>a.id==='pdf-1');assert.ok(first);await assertPdf(first.bytes,{workshop_reference:input});}
 },'Different invented source/PDF fixture values; same orchestration/oracle, NOT actual model adaptation');
 await check('blocked_uncertain_and_poll_bound_preserve_checkpoint_without_resume',async()=>{
  for(const scenario of ['blocked','uncertain','ready-uncertain','poll-limit'] as const){const f=await fixture(scenario),r=await runLocalDraftJourney(f.client,f.options);assert.equal(r.driverStatus,'BLOCKED');
   assert.ok(r.checkpoint.latest);assert.equal(r.checkpoint.latest.blocker,f.getStatus().blocker);assert.equal(r.checkpoint.latest.recovery,f.getStatus().recovery);
   assert.equal(f.requests.filter(r=>r.path==='/preparation/status').length,scenario==='poll-limit'?4:1);
   assert.ok(!f.requests.some(r=>/correct|cancel|resume|artifact/.test(r.path)));}
 },'Precise blocker/reconciliation state and operational poll checkpoint retained; no forced Ready, whole-job deadline, cancel-at-limit or uncertain-write retry');
 await check('corrupt_artifact_mime_length_and_mutated_prior_bytes_fail',async()=>{
  for(const [scenario,pattern] of [['corrupt',/Corrupt artifact|length mismatch/],['wrong-mime',/MIME mismatch/],['wrong-length',/length mismatch/],['mutated-earlier',/Earlier artifact mutated/]] as const){
   const f=await fixture(scenario),r=await runLocalDraftJourney(f.client,f.options);failure(r,pattern);assert.ok(r.checkpoint.latest);
   if(scenario!=='mutated-earlier')assert.ok(!f.requests.some(r=>r.path==='/preparation/correct'));}
 },'Reject HTTP200 with wrong decoded hash/MIME/size and rewritten earlier revision, even when latest metadata is self-consistent');
 await check('no_false_ready_model_build_budget_and_session_binding',async()=>{
  for(const [scenario,pattern] of [['false-ready',/Unresolved fields/],['no-model',/No decision\/vision evidence/],['wrong-model',/wrong/],['wrong-build',/another-build/],['wrong-budget',/Invalid accounted budget/],['wrong-config',/Running model caps differ/],['wrong-source',/Session source identity differs/],['uncertain-model',/Uncertain model response/],['failed-vision',/Uncertain\/failed vision operation/],['local-upload',/Local draft/],['missing-export',/Session export not readable/],['stale-export',/Current revision session export missing/],['empty-export',/Session export lacks model calls/],['incomplete-export',/Current session export omits prepared artifact evidence/]] as const){
   const f=await fixture(scenario),r=await runLocalDraftJourney(f.client,f.options);failure(r,pattern);
   assert.ok(!f.requests.some(r=>r.path==='/preparation/correct'));
   if(scenario==='wrong-config')assert.ok(!f.requests.some(r=>r.path==='/preparation/request'));}
 },'Server Ready alone insufficient: real-byte/session, model/config/build/budget/readiness bindings required; local draft forbids upload intents');
 await check('foreign_owner_denial_and_changed_owner_stop',async()=>{
  const f=await fixture('foreign'),r=await runLocalDraftJourney(f.client,f.options);failure(r,/PREPARATION_NOT_FOUND/);assert.ok(r.error instanceof AccountRequestFailure);assert.equal(r.error.status,404);
  assert.equal(r.checkpoint.receipt?.taskId,'invented-task');assert.equal(r.checkpoint.latest,undefined);
  const g=await fixture();g.options.ownerId=otherOwner;failure(await runLocalDraftJourney(g.client,g.options),/Authenticated owner changed/);
  assert.deepEqual(g.requests.map(r=>r.path),['/session']);
  const h=await fixture();h.options.checkpoint=async cp=>{if(cp.phase==='admitted')await h.client.signout();};
  failure(await runLocalDraftJourney(h.client,h.options),/Authenticated owner changed/);assert.ok(!h.requests.some(r=>r.path==='/preparation/status'));
 },'Normal client typed 404 retained; host owner mismatch before admission; changing authentication halts follow-on calls');
 await check('correction_requires_new_model_turn_and_preserves_unrelated_fields_sources',async()=>{
  for(const [scenario,pattern] of [['no-correction-model',/No new model decision after correction/],['unrelated-field',/Unrelated field changed/],['source-version',/Earlier source providerVersion changed/]] as const){
   const f=await fixture(scenario);failure(await runLocalDraftJourney(f.client,f.options),pattern);
  }
 },'Reject new bytes with no new model turn, changed unrelated field, or rewritten source version after correction');
 await check('lost_ack_stale_correction_no_replay',async()=>{
  for(const scenario of ['lost-admission','lost-correction','stale-correction'] as const){const f=await fixture(scenario),r=await runLocalDraftJourney(f.client,f.options);
   failure(r,scenario==='stale-correction'?/STALE_PREPARATION_REVISION/:/INVENTED_LOST_ACK/);
   assert.equal(f.requests.filter(r=>r.path==='/preparation/request').length,1);assert.equal(f.requests.filter(r=>r.path==='/preparation/correct').length,scenario==='lost-admission'?0:1);
   assert.ok(!f.requests.some(r=>/resume|cancel/.test(r.path)));
   if(scenario!=='lost-admission')assert.equal(r.checkpoint.latest?.revision,1);
  }
 },'Original observed exception and last coherent checkpoint retained on uncertain/stale mutation; no automatic retry or resume');
 await check('explicit_cancellation_only_and_no_followon_work',async()=>{
  for(const at of ['before','admitted','observed','artifact_verified','awaiting_user_correction','correction_admitted']){
   const f=await fixture(),controller=new AbortController();f.options.signal=controller.signal;
   f.options.checkpoint=async cp=>{if(cp.phase===at)controller.abort();};if(at==='before')controller.abort();
   const r=await runLocalDraftJourney(f.client,f.options);assert.equal(r.driverStatus,'CANCELLED');
   assert.equal(f.requests.filter(r=>r.path==='/preparation/cancel').length,at==='before'?0:1);
   if(at==='admitted')assert.ok(!f.requests.some(r=>r.path==='/preparation/status'));
   if(at==='awaiting_user_correction')assert.ok(!f.requests.some(r=>r.path==='/preparation/correct'));
  }
 },'Explicit host user AbortSignal uses normal cancel once; no auto-cancel from poll bound and no further tool/correction work');
 await check('host_artifact_oracle_and_checkpoint_failures_are_not_pass',async()=>{
  const f=await fixture();f.options.verifyRevision=async()=>[{id:'invented-visual',status:'UNRUN',detail:'No visual inspection'}];failure(await runLocalDraftJourney(f.client,f.options),/Host artifact oracle/);
  const g=await fixture();const sentinel=new Error('INVENTED_CHECKPOINT_UNAVAILABLE');g.options.checkpoint=async cp=>{if(cp.phase==='admitted')throw sentinel;};
  const r=await runLocalDraftJourney(g.client,g.options);assert.equal(r.error,sentinel);assert.equal(r.checkpoint.receipt?.taskId,'invented-task');assert.ok(!g.requests.some(r=>r.path==='/preparation/status'));
 },'UNRUN oracle and local persistence failure retain exact errors and stop dependent actions');
 await check('decoded_photo_oracle_rejects_metadata_only_or_wrong_pixels',()=>{
  const bytes=photoFixture(),expected={width:8,height:10,mimeType:'image/png' as const,maxBytes:1024};assertPhoto(bytes,expected,imagePython);
  assert.throws(()=>assertPhoto(bytes,{...expected,width:9},imagePython));assert.throws(()=>assertPhoto(bytes,{...expected,mimeType:'image/jpeg'},imagePython));
  assert.throws(()=>assertPhoto(bytes,{...expected,maxBytes:1},imagePython));assert.throws(()=>assertPhoto(bytes,{...expected,pixels:[{x:4,y:5,rgb:[255,255,255]}]},imagePython));
  assert.throws(()=>assertPhoto(Buffer.from('not an image'),expected,imagePython));
 },'Independent Pillow decode checks actual invented readback pixels/size/format/bytes, not tool/provider metadata or visual-quality acceptance');
 await check('drive_optional_oracle_remains_separate',()=>{
  const bytes=Buffer.from('invented optional Drive readback');const expected={rootId:'invented-root',id:'invented-output',version:'7',mimeType:'application/json'};
  const readback={id:expected.id,version:expected.version,mimeType:expected.mimeType,parents:[expected.rootId],bytes};assertDriveReadback(bytes,expected,readback);
  for(const changed of [{parents:['wrong-root']},{version:'8'},{id:'wrong'},{mimeType:'text/plain'},{bytes:Buffer.from('corrupt')}])assert.throws(()=>assertDriveReadback(bytes,expected,{...readback,...changed}));
 },'Fixture-only optional Drive byte/parent/version oracle; local driver never asks for Drive grant, Picker or upload');
}
if(mode==='fixture')await fixtures();
else checks.push({id:'authorized_host_caller_required',status:'BLOCKED',detail:
 'CLI cannot obtain an already authenticated client without credential/cookie workarounds. Supported live entrypoint: import runLocalDraftJourney from connected-drive-journey-support.js inside the trusted authorized host; pass its existing AccountClient and explicit JourneyOptions. This CLI makes zero service/provider calls. Actual new-parent Nebius egress approval remains pending; current mandatory saveOutputs:false does not request/expand Drive writes. No live acceptance run here.'});
const harnessStatus=checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='BLOCKED')?'BLOCKED':'PASS';
const report={schemaVersion:2,mode,startedAt,finishedAt:new Date().toISOString(),identity,harnessStatus,acceptanceStatus:'UNRUN',checks,
 journey:journeyOracles.map(id=>({id,status:'UNRUN',detail:'Actual source/model/full-write journey not executed. Fixture PASS tests driver machinery only.'})),
 usage:{actualModelRequests:0,actualGoogleRequests:0,chargedUsd:0,reservationDisposition:'No real journal opened/reserved'},
 proofLimits:['Scripted HTTP model metadata is invented, not provider evidence.','No live source bytes/model tools/OCR/photo editing/rendered PDF/browser or native visuals/Drive writes or readback/OAuth/live corrections executed; only invented photo decode and PDF field/byte checks.','Optional Drive acceptance remains separate; local draft PASS cannot satisfy it.','Independent complete-candidate review remains coordinator-owned.']};
await writeFile(join(output,'run.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({mode,harnessStatus,acceptanceStatus:'UNRUN',report:join(output,'run.json')}));process.exitCode=harnessStatus==='PASS'?0:1;
