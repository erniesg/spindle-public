import type { PreviewVisit } from './session.js';
import type { CaptureClassification } from './classification.js';
import type { Assignment } from '../classification/types.js';
import {mountDesktopPomodoro} from '../pomodoro/desktop-ui.js';
import type {FocusDial} from '../pomodoro/focus-dial.js';
type StatusState='idle'|'loading'|'success'|'error';
// Shared primitives and the approved Lock-in dial are loaded from their own
// served modules; a host that does not serve them keeps the plain controls.
let ui:typeof import('../ui/dom.js')|undefined;
const shared=Promise.all([import('../ui/dom.js'),import('../pomodoro/focus-dial.js')]).then(([dom,dial])=>{ui=dom;return dial;}).catch(()=>undefined);
const say=(id:string,state:StatusState,text:string)=>{const node=el(id);node.dataset.state=state;node.textContent=text;};
let classificationState:ReturnType<CaptureClassification['snapshot']>|null=null,correction:Assignment|null=null;
const el=(id:string)=>{const x=document.getElementById(id);if(!x)throw new Error('UI_MISSING');return x;};
const input=(id:string)=>{const x=el(id);if(!(x instanceof HTMLInputElement))throw new Error('INPUT_MISSING');return x;};
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let stopped=false,first=true,readbackGeneration=0,ownerGeneration=-1;
// Revoke/clear/stop may originate outside this page. Owner revisions invalidate
// both rendered saved copies and responses already in flight; never roll back.
function observeOwnerGeneration(value:unknown){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value<ownerGeneration)return false;
 // Owner replies carry their own revision. Do not advance the local-control
 // fence here: a current-revision Restore may legitimately follow Pause's poll.
 if(value!==ownerGeneration){ownerGeneration=value;el('saved').replaceChildren();dismissCorrection();}
 return true;
}
async function api(path:string,body?:unknown){const response=await fetch('/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!response.ok){const result=await response.json();throw new Error(typeof result.code==='string'?result.code:'Operation unavailable');}return response.json();}
for(const action of ['stage','install','inspect'])el('chrome-'+action).onclick=()=>{
 const button=el('chrome-'+action) as HTMLButtonElement;button.disabled=true;
 void api('chrome/'+action,action==='stage'?{}:{extensionId:input('chrome-extension-id').value.trim()}).then(result=>{
  el('chrome-install-status').textContent=action==='stage'?`Load unpacked from ${result.directory}. Then register its public ID here.`:`Registration: ${result.registration}; extension: ${result.extension}. Live connection remains unverified here; explicitly pair in Chrome and observe actual capture/blocking.`;
 }).catch(error=>{el('chrome-install-status').textContent=error instanceof Error?error.message:'Chrome setup unavailable';}).finally(()=>{button.disabled=false;});
};
el('chrome-replace-pairing').onclick=()=>{
 retireEarnedAccessContext();const button=el('chrome-replace-pairing') as HTMLButtonElement;button.disabled=true;
 void api('chrome/replace-pairing',{}).then(()=>{
  el('chrome-install-status').textContent='Chrome pairing replaced. History kept and recording paused. Enter the fresh pairing code in the replacement profile’s options, then choose its sites and permissions.';
  input('pomodoro-extension-access').checked=false;
 }).catch(error=>{el('chrome-install-status').textContent=error instanceof Error?error.message:'Pairing recovery unavailable; retry after the protected key is ready.';}).finally(()=>{button.disabled=false;});
};
const pomodoro=mountDesktopPomodoro(el('pomodoro'),async(path,data)=>{
 const response=await fetch(path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});return response.json();
},()=>input('pomodoro-origin').value,enabled=>{input('pomodoro-extension-access').checked=enabled;el('pomodoro-access-status').textContent=enabled?'Paired profile may control this account timer.':'Extension timer access is off.';});
// Presentation only: the existing PomodoroClient owns state, remaining time and actions.
const timerView=el('pomodoro').querySelector<HTMLElement>('.pomodoro');
timerView?.classList.add('pomodoro-view');
for(const button of el('pomodoro').querySelectorAll('button')){button.classList.add('sp-button');button.dataset.variant=['start','resume','next'].includes(button.dataset.action??'')?'primary':'secondary';}
for(const field of el('pomodoro').querySelectorAll<HTMLInputElement>('input:not([type=checkbox])'))field.classList.add('sp-field');
el('pomodoro').querySelector('.connection')?.classList.add('sp-status');
let dial:FocusDial|undefined;
void shared.then(module=>{
 const article=timerView?.querySelector('article');if(!module||!article||stopped)return;
 dial=module.createFocusDial(document);article.prepend(dial.root);
 const paint=()=>{if(stopped||!dial)return;const timer=pomodoro.client.snapshot?.timer;dial.update(timer?{phase:timer.phase,status:timer.status,remainingMs:pomodoro.client.remaining(),totalMs:timer.phase==='break'?timer.durations.breakMs:timer.durations.focusMs}:{});requestAnimationFrame(paint);};
 paint();
});
el('pomodoro-access-apply').onclick=()=>{const button=el('pomodoro-access-apply') as HTMLButtonElement;button.disabled=true;void pomodoro.setExtensionAccess(input('pomodoro-extension-access').checked).then(result=>{const enabled=!!result&&typeof result==='object'&&'enabled'in result&&result.enabled===true;input('pomodoro-extension-access').checked=enabled;el('pomodoro-access-status').textContent=enabled?'Paired profile may control this account timer.':'Extension timer access is off.';}).catch(()=>{el('pomodoro-access-status').textContent='Access unavailable. Sign in, pair the profile and refresh this account first.';}).finally(()=>{button.disabled=false;});};
let setupLoaded=false,timerOriginLoaded=false,preferencesLoaded=false,nextTrackingPoll=0;
let workosRevision=0,workosConnected='';
const workosLink=()=>{const link=el('workos-open');if(!(link instanceof HTMLAnchorElement))throw Error('UI_MISSING');return link;};
function hideWorkOSLink(){const link=workosLink();link.hidden=true;link.removeAttribute('href');}
async function workosStatus(){
 const revision=workosRevision,state=await api('auth/workos/status');if(revision!==workosRevision||stopped)return;
 el('workos-cancel').hidden=state.state!=='waiting';
 if(state.state!=='waiting')hideWorkOSLink();
 el('workos-status').textContent=state.state==='connected'?`Signed in as ${state.accountName} · account ${state.accountId} · ${state.backendOrigin}. Recording and new uploads require consent and Start.`:state.state==='waiting'?`Waiting for browser sign-in · ${state.backendOrigin}. Use the browser link above.`:state.state==='failed'?`Sign-in unavailable · ${state.code}. You can retry after checking the backend and OS-protected key.`:'Browser sign-in is idle. See the saved history and timer connection status below.';
 if(state.state==='connected'&&workosConnected!==state.accountName+'@'+state.backendOrigin){
  retireEarnedAccessContext();workosConnected=state.accountName+'@'+state.backendOrigin;input('pomodoro-origin').value=state.backendOrigin;timerOriginLoaded=true;setupLoaded=false;await pomodoro.client.connect();
 }
}
el('workos-begin').onclick=()=>{
 retireEarnedAccessContext();const revision=++workosRevision,button=el('workos-begin') as HTMLButtonElement;button.disabled=true;hideWorkOSLink();workosConnected='';
 void api('auth/workos/begin',{origin:input('workos-origin').value.trim(),deviceName:input('workos-device').value.trim(),syncConsent:input('workos-consent').checked}).then(async result=>{
  if(revision!==workosRevision||stopped)return;
  const url=new URL(result.authorizationUrl);if(url.origin!=='https://api.workos.com'||url.pathname!=='/user_management/authorize')throw Error('Invalid sign-in link');
  const link=workosLink();link.href=url.toString();link.hidden=false;await workosStatus();
 }).catch(error=>{if(revision===workosRevision)el('workos-status').textContent=error instanceof Error?error.message:'Sign-in unavailable';}).finally(()=>{button.disabled=false;});
};
el('workos-cancel').onclick=()=>{workosRevision++;hideWorkOSLink();void api('auth/workos/cancel',{}).then(workosStatus).catch(()=>{el('workos-status').textContent='Sign-in cancellation or credential cleanup is unconfirmed. Retry cancellation.';});};

input('pomodoro-origin').addEventListener('input',()=>{timerOriginLoaded=true;});
for(const field of ['tracking-origin','tracking-name','tracking-device'])input(field).addEventListener('input',()=>{setupLoaded=true;});
async function trackingStatus(){
 nextTrackingPoll=Date.now()+2000;await workosStatus().catch(()=>{el('workos-status').textContent='Sign-in state unavailable; no connection claimed.';});const state=await api('tracking/status');
 if(!setupLoaded&&state.setup){input('tracking-origin').value=state.setup.origin;if(!timerOriginLoaded)input('pomodoro-origin').value=state.setup.origin;input('tracking-name').value=state.setup.name;input('tracking-device').value=state.setup.deviceName;setupLoaded=true;}
 const c=state.client;
 if(c&&!earnedLoaded&&earnedRevision===0)void earnedAction('read',{},'Balance read from your account.').catch(()=>{});
 el('tracking-status').textContent=c?`${c.account}${c.accountId?' · account '+c.accountId:''} · ${c.deviceName} · device ${c.deviceId} · ${c.pending} pending · ${c.awaitingHistory} awaiting history · last sync ${c.lastSync?new Date(c.lastSync).toLocaleString():'never'} · ${c.error||'no sync error'} · collector ${state.historyStatus}. Recording/upload still require Start.`:'Not connected. Enable the OS-protected key, then connect explicitly.';
}
for(const action of ['signin','sync','devices'])el('tracking-'+action).onclick=()=>{
 const button=el('tracking-'+action) as HTMLButtonElement;button.disabled=true;
 void (async()=>{
  if(action==='signin'){
   retireEarnedAccessContext();const password=input('tracking-password').value;input('tracking-password').value='';
   await api('tracking/signin',{origin:input('tracking-origin').value,name:input('tracking-name').value,password,deviceName:input('tracking-device').value,register:input('tracking-register').checked});
   input('pomodoro-origin').value=input('tracking-origin').value;input('tracking-register').checked=false;
  }else if(action==='devices'){
   const result=await api('tracking/devices');el('tracking-device-list').textContent=result.devices.map((d:{name:string;id:string;lastUploadAt:number|null})=>`${d.name} · ${d.id} · last upload ${d.lastUploadAt?new Date(d.lastUploadAt).toLocaleString():'never'} · remote pending/error unknown`).join('\n');
  }else await api('tracking/sync',{});
  await trackingStatus();el('tracking-message').textContent=action==='signin'?'Connected; recording and upload remain off until explicit Start.':action==='sync'?'Sync attempt completed; see pending counts above.':'Device receipt times refreshed; remote pending state remains unknown.';
 })().catch(error=>{el('tracking-message').textContent=`${error instanceof Error?error.message:'Unavailable'}. Pause before sign-in. Renew the same account/service; an account/service change cannot adopt this queue. Offline work stays queued. Retry key setup after KEY_READY if needed.`;}).finally(()=>{button.disabled=false;});
};
// Earned leisure: the account ledger decides; this page only shows its reply.
let earnedRevision=0,earnedLoaded=false,earnedGranted=false,earnedGrantKnown=false;
let earnedAccessDirty=false,earnedAccessEdit=0,earnedAccessContext=0;
type EarnedAccessAction={desired:boolean;edit:number;context:number};
let earnedAccessPending:EarnedAccessAction|undefined;
// The checkbox is a draft; only replies/readback describe the actual grant.
function earnedAccessText(){
 const actual=earnedGrantKnown?(earnedGranted?'Chrome earned-leisure access is on.':'Chrome earned-leisure access is off.'):'Chrome earned-leisure access is unknown.';
 return actual+(earnedAccessDirty?` Unapplied selection would ${input('earned-access').checked?'enable':'disable'} access; choose Apply to submit it.`:'');
}
function observeEarnedAccess(enabled:boolean,resolution?:EarnedAccessAction){
 earnedGranted=enabled;earnedGrantKnown=true;
 if(resolution&&resolution===earnedAccessPending&&resolution.context===earnedAccessContext&&resolution.edit===earnedAccessEdit)earnedAccessDirty=false;
 if(!earnedAccessDirty)input('earned-access').checked=enabled;
}
function retireEarnedAccessContext(){
 earnedAccessContext++;earnedRevision++;earnedAccessEdit++;earnedAccessDirty=false;earnedGrantKnown=false;
 input('earned-access').checked=false;
 say('earned-status','loading','Account or pairing change pending. Chrome earned-leisure access is unknown until readback.');
}
input('earned-access').addEventListener('change',()=>{
 earnedAccessDirty=true;earnedAccessEdit++;
 say('earned-status',earnedGrantKnown?'idle':'error',earnedAccessText());
});
const duration=(s:number)=>s>=60?`${Math.floor(s/60)} min${s%60?` ${s%60} s`:''}`:`${s} s`;
function drawEarned(value:{enabled?:boolean;balance?:{earnedSeconds:number;spentSeconds:number;availableSeconds:number};policy?:{ratio:number;windowHours:number;minimumSeconds:number;maximumSeconds:number}}){
 const b=value.balance;if(!b)return;
 input('earned-optin').checked=value.enabled===true;earnedLoaded=true;
 el('earned-balance').textContent=value.enabled?`${duration(b.availableSeconds)} available · ${duration(b.earnedSeconds)} earned · ${duration(b.spentSeconds)} spent in the last ${value.policy?.windowHours??24} h`:'Earned leisure is off for this account.';
}
async function earnedAction(path:string,body:unknown,done:string,accessAction?:EarnedAccessAction){
 const revision=++earnedRevision;say('earned-status','loading','Checking your account…');
 try{const result=await api('earned/'+path,body);if(revision!==earnedRevision||stopped)return result;if(path!=='access')drawEarned(result);say('earned-status','success',done);return result;}
 catch(error){
  if(revision===earnedRevision&&!stopped){
   const code=error instanceof Error?error.message:'Unavailable';
   say('earned-status','error',`${code}. Result unknown; checking the current account state…`);
   try{
    if(path==='access'){
     const state=await api('state');if(revision===earnedRevision&&!stopped){observeEarnedAccess(state.earnedAccess===true,accessAction);}
    }else{
     const current=await api('earned/read',{});if(revision===earnedRevision&&!stopped)drawEarned(current);
    }
    if(revision===earnedRevision&&!stopped)say('earned-status','error',`${code}. The action reply was unknown. Current ${path==='access'?'Chrome access':'account balance'} was read back; no action was retried.${path==='access'?' '+earnedAccessText():''}`);
   }catch{if(revision===earnedRevision&&!stopped){if(path==='access')earnedGrantKnown=false;say('earned-status','error',`${code}. Result unknown. Current state is unavailable; refresh to check before trying again.`);}}
  }
  throw error;
 }
}
el('earned-refresh').onclick=()=>void earnedAction('read',{},'Balance read from your account.').catch(()=>{});
el('earned-optin-apply').onclick=()=>{const enabled=input('earned-optin').checked;void earnedAction('opt-in',{enabled},enabled?'Counting starts now. Only your own learning labels on observed time earn leisure.':'Earned leisure is off; unspent time was dropped.').catch(()=>{});};
el('earned-access-apply').onclick=()=>{
 const button=el('earned-access-apply') as HTMLButtonElement,field=input('earned-access');
 if(earnedAccessPending)return;
 const action:EarnedAccessAction={desired:field.checked,edit:earnedAccessEdit,context:earnedAccessContext};
 earnedAccessPending=action;button.disabled=true;field.disabled=true;
 const current=()=>!stopped&&earnedAccessPending===action&&action.context===earnedAccessContext;
 void earnedAction('access',{enabled:action.desired},'',action).then(result=>{
  if(!current())return;
  const enabled=!!result&&typeof result==='object'&&'enabled'in result&&result.enabled===true;
  observeEarnedAccess(enabled,action);say('earned-status',enabled?'success':'idle',earnedAccessText());
 }).catch(()=>{}).finally(()=>{
  if(earnedAccessPending===action){earnedAccessPending=undefined;button.disabled=false;field.disabled=false;}
 });
};
function finishQuit(){
 retireEarnedAccessContext();stopped=true;workosRevision++;hideWorkOSLink();classificationState=null;dismissCorrection();el('visits').replaceChildren();el('saved').replaceChildren();pomodoro.dispose();dial=undefined;say('status','idle','Stopped; close this tab.');earnedRevision++;el('pomodoro-access-status').textContent='Desktop controls closed. Shared timer is unchanged.';
}
el('pomodoro-quit').onclick=()=>{retireEarnedAccessContext();readbackGeneration++;void api('quit',{}).then(finishQuit).catch(()=>{el('pomodoro-access-status').textContent='Quit unconfirmed. Reconnect to check the desktop host.';});};
function draw(section:HTMLElement,visits:PreviewVisit[]){
 section.replaceChildren();for(const v of [...visits].reverse()){
  const article=document.createElement('article'),heading=document.createElement('h2'),text=document.createElement('pre'),meta=document.createElement('p');
  heading.textContent=v.title||v.app;meta.textContent=`${v.id.slice(0,8)} · ${v.url} · ${v.availability} · ${(Math.max(0,(v.end??v.start)-v.start)/1000).toFixed(2)}s closed duration`;
  text.textContent=v.text||'Text unavailable';article.append(heading,meta,text);
  if(v.capture){
   const c=v.capture,details=document.createElement('p');
   const stage=(value:string)=>value.replace(/-/g,' ');
   details.textContent=`Capture: ${stage(c.pixels)}. OCR: ${stage(c.ocr)}.${c.imageWidth>0?` Screenshot ${c.image==='image-retained-reduced'?'reduced to ':''}${c.imageWidth}×${c.imageHeight}${c.image==='image-retained-reduced'?` from ${c.sourceWidth}×${c.sourceHeight} to fit the retained-image byte budget`:''}.`:` Screenshot: ${stage(c.image)}.`}`;
   article.append(details);
  }
  if(v.image){const image=document.createElement('img');image.alt='Rich screenshot captured for this same visit';image.src='data:image/png;base64,'+v.image;article.append(image);}
  if(section.id==='visits'&&classificationState?.enabled){
   const assignment=classificationState.assignments.find(a=>a.ref.visitId===v.id),note=document.createElement('p');
   if(assignment){
    const name=(id:string|null)=>assignment.concepts.find(c=>c.id===id)?.name??'Activity unclear';
    const origin=assignment.source==='override'?'Your correction':assignment.source==='rule'?'Your saved rule':assignment.source==='abstention'?'Not enough evidence yet':assignment.inferenceSource?.engine==='local-code-cue'?'Local suggestion (uncertain)':'Model suggestion (uncertain)';
    note.textContent=`${name(assignment.labels.categoryId)} · ${name(assignment.labels.activityId)} — ${origin}`;
   }else note.textContent='No label available for this context yet';article.append(note);
   if(assignment){
    const details=document.createElement('details'),summary=document.createElement('summary'),basis=document.createElement('pre');summary.textContent='How this label was chosen';basis.textContent=assignment.basis;details.append(summary,basis);article.append(details);
    const correct=ui?ui.button('Correct labels'):document.createElement('button');correct.textContent='Correct labels';correct.onclick=()=>openCorrection(assignment);article.append(correct);
    for(const mode of ['text','image'] as const){if(mode==='image'&&!v.image)continue;const suggest=ui?ui.button(''):document.createElement('button');suggest.textContent=mode==='image'?'Classify Rich image + text':'Classify text with Nebius';suggest.disabled=classificationState.busy||!classificationState.model||!classificationState.remote[mode];suggest.onclick=()=>void classifyAction('classify',{visit:v.id,mode});article.append(suggest);}
   }
  }
  section.append(article);
 }
}
function dialog(){const d=el('correction-dialog');if(!(d instanceof HTMLDialogElement))throw new Error('DIALOG_MISSING');return d;}
function dismissCorrection(){correction=null;dialog().close();el('correction-category').replaceChildren();el('correction-activity').replaceChildren();}
function openCorrection(assignment:Assignment){
 dismissCorrection();correction=assignment;const category=el('correction-category'),activity=el('correction-activity');
 const none=document.createElement('option');none.value='';none.textContent='Activity unknown';activity.append(none);
 for(const concept of classificationState?.catalogue??[]){const option=document.createElement('option');option.value=concept.id;option.textContent=concept.name;(concept.kind==='category'?category:activity).append(option);}
 (category as HTMLSelectElement).value=assignment.labels.categoryId;(activity as HTMLSelectElement).value=assignment.labels.activityId??'';dialog().showModal();
}
el('correction-cancel').onclick=dismissCorrection;
el('correction-save').onclick=()=>{const selected=correction;if(!selected)return;const category=(el('correction-category') as HTMLSelectElement).value,activity=(el('correction-activity') as HTMLSelectElement).value;dismissCorrection();void classifyAction('correct',{visit:selected.ref.visitId,ref:selected.ref,labels:{categoryId:category,activityId:activity||null,relatedIds:selected.labels.relatedIds}});};
async function classifyAction(action:string,body:unknown){try{const result=await api('classification/'+action,body);el('message').textContent=result.status??'Classification settings updated';}catch{el('message').textContent='Classification unavailable; capture/local-only operation is independent';}}
el('local-enable').onclick=()=>void classifyAction('local',{enabled:true});
el('local-disable').onclick=()=>void classifyAction('local',{enabled:false});
el('remote-apply').onclick=()=>{if(input('remote-image').checked)input('remote-text').checked=true;void classifyAction('remote',{text:input('remote-text').checked,image:input('remote-image').checked});};
el('remote-revoke').onclick=()=>void classifyAction('remote',{text:false,image:false});
for(const action of ['fixtures','key','start','pause','clear','restore','feedback','quit'])el(action).addEventListener('click',async()=>{if(action==='key'||action==='quit')retireEarnedAccessContext();if(['clear','quit','start','pause'].includes(action))readbackGeneration++;const generation=readbackGeneration;try{
 if(action==='feedback'){const data=JSON.stringify(await api('feedback'),null,2);const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='spindle-preview-feedback.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
 const body=action==='start'?{apps:input('apps').value.split(',').map(x=>x.trim()).filter(Boolean),pixels:input('pixels').checked,rich:input('rich').checked,retain:input('retain').checked,upload:input('tracking-upload').checked,retentionMs:Number(input('tracking-retention').value)*3600000}:{};
 const result=await api(action,body);el('message').textContent='Completed locally';
 if(action==='restore'&&generation===readbackGeneration&&!stopped){if(!observeOwnerGeneration(result.generation))return;if(result.saved&&Array.isArray(result.saved.visits))draw(el('saved'),result.saved.visits);else el('saved').textContent='No unexpired saved context.';}
 if(action==='clear'){classificationState=null;dismissCorrection();el('saved').replaceChildren();el('visits').replaceChildren();}
 if(action==='quit')finishQuit();
}catch(e){el('message').textContent=e instanceof Error?e.message:'Unavailable';}});
async function poll(){if(stopped)return;const earnedReadRevision=earnedRevision,earnedAccessReadIdle=!(el('earned-access-apply') as HTMLButtonElement).disabled;try{
 const state:{mode?:string;settingsReady?:boolean;timerOrigin?:string;preferences?:{apps:string[];pixels:boolean;retain:boolean;rich:boolean};pomodoroAccess?:boolean;earnedAccess?:boolean;generation:number;platform:string;recording:boolean;provider:string;lastCode:string;capabilities?:{accessibility:string;screenRecording:string};pair:string;visits:PreviewVisit[];classification?:ReturnType<CaptureClassification['snapshot']>}=await api('state');
 if(stopped)return; // A state reply already in transit cannot recreate readback after Quit.
 el('pomodoro-pair').textContent=state.pair;
 el('pomodoro-access-status').textContent=state.pomodoroAccess?'Paired profile may control this account timer.':'Extension timer access is off.';
 // A poll begun during access mutation may contain its pre-commit grant even
 // when its reply arrives after the action has finished. Only idle-start reads apply.
 if(earnedAccessReadIdle&&earnedReadRevision===earnedRevision&&state.mode!=='timer-only'&&!(el('earned-access-apply') as HTMLButtonElement).disabled){const enabled=state.earnedAccess===true,changed=!earnedGrantKnown||earnedGranted!==enabled;observeEarnedAccess(enabled);if(changed||earnedAccessDirty)say('earned-status','idle',earnedAccessText());}
 if(state.mode==='timer-only'){el('capture-controls').hidden=true;return;}
 if(Number.isSafeInteger(state.generation)&&state.generation<ownerGeneration)return;
 if(!observeOwnerGeneration(state.generation))throw new Error('OWNER_REVISION_UNAVAILABLE');
 if(first&&state.platform==='win32')input('apps').value='photos';first=false;
 if(state.settingsReady&&!timerOriginLoaded&&state.timerOrigin){input('pomodoro-origin').value=state.timerOrigin;timerOriginLoaded=true;}
 if(state.settingsReady&&!preferencesLoaded){const p=state.preferences;if(p){input('apps').value=p.apps.join(',');input('pixels').checked=p.pixels;input('retain').checked=p.retain;input('rich').checked=p.rich;}preferencesLoaded=true;}
 if(Date.now()>=nextTrackingPoll)await trackingStatus().catch(()=>{el('tracking-status').textContent='Account state unavailable; no sync success claimed.';});
 classificationState=state.classification??null;
 el('classification-status').textContent=classificationState?`Local labels ${classificationState.enabled?'on':'off'} · ${classificationState.code} · model ${classificationState.model??'not configured'} · remote text ${classificationState.remote.text?'on':'off'}, image ${classificationState.remote.image?'on':'off'}`:'Classification not configured';
 say('status',state.recording?'success':state.provider==='ready'?'idle':'error',`${state.recording?'Recording':'Paused'} · ${state.provider} · ${state.lastCode}${state.capabilities ? ` · Accessibility: ${state.capabilities.accessibility} · Screen Recording: ${state.capabilities.screenRecording}` : ''}`);el('pair').textContent=state.pair;draw(el('visits'),state.visits);
}catch{classificationState=null;dismissCorrection();readbackGeneration++;el('saved').replaceChildren();el('visits').replaceChildren();say('status','error','Runner disconnected');}finally{if(!stopped)setTimeout(()=>void poll(),750);}}
void poll();
