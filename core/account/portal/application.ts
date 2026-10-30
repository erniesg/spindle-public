import type {PortalContext} from './types.js';
import type {PreparationStatus} from '../client.js';
import type {GoogleConnections} from '../google-client.js';
import type {PreparationBrowserSnapshot} from '../../preparation/browser-review.js';

/** Application workspace over the existing authenticated /preparation API only.
 * Every value shown comes from the signed-in account's backend; nothing is seeded,
 * cached in browser storage or presented as regenerated/submitted by the UI itself. */
type Task=PreparationStatus;
type Listed={taskId:string;revision:number;state:string;request:string;execution?:{state?:string;phase?:string}};
type Artifact=Task['artifacts'][number];
type Citation={artifactId:string;sourceId:string;sourceVersion?:string;previewArtifactId?:string;regionPreview?:boolean;previewUnavailable?:boolean;regions?:unknown[]};
type Source={id:string;provider?:string;providerId?:string;providerVersion?:string;mimeType?:string;sha256?:string;snapshotArtifactId?:string;name?:string};
type Config={configured?:boolean;processingPaused?:boolean;processingPauseReason?:string;limits?:{limitUsd:number;maximumDecisionCalls:number;maximumVisionCalls:number};browserApproval?:{available:boolean;mode?:string;destination?:string;reason?:string}};
type Revision={applicationId:string;revision:number;contentHash:string};
/** Server-retained browser facts and the last run outcome; display only, never a capability. */
type BrowserFacts={browser?:{recovery:string;approval:{id:string;requestId:string;revoked:boolean;superseded:boolean;revision:Revision}|null;submission:{state:string;destination:string;receiptUrl:string;revision:Revision;receipt:{receiptId:string;contentHash:string;destination:string;revision:Revision}|null}|null}|null;portal?:{action:string;state:string;code?:string;requestId?:string;interruption?:string;submission?:string}|null;canReconcile?:boolean};
type Review=PreparationBrowserSnapshot&{required?:{controls:string[];files:string[]};approval?:{available:boolean;reason?:string}};

const POLL_MS=1500;
const IMAGES=new Set(['image/png','image/jpeg','image/webp']);
const TEXTS=new Set(['text/plain','application/json','application/vnd.spindle.ocr+json']);
const EXTENSIONS:Record<string,string>={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','image/webp':'webp','text/plain':'txt','application/json':'json'};
const KINDS:Record<string,string>={'application/pdf':'PDF document','image/png':'PNG image','image/jpeg':'JPEG photo','image/webp':'WebP image','text/plain':'Text','application/json':'JSON record','application/vnd.spindle.ocr+json':'OCR text record'};

export const applicationMessages:Record<string,string>={
 PREPARATION_NOT_CONFIGURED:'Application preparation is not available yet. You can connect your sources and keep your request ready; nothing will run automatically.',
 PREPARATION_PROCESSING_PAUSED:'Processing is paused by the operator. You can review retained work; corrections and new requests are held. Nothing was changed.',
 STALE_PREPARATION_REVISION:'This application changed since you opened it. The current revision was reloaded; your correction was not saved.',
 PREPARATION_CANCELLED:'This task was cancelled. Its retained work stays readable but cannot be corrected.',
 PREPARATION_RECONCILIATION_REQUIRED:'An earlier effect is still being reconciled. Corrections are held until it settles; nothing was changed.',
 PREPARATION_FIELD_NOT_FOUND:'That field is no longer part of this application. The current revision was reloaded.',
 PREPARATION_CONNECTION_CHANGED:'The Google connection or folder bound to this task changed. Reconnect it before correcting; nothing was changed.',
 PREPARATION_ARTIFACT_NOT_FOUND:'That file is not part of this task.',
 PREPARATION_BROWSER_NOT_CONFIGURED:'No trusted submission destination is configured on this server.',
 PREPARATION_BROWSER_TASK_NOT_SETTLED:'Destination review needs a settled task (not working, cancelled or reconciling).',
 PREPARATION_BROWSER_STALE_REVISION:'Destination review refused a stale revision. Reload and check again.',
 PREPARATION_BROWSER_INVALID_DESTINATION:'The configured submission destination is invalid on this server.',
 PREPARATION_BROWSER_APPROVAL_NOT_CONFIGURED:'Approval and submission are not enabled on this server. Nothing can be submitted from here.',
 PREPARATION_BROWSER_FILE_UNAVAILABLE:'This revision has no current prepared PDF and PNG for the destination. Nothing was submitted.',
 PREPARATION_BROWSER_FIELD_UNAVAILABLE:'A prepared answer the destination needs is missing or still needs input. Nothing was submitted.',
 PREPARATION_PORTAL_REVIEW_CHANGED:'The application changed since you checked it. Check the destination again before approving; nothing was submitted.',
 PREPARATION_PORTAL_REQUIRED_EMPTY:'A required destination answer is empty. Correct it before approving; nothing was submitted.',
 PREPARATION_PORTAL_SUBMISSION_EXISTS:'This task already has a submission. Check its receipt instead; nothing was submitted again.',
 PREPARATION_PORTAL_REQUEST_ALREADY_USED:'That approval was already used. Check the destination again to approve afresh.',
 PREPARATION_PORTAL_RECONCILIATION_REQUIRED:'The submission outcome is unknown. Use Check receipt (read-only); Spindle never resubmits.',
 PREPARATION_PORTAL_TASK_NOT_READY:'This task is not ready for submission. Nothing was submitted.',
 PREPARATION_PORTAL_BUDGET_EXHAUSTED:'The model budget for this task is used up. Nothing was submitted and no limit was raised.',
 PREPARATION_PORTAL_NO_SUBMISSION:'There is no submission to check for this task.',
 PREPARATION_PORTAL_TASK_NOT_RECONCILABLE:'This submission cannot be checked automatically. Nothing was resubmitted.',
 PREPARATION_PORTAL_INTERRUPTED:'Submission was interrupted (sign-in, connection or service change). Nothing was resubmitted.',
 PREPARATION_PORTAL_DEADLINE_EXCEEDED:'Submission reached its time limit. Check the receipt (read-only) if it may have been sent.',
 PREPARATION_PORTAL_NOT_VERIFIED:'The receipt was not verified. Nothing was resubmitted.',
 PREPARATION_PORTAL_UNAVAILABLE:'The submission browser was unavailable. Nothing was resubmitted.',
 PREPARATION_ALREADY_WORKING:'This task is already working. Wait for it to settle; nothing was changed.',
 PREPARATION_STOPPING:'The preparation service is stopping. Retained work is unchanged; refresh later.',
 REQUEST_ID_CONFLICT:'A different request already used this request identity. Edit the request to create a new one.',
 INVALID_PREPARATION_REQUEST:'The request was refused as invalid. Check the request text, folder and processing consent.',
 INVALID_PREPARATION_CORRECTION:'The correction was refused as invalid (it may be too long).',
 GOOGLE_RECONNECT_REQUIRED:'Google needs to be reconnected for this task. Nothing was changed.',
 GOOGLE_CONNECTION_NOT_FOUND:'The Google connection for this task was not found. Nothing was changed.',
 RESPONSE_BOUND:'That file is larger than this browser view accepts.',
 ARTIFACT_HASH_MISMATCH:'Downloaded bytes did not match the recorded SHA-256. The file was not shown.',
};
const AUTH=new Set(['ACCOUNT_HTTP_401']);
const codeOf=(error:unknown)=>{const code=(error as {code?:unknown})?.code;return typeof code==='string'?code:error instanceof Error?error.message:'';};
/** Fixed protocol codes only; never echo arbitrary backend or provider text as an error. */
export function applicationErrorMessage(error:unknown):string{
 const code=codeOf(error);if(applicationMessages[code])return applicationMessages[code];
 if(/^ACCOUNT_HTTP_5\d\d$/.test(code)||error instanceof TypeError)return 'The server could not be reached. Retained work is unchanged; nothing was retried automatically.';
 if(error instanceof DOMException&&error.name==='TimeoutError')return 'The server did not answer in time. The outcome is unknown; refresh before acting again.';
 return 'This action is not available right now. Your account and retained work are unchanged; nothing was retried automatically.';
}
export const applicationAuthFailure=(error:unknown)=>AUTH.has(codeOf(error))||(error as {status?:number})?.status===401;
/** Current versus historical outputs as recorded by the backend, never inferred client-side. */
export function applicationArtifactGroups(task:Pick<Task,'artifacts'|'sources'>){
 const snapshots=new Set((task.sources as Source[]).map(s=>s.snapshotArtifactId).filter(Boolean));
 const files=task.artifacts.filter(a=>!snapshots.has(a.id)&&(IMAGES.has(a.mimeType)||a.mimeType==='application/pdf'));
 return {current:files.filter(a=>a.current===true),historical:files.filter(a=>a.current!==true),other:task.artifacts.filter(a=>!snapshots.has(a.id)&&!files.includes(a))};
}
/** Correction history from the backend's visible session record. */
export function applicationCorrections(task:Pick<Task,'session'>):{revision:number;content:string}[]{
 const messages=(task.session as {messages?:unknown})?.messages;
 return Array.isArray(messages)?messages.filter((m):m is {revision:number;content:string}=>!!m&&typeof m==='object'&&Number.isSafeInteger((m as {revision?:unknown}).revision)&&typeof (m as {content?:unknown}).content==='string'):[];
}
const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
const size=(n:number)=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const kind=(mimeType:string)=>KINDS[mimeType]??mimeType;
const STATES:Record<string,string>={ready:'Needs your review',blocked:'Needs attention',working:'Preparing',cancelled:'Cancelled',failed:'Failed'};
const stateLabel=(state:string)=>STATES[state]??state;
const live=(state?:string)=>state==='running'||state==='queued';

export function mountApplication(context:PortalContext):()=>void{
 const {root,client}=context,doc=root.ownerDocument,owner=client.account?.id;
 const local=new AbortController(),signal=AbortSignal.any([context.signal,local.signal]);
 const urls=new Set<string>(),drafts=new Map<string,{revision:number;value:string}>(),requestIds=new Map<string,string>(),approvalIds=new Map<string,string>();
 let disposed=false,busy=false,timer:ReturnType<typeof setTimeout>|undefined,taskToken=0,sourceToken=0;
 let config:Config|undefined,task:Task|undefined,selected:string|undefined,connections:GoogleConnections['connections']=[];
 let destination:{revision:number;view?:Review;message?:string}|undefined;

 function node<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text?:string){const n=doc.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;}
 function button(label:string,run:()=>Promise<void>|void,className=''){const b=node('button',className,label);b.type='button';b.addEventListener('click',()=>{void act(run);},{signal});return b;}
 function badge(text:string,tone=''){return node('span','portal-badge application-badge'+(tone?' application-badge-'+tone:''),text);}
 const current=()=>!disposed&&!signal.aborted&&client.account?.id===owner;
 const request=<T>(path:string,data:unknown)=>client.request(path,data,signal) as Promise<T>;

 const shell=node('section','application');shell.dataset.applicationView='';
 const header=node('header','application-header');header.append(node('p','application-eyebrow','Applications'),node('h2','application-title','Your application workspace'));
 const notice=node('p','portal-status application-notice');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
 const pause=node('p','portal-error application-paused');pause.hidden=true;
 const layout=node('div','portal-grid application-layout');
 const list=node('aside','portal-card application-tasks');list.setAttribute('aria-label','Application tasks');
 const compose=node('section','portal-card application-request');
 const review=node('article','portal-card application-review');review.setAttribute('aria-live','polite');
 const source=node('aside','portal-card application-source');source.setAttribute('aria-label','Source and file preview');
 const side=node('div','application-sidebar');side.append(list,compose);
 layout.append(side,review,source);header.append(notice,pause);shell.append(header,layout);
 root.replaceChildren(shell);

 function say(text:string,error=false){notice.textContent=text;notice.className=(error?'portal-error':'portal-status')+' application-notice';}
 function fail(error:unknown){
  if(!current()||(error as {name?:string})?.name==='AbortError')return;
  if(applicationAuthFailure(error)){stop();context.onError(error);return;}
  say(applicationErrorMessage(error),true);
 }
 function lock(){for(const b of shell.querySelectorAll('button,input,textarea,select'))(b as HTMLButtonElement).disabled=busy||(b as HTMLElement).dataset.applicationUnavailable==='yes';shell.setAttribute('aria-busy',String(busy));}
 async function act(run:()=>Promise<void>|void){if(busy||!current())return;busy=true;lock();try{await run();}catch(error){fail(error);}finally{busy=false;if(current())lock();}}
 function stop(){clearTimeout(timer);timer=undefined;}
 function revoke(){for(const url of urls)URL.revokeObjectURL(url);urls.clear();}

 function placeholder(target:HTMLElement,title:string,text:string,tone='portal-muted'){target.replaceChildren(node('h3','application-heading',title),node('p',tone,text));}

 async function loadList(){
  list.replaceChildren(node('h3','application-heading','Tasks'),node('p','portal-muted application-loading','Loading your tasks…'));
  const result=await request<{tasks:Listed[];limit:number}>('/preparation/list',{});if(!current())return;
  list.replaceChildren(node('h3','application-heading','Tasks'));
  if(!result.tasks.length){list.append(node('p','portal-muted application-empty','No application tasks for this account yet. Start one below when a Google folder is connected.'));return;}
  const items=node('ul','application-task-list');
  for(const t of result.tasks){
   const item=node('li','application-task'),open=button(t.request||'Untitled request',()=>select(t.taskId),'application-task-open');
   open.dataset.applicationTask=t.taskId;open.setAttribute('aria-current',String(t.taskId===selected));
   const meta=node('p','portal-muted application-task-meta');meta.append(badge(stateLabel(t.state),t.state),' revision '+t.revision+(t.execution?.state?' · '+t.execution.state:''));
   item.append(open,meta);items.append(item);
  }
  list.append(items);if(result.tasks.length>=result.limit)list.append(node('p','portal-muted','Showing the newest '+result.limit+' retained tasks.'));
 }

 async function select(taskId:string){
  stop();selected=taskId;task=undefined;destination=undefined;sourceToken++;revoke();
  placeholder(source,'Sources','Choose a source citation or file to preview it here.');
  for(const b of list.querySelectorAll('[data-application-task]'))b.setAttribute('aria-current',String((b as HTMLElement).dataset.applicationTask===taskId));
  placeholder(review,'Application','Loading the current revision…','portal-muted application-loading');
  await status();
 }

 async function status(){
  const id=selected,token=++taskToken;if(!id)return;stop();
  const result=await request<Task>('/preparation/status',{taskId:id});
  if(!current()||token!==taskToken||id!==selected)return;
  task=result;renderTask();
  if(live(task.execution?.state))timer=setTimeout(()=>{void status().catch(error=>{fail(error);if(current())say('Live status refresh stopped. Press Refresh; nothing was retried.',true);});},POLL_MS);
 }

 function renderTask(){
  const t=task!;review.replaceChildren();review.dataset.applicationState=t.state;review.dataset.applicationRevision=String(t.revision);
  const top=node('div','application-review-top');
  top.append(node('p','application-eyebrow',t.mode==='drive_outputs'?'Prepared to save in Google Drive':'Local draft · nothing leaves Spindle'),node('h3','application-heading',t.request));
  const meta=node('p','application-review-meta');meta.append(badge(stateLabel(t.state),t.state),badge('Revision '+t.revision),badge(t.execution?.state??'idle',t.execution?.state));
  if(t.execution?.phase&&t.execution.phase!==t.execution.state)meta.append(' '+t.execution.phase);
  top.append(meta,button('Refresh from server',status,'application-refresh'));review.append(top);
  if(t.execution?.state==='interrupted')review.append(node('p','portal-error','Processing was interrupted and will not restart automatically. Earlier effects may need reconciliation.'));
  if(t.blocker)review.append(node('p','portal-error application-blocker',String(t.blocker)));
  if(t.nextAction)review.append(node('p','portal-muted application-next','Next: '+String(t.nextAction)));
  if(typeof t.result==='string'&&t.result)review.append(node('p','application-result',t.result));
  checklist(t);fields(t);files(t);sources(t);outputs(t);steps(t);submission(t);lock();
 }

 function checklist(t:Task){
  const items=t.checklist?.items??[];if(!items.length)return;
  const section=node('section','application-checklist');section.append(node('h4','application-subheading','Checklist'));
  const ol=node('ol','application-timeline');
  for(const item of items){const li=node('li','application-step'+(item.state==='done'?' is-done':item.state==='active'||item.state==='running'?' is-current':''));li.append(node('span','application-step-title',item.title),' ',badge(item.state,item.state));ol.append(li);}
  section.append(ol);review.append(section);
 }

 function fields(t:Task){
  const section=node('section','application-fields');section.append(node('h4','application-subheading','Prepared answers'));review.append(section);
  if(!t.fields.length){section.append(node('p','portal-muted application-empty',live(t.execution?.state)?'Answers appear here once preparation reads your sources.':'No answers were prepared for this task.'));return;}
  const editable=t.state!=='cancelled'&&t.state!=='working'&&!t.processingPaused;
  const sourceList=t.sources as Source[];
  for(const field of t.fields){
   const key=t.taskId+':'+field.id,draft=drafts.get(key),row=node('div','application-field');row.dataset.applicationField=field.id;
   const label=node('label','application-field-label',field.label),input=node('input','application-field-input');
   input.value=draft&&draft.revision===t.revision?draft.value:field.value;input.maxLength=8192;input.setAttribute('aria-label',field.label);input.readOnly=!editable;
   input.addEventListener('input',()=>drafts.set(key,{revision:t.revision,value:input.value}),{signal});
   const flags=node('span','application-field-flags');if(field.unresolved)flags.append(badge('Needs input','warning'));if(field.corrected)flags.append(badge('Corrected by you','corrected'));
   label.append(flags);row.append(label,input);
   if(draft&&draft.revision!==t.revision&&draft.value!==field.value){row.append(node('p','portal-error application-conflict','Revision changed to '+t.revision+' while you were editing. Your unsaved text was: '+draft.value));drafts.delete(key);}
   const actions=node('div','portal-actions application-field-actions');
   const save=button('Save correction',async()=>{
    const value=input.value;if(value===field.value){say('Nothing changed in '+field.label+'.');return;}
    try{const receipt=await request<{revision:number;state:string}>('/preparation/correct',{taskId:t.taskId,expectedRevision:t.revision,fieldId:field.id,value});
     if(!current())return;drafts.delete(key);say('Saved as revision '+receipt.revision+'. Documents and photos are regenerated by Spindle from retained sources; files below stay from earlier revisions until it finishes.');}
    catch(error){if(codeOf(error)==='STALE_PREPARATION_REVISION'||codeOf(error)==='PREPARATION_FIELD_NOT_FOUND'){drafts.set(key,{revision:-1,value});fail(error);await status();return;}throw error;}
    await status();await loadList();
   },'application-save');
   if(!editable){save.dataset.applicationUnavailable='yes';save.title=t.processingPaused?'Processing is paused':'Corrections need a settled, active task';}
   actions.append(save);
   field.citations.forEach((raw,i)=>{const c=raw as Citation,origin=sourceList.find(s=>s.id===c.sourceId);
    const open=button('Source '+(i+1)+(origin?.name?' · '+origin.name:''),()=>preview(t.taskId,c.previewArtifactId??c.artifactId,{title:field.label+' · source '+(i+1),citation:c,source:origin}),'application-citation');
    if(c.previewUnavailable){open.dataset.applicationUnavailable='yes';open.title='Source preview unavailable';}
    actions.append(open);});
   if(!field.citations.length)actions.append(node('span','portal-muted application-uncited','No source citation'));
   row.append(actions);section.append(row);
  }
  if(!editable)section.append(node('p','portal-muted',t.processingPaused?'Corrections are held while processing is paused.':t.state==='working'?'Corrections open once the current preparation step settles.':'This task is cancelled; answers are read-only.'));
  const history=applicationCorrections(t);
  if(history.length){const d=node('details','application-history'),list=node('ol','application-history-list');d.append(node('summary','','Your corrections ('+history.length+')'));for(const h of history)list.append(node('li','','Revision '+h.revision+' · '+h.content));d.append(list);section.append(d);}
 }

 function fileRow(t:Task,a:Artifact){
  const row=node('li','application-file'+(a.current?' is-current':' is-historical'));row.dataset.applicationArtifact=a.id;
  row.append(node('span','application-file-kind',kind(a.mimeType)),node('span','portal-muted application-file-meta',(a.revision?'revision '+a.revision+' · ':'')+size(a.bytes)+' · sha256 '+a.sha256.slice(0,12)+'…'));
  row.append(button(IMAGES.has(a.mimeType)||a.mimeType==='application/pdf'?'Preview':'Open',()=>preview(t.taskId,a.id,{title:kind(a.mimeType)+(a.current?' · current':' · earlier revision'),expected:a}),'application-preview'));
  return row;
 }
 function files(t:Task){
  const groups=applicationArtifactGroups(t),section=node('section','application-files');section.append(node('h4','application-subheading','Documents and photos'));
  if(!groups.current.length)section.append(node('p','portal-muted application-empty',t.state==='working'?'Spindle is still preparing the current revision; no current document or photo yet.':'No current document or photo for revision '+t.revision+'.'));
  else{const ul=node('ul','application-file-list');for(const a of groups.current)ul.append(fileRow(t,a));section.append(ul);}
  if(groups.historical.length){const d=node('details','application-historical'),ul=node('ul','application-file-list');d.append(node('summary','','Earlier revisions ('+groups.historical.length+') · not current'));for(const a of groups.historical)ul.append(fileRow(t,a));d.append(ul);section.append(d);}
  if(groups.other.length){const d=node('details','application-other'),ul=node('ul','application-file-list');d.append(node('summary','','Other retained records ('+groups.other.length+')'));for(const a of groups.other)ul.append(fileRow(t,a));d.append(ul);section.append(d);}
  review.append(section);
 }

 function sources(t:Task){
  const list=t.sources as Source[];const section=node('section','application-sources');section.append(node('h4','application-subheading','Sources read'));
  if(!list.length){section.append(node('p','portal-muted application-empty','No sources recorded yet.'));review.append(section);return;}
  const ul=node('ul','application-source-list');
  for(const s of list){const li=node('li','application-source-item');li.append(node('span','',s.name??s.providerId??'Source'),node('span','portal-muted',' · '+(s.provider??'source')+(s.mimeType?' · '+s.mimeType:'')));
   if(s.snapshotArtifactId)li.append(button('Open snapshot',()=>preview(t.taskId,s.snapshotArtifactId!,{title:s.name??'Source snapshot',source:s,expected:s.sha256?{sha256:s.sha256}:undefined}),'application-source-open'));ul.append(li);}
  section.append(ul);review.append(section);
 }

 function outputs(t:Task){
  if(!t.outputs.length&&!(t.saves??[]).length)return;
  const section=node('section','application-outputs');section.append(node('h4','application-subheading','Saved copies'));
  for(const o of t.outputs){const p=node('p','application-output');p.append(badge(o.state,o.state),' revision '+o.revision+' ');
   let url:URL|undefined;try{url=o.url?new URL(o.url):undefined;}catch{}
   if(o.state==='verified'&&url?.protocol==='https:'){const a=node('a','application-output-link','Open verified Drive copy');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';p.append(a);}
   else p.append(node('span','portal-muted',o.state==='verified'?'Verified; no link recorded.':'Not verified in Drive.'));section.append(p);}
  for(const s of t.saves??[])section.append(node('p','portal-muted application-save-record',(s.kind==='draft'?'Draft':'Session')+' snapshot · revision '+s.revision+' · '+s.state+(s.error?' · '+s.error:'')));
  review.append(section);
 }

 function steps(t:Task){
  const entries=Object.entries(t.steps??{});if(!entries.length)return;
  const d=node('details','application-steps');d.append(node('summary','','Observed preparation steps ('+entries.length+')'));
  for(const [name,s] of entries)if(s)d.append(node('p','application-step-record',name+' · '+s.status+(s.code?' · '+s.code:'')));
  review.append(d);
 }

 function submission(task:Task){
  const t=task as Task&BrowserFacts,b=t.browser,run=t.portal,gate=config?.browserApproval,running=live(t.execution?.state);
  const section=node('section','application-submission');section.dataset.applicationSubmission=b?.submission?.state??'none';section.append(node('h4','application-subheading','Approve and submit'));
  section.append(node('p','portal-muted',gate?.available?'Spindle submits only after you approve the exact review below, once, to the configured '+(gate.mode==='developer_fictional'?'fictional test destination':'destination')+'. Nothing has been submitted unless a receipt is shown.':'Spindle never submits without your explicit approval. '+(gate?.reason==='PREPARATION_PROCESSING_PAUSED'?'Submission is held while processing is paused.':'Approval and submission are not enabled on this server.')+' Nothing has been submitted from here.'));
  if(b?.submission){
   const r=b.submission,p=node('p','application-receipt');p.dataset.applicationReceipt=r.state;
   p.append(badge(r.state==='verified'?'Receipt verified':'Outcome unknown',r.state==='verified'?'verified':'warning'),' Revision '+r.revision.revision+' to '+r.destination+(r.receipt?' · receipt '+r.receipt.receiptId.slice(0,16)+'… · content sha256 '+r.receipt.contentHash.slice(0,12)+'…':' · not verified yet; Spindle never resubmits'));
   section.append(p);
  }
  if(run&&run.state!=='verified'){const p=node('p',run.state==='running'?'portal-status application-run':'portal-error application-run',run.state==='running'?(run.action==='approve'?'Approved. Spindle is filling and submitting the reviewed form…':'Checking the receipt (read-only)…'):run.state==='cancelled'?'Stopped by you. '+(run.submission?'The outcome may be unknown; check the receipt.':'Nothing was submitted.'):applicationErrorMessage({code:run.interruption==='authority'?'PREPARATION_PORTAL_INTERRUPTED':run.interruption==='deadline'?'PREPARATION_PORTAL_DEADLINE_EXCEEDED':run.code??'PREPARATION_PORTAL_UNAVAILABLE'}));p.dataset.applicationRun=run.state;section.append(p);}
  const view=destination&&destination.revision===t.revision?destination.view:undefined,verified=b?.submission?.state==='verified';
  const actions=node('div','portal-actions');
  actions.append(button('Check destination (read-only)',async()=>{
   try{const v=await request<Review>('/preparation/browser-review',{taskId:t.taskId,expectedRevision:t.revision,fields:[],files:[]});if(!current()||task!==t)return;destination={revision:t.revision,view:v};}
   catch(error){if(applicationAuthFailure(error)||!/^PREPARATION_BROWSER_/.test(codeOf(error)))throw error;if(!current()||task!==t)return;destination={revision:t.revision,message:applicationErrorMessage(error)};}
   renderTask();
  },'application-destination'));
  const approve=button(gate?.available?'Approve and submit this exact review':'Approve and submit · unavailable',async()=>{
   const v=view!,key=t.taskId+':'+v.fingerprint;
   // One request identity per displayed review: a retry after an unknown outcome replays, never re-approves.
   if(!approvalIds.has(key))approvalIds.set(key,crypto.randomUUID());
   await request('/preparation/browser-approve',{taskId:t.taskId,expectedRevision:v.revision,fingerprint:v.fingerprint,requestId:approvalIds.get(key)});
   if(!current())return;say('Approved revision '+v.revision+'. Spindle is submitting it once; watch for the verified receipt.');await status();
  },'application-approve');
  const why=!gate?.available?(gate?.reason==='PREPARATION_PROCESSING_PAUSED'?'Processing is paused':'Approval is not enabled on this server'):!view?'Check the destination first':running?'Task is working':verified?'Already submitted and verified':b?.submission?'A submission exists; check its receipt':!['ready','blocked'].includes(t.state)?'Task is not ready':'';
  if(why){approve.dataset.applicationUnavailable='yes';approve.title=why;}
  actions.append(approve);
  if(gate?.available&&b?.submission&&!verified||t.canReconcile){const check=button('Check receipt (read-only)',async()=>{await request('/preparation/browser-reconcile',{taskId:t.taskId});if(!current())return;say('Checking the receipt read-only; nothing is resubmitted.');await status();},'application-reconcile');if(!t.canReconcile){check.dataset.applicationUnavailable='yes';check.title=running?'Task is working':'Not reconcilable automatically';}actions.append(check);}
  if(running&&run?.state==='running')actions.append(button('Stop',async()=>{await request('/preparation/cancel',{taskId:t.taskId});if(!current())return;say('Stopped. Spindle never resubmits; check the receipt if it may have been sent.');await status();},'application-stop'));
  section.append(actions);
  if(destination&&destination.revision===t.revision){
   if(view){
    const head=node('p','application-destination-result');head.append(badge('Read-only check'),' Revision '+view.revision+' would go to '+view.destination+' · review fingerprint '+view.fingerprint.slice(0,12)+'…');section.append(head);
    const plan=node('dl','application-review-plan');plan.dataset.applicationFingerprint=view.fingerprint;
    const row=(term:string,value:string,extra?:HTMLElement)=>{const dd=node('dd','',value);if(extra)dd.append(' ',extra);plan.append(node('dt','',term),dd);};
    row('Destination',view.destination);row('Submits to',view.review.post.url);row('Receipt page',view.review.receiptUrl);row('Revision',String(view.revision));row('Review fingerprint',view.fingerprint);
    for(const f of view.fields){const flags=node('span');if(f.corrected)flags.append(badge('Corrected by you','corrected'));flags.append(' '+f.citations.length+' source citation'+(f.citations.length===1?'':'s'));row(f.name+' ← '+f.label,f.value,flags);}
    for(const c of view.review.post.fields.filter(c=>!view.fields.some(f=>f.name===c.name)))row(c.name+' (set by Spindle)',c.value);
    for(const f of view.files){const open=button('Preview',()=>preview(t.taskId,f.artifactId,{title:f.field+' · '+f.filename,expected:{sha256:f.sha256}}),'application-review-file');row(f.field+' ← '+f.filename,kind(f.mimeType)+' · '+size(f.bytes)+' · current revision · sha256 '+f.sha256,open);}
    section.append(plan);
   }
   else section.append(node('p','portal-error application-destination-result',destination.message!));
  }
  review.append(section);
 }

 async function preview(taskId:string,artifactId:string,info:{title:string;expected?:{sha256:string};citation?:Citation;source?:Source}){
  const token=++sourceToken;revoke();placeholder(source,info.title,'Loading exact file from your account…','portal-muted application-loading');
  const expected=info.expected??task?.artifacts.find(a=>a.id===artifactId);
  const result=await request<{bytes:Uint8Array;mimeType:string}>('/preparation/artifact',{taskId,artifactId});
  if(!current()||token!==sourceToken||taskId!==selected)return;
  const bytes=new Uint8Array(result.bytes),sha=hex(await crypto.subtle.digest('SHA-256',bytes));
  if(!current()||token!==sourceToken||taskId!==selected)return;
  if(expected&&expected.sha256!==sha){placeholder(source,info.title,applicationMessages.ARTIFACT_HASH_MISMATCH!,'portal-error');return;}
  source.replaceChildren(node('h3','application-heading',info.title));source.dataset.applicationArtifact=artifactId;
  const meta=node('p','application-source-meta');meta.append(badge(expected?'SHA-256 verified':'SHA-256 '+sha.slice(0,12)+'…',expected?'verified':''),' '+kind(result.mimeType)+' · '+size(bytes.length));source.append(meta);
  if(info.source)source.append(node('p','portal-muted','From '+(info.source.name??info.source.providerId??'source')+(info.source.provider?' · '+info.source.provider:'')+(info.source.providerVersion?' · version '+info.source.providerVersion:'')));
  if(info.citation?.regions?.length&&!info.citation.regionPreview)source.append(node('p','portal-muted','The cited region is not outlined; the full snapshot is shown.'));
  const url=URL.createObjectURL(new Blob([bytes],{type:result.mimeType}));urls.add(url);
  if(IMAGES.has(result.mimeType)){const img=node('img','application-preview-image');img.src=url;img.alt=info.title;const unsupported=node('p','portal-muted','This browser cannot display the image; the exact download is still available.');unsupported.hidden=true;img.addEventListener('error',()=>{img.hidden=true;unsupported.hidden=false;},{signal,once:true});source.append(img,unsupported);}
  else if(result.mimeType==='application/pdf'){const open=node('a','application-preview-pdf','Open PDF in a new tab');open.href=url;open.target='_blank';open.rel='noopener noreferrer';source.append(open);}
  else if(TEXTS.has(result.mimeType)){const pre=node('pre','application-preview-text',new TextDecoder().decode(bytes.subarray(0,65536)));source.append(pre);}
  else source.append(node('p','portal-muted','No inline preview for this file type.'));
  const download=node('a','application-download','Download exact file');download.href=url;download.download='spindle-'+taskId.slice(0,8)+'-'+artifactId.slice(0,8)+'.'+(EXTENSIONS[result.mimeType]??'bin');
  const actions=node('div','portal-actions');actions.append(download);source.append(actions);
 }

 async function loadCompose(){
  compose.replaceChildren(node('h3','application-heading','New application'));const connect=node('a','','Connect Google or choose a source folder');connect.href='/connections';compose.append(connect);
  if(config?.processingPaused){compose.append(node('p','portal-muted','New requests are held while processing is paused.'));return;}
  const response=await request<GoogleConnections>('/google/list',{}).catch(error=>{if(applicationAuthFailure(error))throw error;return undefined;});if(!current())return;
  connections=response?.connections.filter(c=>c.status==='connected'&&c.roots.length)??[];
  if(!response){compose.append(node('p','portal-muted','Google connections are unavailable on this server, so new requests cannot start here.'));return;}
  if(!connections.length){compose.append(node('p','portal-muted application-empty','Connect Google and choose a source folder first. Existing tasks stay readable.'));return;}
  const folder=node('select','application-folder'),text=node('textarea','application-request-text'),consent=node('input'),saveOutputs=node('input');
  for(const c of connections)for(const rootId of c.roots){const o=node('option','',(c.accountId??'Google account')+' · selected folder '+(c.roots.indexOf(rootId)+1));o.value=JSON.stringify([c.id,rootId]);folder.append(o);}
  text.rows=4;text.maxLength=16384;text.placeholder='What should Spindle prepare? e.g. “Fill the registration form from my acceptance email.”';text.setAttribute('aria-label','Application request');
  consent.type='checkbox';consent.className='application-consent';saveOutputs.type='checkbox';saveOutputs.className='application-save-outputs';
  const limits=config?.limits;
  const consentLabel=node('label','application-check');consentLabel.append(consent,' I agree Spindle may process documents and images from this folder with its configured models for this request'+(limits?' (limit US$'+limits.limitUsd+')':'')+'.');
  const saveLabel=node('label','application-check');saveLabel.append(saveOutputs,' Also save prepared files to Google Drive (needs Drive permission). Unchecked keeps a local draft.');
  let folderChecked=false;
  const intent=()=>JSON.stringify([folder.value,text.value,saveOutputs.checked]);
  const check=button('Check source folder',async()=>{folderChecked=false;submit.dataset.applicationUnavailable='yes';const [connectionId,rootId]=JSON.parse(folder.value) as [string,string];const metadata=await request<{providerId:string;providerVersion:string;mimeType:string}>('/google/drive/check',{connectionId,rootId});if(!current())return;if(metadata.providerId!==rootId||metadata.mimeType!=='application/vnd.google-apps.folder'||typeof metadata.providerVersion!=='string')throw Error('GOOGLE_ROOT_DENIED');folderChecked=true;delete submit.dataset.applicationUnavailable;say('Source folder checked. No preparation was started.');},'application-check-folder');
  folder.addEventListener('change',()=>{folderChecked=false;submit.dataset.applicationUnavailable='yes';say('Check the selected folder before preparing files.');lock();},{signal});
  const submit=button('Prepare application',async()=>{
   if(!folderChecked||!consent.checked||!text.value.trim()){say('Write a request and confirm processing consent first.',true);return;}
   const [connectionId,rootId]=JSON.parse(folder.value) as [string,string],key=intent();
   // One stable identity per exact intent: a user retry after an unknown outcome is idempotent, never a second task.
   if(!requestIds.has(key))requestIds.set(key,crypto.randomUUID());
   const receipt=await request<{taskId:string;revision:number;state:string}>('/preparation/request',{connectionId,rootId,request:text.value,requestId:requestIds.get(key),processingConsent:true,saveOutputs:saveOutputs.checked});
   if(!current())return;consent.checked=false;say('Request accepted. Spindle is preparing it; nothing will be submitted without your approval.');
   await loadList();await select(receipt.taskId);
  },'application-submit-request');submit.dataset.applicationUnavailable='yes';
  const folderLabel=node('label','application-label','Source folder '),textLabel=node('label','application-label','Request '),actions=node('div','portal-actions');
  folderLabel.append(folder);textLabel.append(text);actions.append(check,submit);compose.append(folderLabel,textLabel,consentLabel,saveLabel,actions);lock();
 }

 function showSetup(){placeholder(list,'Let’s get your sources ready',applicationMessages.PREPARATION_NOT_CONFIGURED!,'portal-muted application-unsupported');const connect=node('a','application-setup-link','Connect Google and choose your files');connect.href='/connections';list.append(connect);compose.hidden=true;review.hidden=true;source.hidden=true;layout.dataset.applicationUnavailable='yes';}

 async function start(){
  placeholder(review,'Application','Choose a task to review its prepared answers, sources and files.');
  placeholder(source,'Sources','Choose a source citation or file to preview it here.');
  try{config=await request<Config>('/preparation/config',{});}
  catch(error){if(codeOf(error)==='PREPARATION_NOT_CONFIGURED'||codeOf(error)==='ACCOUNT_HTTP_404'||(error as {status?:number})?.status===503){if(!current())return;showSetup();return;}throw error;}
  if(!current())return;
  if(config.configured===false){showSetup();return;}
  pause.hidden=!config.processingPaused;pause.textContent=config.processingPaused?'Preparation is temporarily unavailable. You can still review saved work and connect your sources. Nothing starts automatically.':'';
  await loadList();await loadCompose();lock();
 }
 if(!owner){placeholder(review,'Application','Sign in to see your applications.','portal-muted');}
 else void act(start).then(()=>{if(current()&&!list.querySelector('ul,.application-empty,.application-unsupported'))list.replaceChildren(node('h3','application-heading','Tasks'),node('p','portal-error application-error','Tasks could not be loaded. Retained work is unchanged.'),button('Try again',start));lock();});

 const unmount=()=>{if(disposed)return;disposed=true;stop();sourceToken++;taskToken++;local.abort();revoke();drafts.clear();root.replaceChildren();};
 if(context.signal.aborted)unmount();else context.signal.addEventListener('abort',unmount,{once:true});
 return unmount;
}
