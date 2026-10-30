import type {PortalContext} from './types.js';
import {button,setStatus as setRegion,statusRegion} from '../../ui/dom.js';
/**
 * Tracking lane: shared account devices/history/session summary plus Mac-first
 * onboarding guidance. Reads only existing authenticated GET /devices, /history
 * and /sessions through context.client. It never controls, emulates or infers
 * the local native app, OS permissions, consents or package downloads.
 */
export interface TrackingDevice {id:string;name:string;lastUploadAt:number|null}
export interface TrackingEntry {key:string;deviceId:string;seq:number;deleted:boolean;app:string;title:string;browser:boolean;start:number|null;end:number|null;contextExpired:boolean}
export interface TrackingSummary {from:number;to:number;personTime:number;perDevice:Record<string,number>;visits:number;blocks:number;gaps:number;anomalies:number;attribution:string;rows:SummaryVisit[]}
export interface TrackingPage {entries:TrackingEntry[];skipped:number;cursor:number;hasMore:boolean}
/** Timers/clock are injectable for tests only; mountTracking uses the real ones. */
export interface TrackingOptions {now?:()=>number;setTimer?:(run:()=>void,ms:number)=>unknown;clearTimer?:(id:unknown)=>void;pollMs?:number;pagesPerSync?:number}
type Failure={kind:'aborted'|'changed'|'signin'|'offline'|'unsupported'|'bound'|'invalid'|'denied';text:string};
type StepState='done'|'action'|'unavailable'|'unknown'|'pending';

const DAY=86400000,RANGES=[{id:'day',label:'Last 24 hours',ms:DAY},{id:'week',label:'Last 7 days',ms:7*DAY}] as const;
const MAX_ROWS=200,MAX_ENTRIES=10000;
const obj=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=(x:unknown,max:number)=>typeof x==='string'&&x.length<=max?x:undefined;
const count=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?x:undefined;
const finite=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)?x:undefined;
const invalid=()=>Error('TRACKING_INVALID_RESPONSE');

export function parseDevices(value:unknown):TrackingDevice[]{
 if(!obj(value)||!Array.isArray(value.devices)||value.devices.length>64)throw invalid();
 return value.devices.map(d=>{
  const id=obj(d)?text(d.id,64):undefined,name=obj(d)?text(d.name,80):undefined,last=obj(d)?d.lastUploadAt:undefined;
  if(!id||name===undefined||!(last===null||finite(last)!==undefined))throw invalid();
  return {id,name,lastUploadAt:last as number|null};
 });
}
/** Malformed entries are counted and skipped, never repaired into plausible activity. */
export function parseHistory(value:unknown,previous:number):TrackingPage{
 if(!obj(value)||!Array.isArray(value.entries)||value.entries.length>16||typeof value.hasMore!=='boolean')throw invalid();
 const cursor=count(value.cursor);if(cursor===undefined||cursor<previous)throw invalid();
 let skipped=0;const entries:TrackingEntry[]=[];
 for(const e of value.entries){
  const key=obj(e)?text(e.key,512):undefined,deviceId=obj(e)?text(e.deviceId,64):undefined,seq=obj(e)?count(e.seq):undefined;
  if(!obj(e)||!key||!deviceId||seq===undefined||seq<=previous||seq>cursor||typeof e.deleted!=='boolean'){skipped++;continue;}
  const r=obj(e.record)?e.record:undefined,v=r&&obj(r.visit)?r.visit:undefined;
  if(e.deleted||!r||!v){entries.push({key,deviceId,seq,deleted:true,app:'',title:'',browser:false,start:null,end:null,contextExpired:true});continue;}
  const wall=finite(r.wallAnchor),mono=finite(r.monotonicAnchor),start=finite(v.start),end=v.end===null?null:finite(v.end);
  const app=text(v.app,256)??'',title=text(v.title,1024)??'';
  if(wall===undefined||mono===undefined||start===undefined||end===undefined){skipped++;continue;}
  const expiresAt=finite(v.expiresAt);
  entries.push({key,deviceId,seq,deleted:false,app,title,browser:v.browser===true,start:wall+start-mono,end:end===null?null:wall+end-mono,contextExpired:expiresAt===undefined||expiresAt<=Date.now()});
 }
 return {entries,skipped,cursor,hasMore:value.hasMore};
}
export function parseSummary(value:unknown):TrackingSummary{
 if(!obj(value)||!obj(value.perDevice)||!Array.isArray(value.visits)||!Array.isArray(value.blocks)||!Array.isArray(value.anomalies))throw invalid();
 const from=finite(value.from),to=finite(value.to),personTime=finite(value.personTime);if(from===undefined||to===undefined||personTime===undefined)throw invalid();
 const perDevice:Record<string,number>={};for(const [id,ms] of Object.entries(value.perDevice)){const n=finite(ms);if(n===undefined||id.length>64)throw invalid();perDevice[id]=n;}
 return {from,to,personTime,perDevice,visits:value.visits.length,blocks:value.blocks.length,gaps:value.blocks.filter(b=>obj(b)&&b.state==='gap').length,anomalies:value.anomalies.length,attribution:text(value.attribution,400)??'',rows:parseSummaryVisits(value.visits)};
}
export function classify(error:unknown,signal:AbortSignal):Failure{
 const name=error instanceof Error?error.name:'',message=error instanceof Error?error.message:'';
 if(signal.aborted||name==='AbortError')return {kind:'aborted',text:''};
 if(message==='ACCOUNT_CHANGED')return {kind:'changed',text:'The signed-in account changed; this view stopped.'};
 if(message==='SIGNIN_REQUIRED'||message==='ACCOUNT_HTTP_401')return {kind:'signin',text:'Your session ended. Sign in again to see this account’s devices and history.'};
 if(message==='ACCOUNT_HTTP_403')return {kind:'denied',text:'The account service refused this request (403).'};
 if(message==='ACCOUNT_HTTP_404')return {kind:'unsupported',text:'This account service does not provide device history (404).'};
 if(message==='ACCOUNT_HTTP_413')return {kind:'bound',text:'Too much activity in this range for one summary. Choose a shorter range.'};
 if(message==='TRACKING_INVALID_RESPONSE'||message==='RESPONSE_BOUND'||error instanceof SyntaxError)return {kind:'invalid',text:'The account service returned a response this page cannot read.'};
 return {kind:'offline',text:/^ACCOUNT_HTTP_5\d\d$/.test(message)?`The account service is unavailable (${message.slice(13)}).`:'The account service could not be reached.'};
}
export function duration(ms:number){
 const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);
 return h?`${h}h ${m}m`:m?`${m}m ${s%60}s`:`${s}s`;
}
const when=(ms:number)=>new Date(ms).toLocaleString();

export function mountTracking(context:PortalContext):()=>void{return createTracking(context);}

export function createTracking(context:PortalContext,options:TrackingOptions={}):()=>void{
 const {root,client}=context,doc=root.ownerDocument,win=doc.defaultView;
 const now=options.now??Date.now,setTimer=options.setTimer??((run,ms)=>setTimeout(run,ms)),clearTimer=options.clearTimer??(id=>clearTimeout(id as ReturnType<typeof setTimeout>));
 const pollMs=options.pollMs??30000,pagesPerSync=options.pagesPerSync??4;
 const local=new AbortController(),signal=local.signal,account=client.account;
 const h=<K extends keyof HTMLElementTagNameMap>(tag:K,cls?:string,content?:string)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e;};
 const view=h('section','tracking-view');view.setAttribute('aria-label','Tracking');
 root.replaceChildren(view);
 if(!account){view.append(h('p','portal-error tracking-signin','Sign in to see this account’s devices and history.'));return()=>{root.replaceChildren();};}

 // Header and live sync state.
 const header=h('header','tracking-header');
 header.append(h('p','tracking-eyebrow portal-muted','Tracking'),h('h2','tracking-title','Devices and shared history'));
 const who=h('p','tracking-account portal-muted');who.textContent=`Signed in as ${account.name} · ${client.origin}`;
 const status=h('p','portal-status tracking-sync');status.setAttribute('role','status');status.textContent='Loading devices and history…';
 const refresh=h('button','tracking-refresh','Refresh');refresh.type='button';
 const headActions=h('div','portal-actions tracking-header-actions');headActions.append(refresh);
 header.append(who,status,headActions);

 const layout=h('div','portal-grid tracking-layout');
 const main=h('div','tracking-main'),side=h('aside','tracking-side');
 // Session summary.
 const summaryCard=h('section','portal-card tracking-summary');
 const summaryTop=h('div','tracking-section-top');summaryTop.append(h('h3','tracking-section-title','Time across your devices'));
 const rangeBar=h('div','portal-actions tracking-ranges');let range:(typeof RANGES)[number]=RANGES[0];
 const rangeButtons=RANGES.map(r=>{const b=h('button','tracking-range',r.label);b.type='button';b.setAttribute('data-range',r.id);b.setAttribute('aria-pressed',String(r===range));rangeBar.append(b);return b;});
 summaryTop.append(rangeBar);
 const summaryBody=h('div','tracking-summary-body');summaryBody.append(h('p','portal-muted','Loading…'));
 summaryCard.append(summaryTop,summaryBody);
 // History.
 const historyCard=h('section','portal-card tracking-history');
 const historyTop=h('div','tracking-section-top');historyTop.append(h('h3','tracking-section-title','Shared history'));
 const filter=h('select','tracking-device-filter');filter.setAttribute('aria-label','Filter by device');
 historyTop.append(filter);
 const historyMeta=h('p','portal-muted tracking-history-meta');
 const historyList=h('ol','tracking-history-list');
 const more=h('button','tracking-more','Load more history');more.type='button';more.hidden=true;
 historyCard.append(historyTop,historyMeta,historyList,more);
 main.append(summaryCard,historyCard);
 // Devices and onboarding.
 const devicesCard=h('section','portal-card tracking-devices');
 devicesCard.append(h('h3','tracking-section-title','Devices on this account'));
 const devicesBody=h('div','tracking-devices-body');devicesBody.append(h('p','portal-muted','Loading…'));
 devicesCard.append(devicesBody);
 const setupCard=h('section','portal-card tracking-setup');
 setupCard.append(h('h3','tracking-section-title','Set up tracking on your Mac'),h('p','portal-muted tracking-setup-intro','Recording runs only in the Spindle app on your Mac. This page shows your account’s devices and history; it cannot see or control the app, your macOS permissions or your recording choices.'));
 const steps=h('ol','tracking-steps');setupCard.append(steps);
 const classCard=h('section','portal-card tracking-classification');
 side.append(devicesCard,classCard,setupCard);
 layout.append(main,side);view.append(header,layout);

 let devices:TrackingDevice[]|undefined,summary:TrackingSummary|undefined,summaryError='';
 const entries=new Map<string,TrackingEntry>();let cursor=0,hasMore=true,skipped=0,loadedOnce=false;
 let timer:unknown,attempts=0,running:Promise<void>|undefined,again=false,disposed=false,signinReported=false;
 const live=()=>!disposed&&!signal.aborted&&client.account?.id===account.id;
 const flow=new ClassificationFlow({
  request:(path,data,s)=>client.request(path,data,s),signal,live,rows:()=>summary?.rows??[],
  reread:()=>sync(0),changed:()=>{if(live()){renderClassification();renderHistory();}},
  signin:error=>{if(!signinReported){signinReported=true;setStatus('Your session ended. Sign in again to see this account’s devices and history.',true);context.onError(error);}},
 });
 const picked=new Map<string,string>(),selected=new Set<string>();let selectedFrom=-1;
 const deviceName=(id:string)=>devices?.find(d=>d.id===id)?.name||'Unknown device';
 const code=(value:string)=>h('code','tracking-command',value);
 const para=(...parts:(string|HTMLElement)[])=>{const p=h('p','tracking-step-text');p.append(...parts);return p;};

 function renderSteps(){
  const n=devices?.length;
  const list:{title:string;state:StepState;badge:string;body:HTMLElement[]}[]=[
   {title:'Create or sign in to your account',state:'done',badge:'Done',body:[para(`Signed in as ${account!.name}. Use this same account and service on every device.`)]},
   {title:'Get the matching Mac and Chrome previews',state:'action',badge:'Reviewed download catalogue',body:[
    para('Open the same-site ',Object.assign(h('a','tracking-download-link','Downloads and SHA-256 catalogue'),{href:'/downloads'}),' for available exact source builds and checksums. If no package is listed yet, do not substitute an old or unrelated download.'),
    para('Extract the Mac ZIP into a private folder, then use Finder to copy Spindle.app into Applications. The Chrome companion must match that app build.'),
    para('Needs Apple Silicon with macOS 15 or later. Native components and Node are precompiled; no Terminal, Command Line Tools, SDK, repository or Python is needed. Developer previews are ad-hoc signed, not notarized; installed and Gatekeeper acceptance remain separate. Never bypass macOS security controls.')]},
   {title:'Open the preview',state:'action',badge:'On your Mac',body:[
    para('Open ',code('Spindle.app'),' normally in Finder. It starts paused. Workspace opens this service in your system browser; use the app’s Capture controls for local recording and fixtures.'),
    para('Never bypass Gatekeeper or other security controls. If a step is blocked, share the build ID and the blocked step, not raw logs.')]},
   {title:'Grant macOS permissions, one at a time',state:'unknown',badge:'Not visible here',body:[
    para('Accessibility: lets Spindle read the focused window’s app and title. Screen Recording: needed only if you later allow window pixels, text recognition or screenshots.'),
    para('Grant each yourself in System Settings › Privacy & Security. The local inspector shows each permission separately; this page cannot read or change them.')]},
   {title:'Make your recording choices separately',state:'unknown',badge:'Your choice, in the app',body:[
    para('Recording (Start/Pause), encrypted retention, window pixels or screenshots, and account sync are separate choices in the local app. Signing in or connecting never turns any of them on.')]},
   {title:'Connect this Mac to your account',state:n===undefined?'unknown':n>0?'done':'action',badge:n===undefined?'Checking…':n>0?`${n} device${n===1?'':'s'} connected`:'No device yet',body:[
    para('For browser sign-in, open the app’s “Sign in / Sync across devices” section, use backend ',code(client.origin),' and a device name such as “My Mac”, choose sync explicitly, then open the sign-in link in your system browser. Use the same Spindle identity on each device.'),
    para('If you already use direct connection, the “Same-account devices and history” section still accepts your existing direct account name and password for this backend. Browser sign-in accounts do not have a direct password; do not enter their generated display name as a password login. Your direct password is not saved.'),
    para('Connecting does not upload anything until you have allowed recording, retention and sync and pressed Start.')]},
   {title:'Add the Chrome companion (optional, per profile)',state:'unknown',badge:'Not visible here',body:[
    para('In the app’s Capture controls, open Chrome setup and choose “Open matching extension folder”, or extract the matching Chrome ZIP from the download catalogue. In Chrome Extensions turn on Developer mode and Load unpacked the ',code('Chrome Extension'),' folder. Copy its extension ID into the app’s Chrome setup and choose “Register this Chrome extension”. No Terminal is required.'),
    para('Pair the profile with the inspector’s pairing code and allow each site you choose. Incognito and private windows are not supported and are never read. Enrolling does not start recording or add a login item.')]},
   {title:'Start and Pause',state:'unknown',badge:'Only in the local app',body:[
    para('Recording begins only when you press Start in the local preview and stops when you press Pause. This page has no connection to the app, so it cannot show or change whether you are recording.')]},
   {title:'Connect a second device (optional)',state:'pending',badge:n!==undefined&&n>1?'Registered':'Pending',body:[
    para('Sign in with this same account from that device’s own Spindle app. Its history appears here after its first accepted sync. A registration alone does not prove it is a native device.')]},
  ];
  steps.replaceChildren(...list.map(s=>{
   const li=h('li',`tracking-step tracking-step-${s.state}`);li.setAttribute('data-state',s.state);
   const top=h('div','tracking-step-top');top.append(h('span','tracking-step-title',s.title),h('span',`portal-badge tracking-step-badge`,s.badge));
   li.append(top,...s.body);return li;
  }));
 }
 function renderDevices(){
  if(!devices){return;}
  if(!devices.length){devicesBody.replaceChildren(h('p','portal-muted tracking-devices-empty','No devices are connected to this account yet. Follow the Mac setup steps to connect one.'));return;}
  const list=h('ul','tracking-device-list');
  for(const d of devices){
   const li=h('li','tracking-device');li.setAttribute('data-device',d.id);
   const name=h('strong','tracking-device-name');name.textContent=d.name||'Unnamed device';
   const upload=h('span','tracking-device-upload');upload.textContent=d.lastUploadAt===null?'No accepted upload yet':`Last accepted upload ${when(d.lastUploadAt)}`;
   const pending=h('span','portal-muted tracking-device-pending','Waiting uploads and upload errors: not reported to the account; check the app on that device.');
   li.append(name,upload,pending);
   if(summary)li.append(h('span','tracking-device-time',`${duration(summary.perDevice[d.id]??0)} observed in ${range.label.toLowerCase()}`));
   list.append(li);
  }
  devicesBody.replaceChildren(list,h('p','portal-muted tracking-devices-note',devices.length>1?`${devices.length} devices are registered. The account service cannot verify which are native hardware.`:'One device is registered. A second device stays pending until it connects and syncs.'));
 }
 function renderFilter(){
  const selected=filter.value;
  const all=h('option',undefined,'All devices');all.value='';
  filter.replaceChildren(all,...(devices??[]).map(d=>{const o=h('option');o.value=d.id;o.textContent=d.name||'Unnamed device';return o;}));
  filter.value=devices?.some(d=>d.id===selected)?selected:'';
 }
 function renderSummary(){
  if(summaryError){summaryBody.replaceChildren(h('p','portal-error tracking-summary-error',summaryError));return;}
  if(!summary)return;
  if(!summary.visits){summaryBody.replaceChildren(h('p','portal-muted tracking-summary-empty',`No activity has been synced for ${range.label.toLowerCase()}.`));return;}
  const total=h('p','tracking-person-time');total.append(h('strong',undefined,duration(summary.personTime)),' observed, counted once even when devices overlap');
  const facts=h('p','portal-muted tracking-summary-facts',`${summary.visits} visit${summary.visits===1?'':'s'} · ${summary.gaps} unobserved gap${summary.gaps===1?'':'s'}${summary.anomalies?` · ${summary.anomalies} with unreliable clock`:''}`);
  summaryBody.replaceChildren(total,facts,...(summary.attribution?[h('p','portal-muted tracking-attribution',summary.attribution)]:[]));
 }
 const categoryName=(id:string)=>CLASSIFY_CATEGORIES.find(c=>c[0]===id)?.[1]??'Other';
 function labelText(row:SummaryVisit){
  const l=row.label;
  if(!l)return row.textState==='expired'?'Details expired; no label is shown.':'Labels are off for this account.';
  if(l.source==='override')return `Your label: ${categoryName(l.categoryId)}`;
  if(l.source==='rule')return `Your rule: ${categoryName(l.categoryId)}`;
  if(l.source==='inference')return `AI suggestion: ${categoryName(l.categoryId)} · ${l.provider??'model'} · ${l.model??'unknown'} · not yet your label`;
  return 'No label yet.';
 }
 function rowControls(row:SummaryVisit){
  const l=row.label,wrap=h('div','tracking-entry-label');wrap.setAttribute('data-label-source',l?.source??'none');
  wrap.append(h('p','portal-muted tracking-entry-label-text',labelText(row)));
  if(!l)return wrap;
  const actions=h('div','sp-actions tracking-entry-actions');
  if(flow.config?.configured&&l.source!=='override'&&l.source!=='rule'){
   const retry=flow.uncertain(row),why=retry?undefined:flow.reason(row);
   const run=button(retry?'Check result':'Classify with AI',{disabled:flow.busy||!!why});run.dataset.action='classify';
   run.addEventListener('click',()=>{void flow.classify(row);});
   actions.append(run);if(why)actions.append(h('span','sp-hint tracking-classify-why',why));
  }
  const pick=h('select','sp-field tracking-label-pick');pick.setAttribute('aria-label','Label category');
  for(const [id,name] of CLASSIFY_CATEGORIES){const o=h('option',undefined,name);o.value=id;pick.append(o);}
  pick.value=picked.get(row.key)??l.categoryId;pick.addEventListener('change',()=>picked.set(row.key,pick.value));
  const save=button(l.source==='inference'?'Confirm as my label':'Save as my label',{variant:'quiet',disabled:flow.busy});save.dataset.action='confirm';
  save.addEventListener('click',()=>{const chosen=pick.value;picked.delete(row.key);void flow.confirm(row,chosen);});
  actions.append(pick,save);wrap.append(actions);
  const note=flow.noteFor(row);if(note){const p=h('p',note.error?'portal-error tracking-entry-note':'portal-muted tracking-entry-note',note.text);p.setAttribute('role','status');wrap.append(p);}
  return wrap;
 }
 const fieldNames:Record<string,string>={appId:'App name',domain:'Website domain',title:'Window or page title',text:'Page or window text'};
 function renderClassification(){
  const c=flow.config,parts:HTMLElement[]=[h('h3','tracking-section-title','AI labels (optional)')];
  if(!c)parts.push(h('p','portal-muted tracking-classify-loading',flow.configNote||'Checking AI settings…'));
  else if(!c.configured)parts.push(h('p','portal-muted tracking-classify-unconfigured','This account service has no AI model configured, so nothing can be sent for AI labelling. Labels you set yourself still work.'));
  else{
   const rev=c.consent?.revision??0;
   if(selectedFrom!==rev){selected.clear();for(const f of c.consent?.fields??[])if(f!=='image')selected.add(f);selectedFrom=rev;}
   parts.push(h('p','tracking-classify-model',`Model: ${c.model.provider} · ${c.model.id} (${c.model.vision?'text and images':'text only'})`));
   if(c.quota){
    const q=c.quota,usage=`${q.usedMinute}/${q.perMinute} this minute · ${q.usedDay}/${q.perDay} this day window`;
    parts.push(h('p',q.clockTrusted?'portal-muted tracking-classify-quota':'portal-error tracking-classify-quota',q.clockTrusted?`Service classification quota: ${usage}. The service, not this page, decides when capacity is available.`:`Service classification quota: ${usage}. The service clock is untrusted, so this page cannot say when capacity is available. Refresh to read the service again.`));
   }
   if(c.paused)parts.push(h('p','portal-error tracking-classify-paused','Remote classification is paused by the service operator.'));
   const proc=button(c.processing?'Turn off label processing':'Turn on label processing',{variant:'quiet',disabled:flow.busy});proc.dataset.action='processing';
   proc.addEventListener('click',()=>{void flow.setProcessing(!c.processing);});
   parts.push(h('p','portal-muted tracking-classify-processing',c.processing?'Local label processing is on. Turning it off also revokes AI consent and removes AI suggestions.':'Local label processing is off. It is needed for any label, yours or AI’s.'),proc);
   const set=h('fieldset','tracking-consent');set.append(h('legend','sp-label','Send to the model, only for items you choose'));
   const allow=button(c.consent?'Update AI consent':'Allow AI for the selected fields',{disabled:flow.busy||!c.processing||c.paused||!selected.size});allow.dataset.action='grant';
   for(const f of REMOTE_TEXT_FIELDS){
    const box=h('label','tracking-consent-field'),input=h('input');input.type='checkbox';input.checked=selected.has(f);input.setAttribute('data-field',f);
    input.addEventListener('change',()=>{if(input.checked)selected.add(f);else selected.delete(f);allow.disabled=flow.busy||!c.processing||c.paused||!selected.size;});
    box.append(input,' ',fieldNames[f]!);set.append(box);
   }
   allow.addEventListener('click',()=>{void flow.grant(REMOTE_TEXT_FIELDS.filter(f=>selected.has(f)));});
   const actions=h('div','sp-actions');actions.append(allow);
   if(c.consent){const revoke=button('Revoke AI consent',{variant:'quiet',disabled:flow.busy});revoke.dataset.action='revoke';revoke.addEventListener('click',()=>{void flow.revoke();});actions.append(revoke);}
   parts.push(set,actions,h('p','portal-muted tracking-classify-pixels',`Window pixels are a separate native-app consent and are never sent from this page.${c.consent?.fields.includes('image')?' Consent granted elsewhere also covers pixels; saving here replaces it with the fields ticked above.':''}`));
   const auto=h('label','tracking-auto'),box=h('input');box.type='checkbox';box.checked=flow.auto;box.disabled=!flow.ready;box.setAttribute('data-auto','toggle');
   box.addEventListener('change',()=>{flow.setAuto(box.checked);if(flow.auto)void sync(0);});
   auto.append(box,' Classify new uploaded text automatically while this page is open');
   parts.push(auto,h('p','portal-muted tracking-auto-hint',`Off whenever this page opens. Needs AI consent for title or text. Only items that arrive after you turn it on, one at a time, up to ${AUTO_BATCH} per refresh and ${AUTO_LIMIT} per visit. Your own labels are never replaced.`));
  }
  if(flow.cardNote){const note=statusRegion('idle','');note.classList.add('tracking-classify-note');setRegion(note,flow.cardNote.error?'error':'success',flow.cardNote.text);parts.push(note);}
  classCard.replaceChildren(...parts);
 }
 function renderHistory(){
  const rows=new Map((summary?.rows??[]).map(r=>[r.key,r]));
  const shown=[...entries.values()].filter(e=>!filter.value||e.deviceId===filter.value).sort((a,b)=>(b.start??-1)-(a.start??-1)||b.seq-a.seq);
  more.hidden=!hasMore;
  historyMeta.textContent=!loadedOnce?'Loading…':`${entries.size} item${entries.size===1?'':'s'} loaded${hasMore?'; older-to-newer loading continues with “Load more”':', up to date'}${skipped?` · ${skipped} unreadable item${skipped===1?'':'s'} skipped`:''}${shown.length>MAX_ROWS?` · showing newest ${MAX_ROWS}`:''}`;
  if(!shown.length){historyList.replaceChildren(h('li','portal-muted tracking-history-empty',loadedOnce?(entries.size?'No history from this device yet.':'No history yet. Activity appears here after a connected device records and syncs it.'):'Loading…'));return;}
  historyList.replaceChildren(...shown.slice(0,MAX_ROWS).map(e=>{
   const li=h('li',`tracking-entry${e.deleted?' tracking-entry-deleted':''}`);li.setAttribute('data-key',e.key);
   const top=h('div','tracking-entry-top');
   top.append(h('span','tracking-entry-app',e.deleted?'Deleted':e.app||'Unknown app'),h('span','portal-badge tracking-entry-device',deviceName(e.deviceId)));
   if(e.browser)top.append(h('span','portal-badge tracking-entry-browser','Browser'));
   li.append(top);
   if(e.deleted)li.append(h('p','portal-muted tracking-entry-detail','Removed or expired; no content is kept.'));
   else{
    li.append(h('p',`tracking-entry-detail${e.title?'':' portal-muted'}`,e.title||(e.contextExpired?'Details expired':'No title')));
    li.append(h('p','portal-muted tracking-entry-time',`${when(e.start!)} · ${e.end===null?'open':duration(e.end-e.start!)}`));
    const row=rows.get(e.key);if(row)li.append(rowControls(row));
   }
   return li;
  }));
 }
 function setStatus(message:string,error=false){status.textContent=message;status.className=`${error?'portal-error':'portal-status'} tracking-sync`;}
 function fail(error:unknown):Failure|undefined{
  if(disposed||signal.aborted)return undefined;
  const failure=classify(error,signal);
  if(failure.kind==='aborted'||!live()&&failure.kind!=='signin')return undefined;
  if(failure.kind==='changed'){dispose();return undefined;}
  if(failure.kind==='signin'){setStatus(failure.text,true);refresh.disabled=true;more.disabled=true;if(!signinReported){signinReported=true;context.onError(error);}return undefined;}
  return failure;
 }
 async function readHistory(pages:number){
  for(let i=0;i<pages&&(hasMore||i===0);i++){
   const page=parseHistory(await client.request(`/history?cursor=${cursor}&limit=16`,undefined,signal),cursor);
   if(!live())return;
   for(const e of page.entries){entries.delete(e.key);entries.set(e.key,e);}
   while(entries.size>MAX_ENTRIES)entries.delete(entries.keys().next().value!);
   cursor=page.cursor;hasMore=page.hasMore;skipped+=page.skipped;
   if(!page.hasMore)break;
  }
 }
 async function readSummary(){
  const to=now(),from=to-range.ms;
  try{summary=parseSummary(await client.request(`/sessions?from=${Math.floor(from)}&to=${Math.floor(to)}`,undefined,signal));summaryError='';}
  catch(error){const failure=classify(error,signal);if(failure.kind==='bound'||failure.kind==='invalid'){summary=undefined;summaryError=failure.text;}else throw error;}
 }
 function schedule(ms:number){clearTimer(timer);timer=undefined;if(live())timer=setTimer(()=>{timer=undefined;void sync();},ms);}
 function sync(pages=pagesPerSync):Promise<void>{
  if(running){again=true;return running;}
  clearTimer(timer);timer=undefined;
  running=(async()=>{
   try{
    // History waits for device names so rows never paint with stale labels.
    devices=parseDevices(await client.request('/devices',undefined,signal));if(!live())return;
    await Promise.all([readSummary(),readHistory(pages)]);if(!live())return;
    loadedOnce=true;attempts=0;
    renderFilter();renderDevices();renderSummary();renderClassification();renderHistory();renderSteps();
    setStatus(`Up to date as of ${new Date(now()).toLocaleTimeString()}${hasMore?' (more history available)':''}`);
    if(doc.visibilityState!=='hidden')schedule(pollMs);
   }catch(error){
    const failure=fail(error);if(!failure)return;
    if(!loadedOnce){devicesBody.replaceChildren(h('p','portal-error tracking-devices-error',failure.text));historyMeta.textContent='';historyList.replaceChildren(h('li','portal-error tracking-history-error',failure.text));}
    if(failure.kind==='offline'){
     const wait=Math.min(60000,2000*2**attempts++);
     setStatus(`${failure.text} Showing what was last loaded. Retrying in ${Math.round(wait/1000)}s.`,true);schedule(wait);
    }else setStatus(failure.text,true);
   }
  })().finally(()=>{running=undefined;if(again&&live()){again=false;void sync();}else if(loadedOnce&&live())void flow.afterSync();});
  return running;
 }
 const onRefresh=()=>{void sync();};
 const onMore=()=>{if(!running)void sync(1);};
 const onFilter=()=>renderHistory();
 const onOnline=()=>{attempts=0;void sync();};
 const onVisible=()=>{if(doc.visibilityState==='visible')void sync();else{clearTimer(timer);timer=undefined;}};
 const onRange=(event:Event)=>{
  const next=RANGES.find(r=>r.id===(event.currentTarget as HTMLElement).getAttribute('data-range'));
  if(!next||next===range)return;range=next;
  for(const b of rangeButtons)b.setAttribute('aria-pressed',String(b.getAttribute('data-range')===range.id));
  summary=undefined;summaryError='';summaryBody.replaceChildren(h('p','portal-muted','Loading…'));void sync(0);
 };
 refresh.addEventListener('click',onRefresh);more.addEventListener('click',onMore);filter.addEventListener('change',onFilter);
 for(const b of rangeButtons)b.addEventListener('click',onRange);
 win?.addEventListener('online',onOnline);doc.addEventListener('visibilitychange',onVisible);
 function dispose(){
  if(disposed)return;disposed=true;flow.dispose();local.abort();clearTimer(timer);timer=undefined;
  refresh.removeEventListener('click',onRefresh);more.removeEventListener('click',onMore);filter.removeEventListener('change',onFilter);
  for(const b of rangeButtons)b.removeEventListener('click',onRange);
  win?.removeEventListener('online',onOnline);doc.removeEventListener('visibilitychange',onVisible);
  context.signal.removeEventListener('abort',dispose);
  entries.clear();root.replaceChildren();
 }
 if(context.signal.aborted){dispose();return dispose;}
 context.signal.addEventListener('abort',dispose,{once:true});
 renderSteps();renderClassification();renderHistory();void sync();
 return dispose;
}

/*
 * Classification controls. Presentation over the account service's existing
 * /processing, /classification/* and /corrections routes; the server owns the model,
 * credential, budget and every admission fence. This page never holds a provider key,
 * never sends window pixels, and never labels a model suggestion as the user's own.
 * It lives in this file because the portal asset allowlist serves tracking.js only.
 */
export const CLASSIFY_CATEGORIES=[['work','Work'],['learning','Learning'],['communication','Communication'],['admin','Admin'],['personal','Personal'],['leisure','Leisure'],['uncategorized','Uncategorized']] as const;
export const AUTO_BATCH=5,AUTO_LIMIT=25,MIN_EVIDENCE=24;
export const REMOTE_TEXT_FIELDS=['appId','domain','title','text'] as const;
export interface RowLabel {source:'override'|'rule'|'inference'|'abstention';categoryId:string;activityId:string|null;relatedIds:string[];provider:string|null;model:string|null}
export interface SummaryVisit {key:string;evidenceRevision:number;correctionRevision:number;open:boolean;label:RowLabel|null;textState:'available'|'missing'|'expired';titleChars:number;textChars:number}
export interface ClassificationQuotaView {perMinute:number;perDay:number;usedMinute:number;usedDay:number;clockTrusted:boolean}
export interface ClassificationConfigView {configured:true;model:{provider:string;id:string;vision:boolean};paused:boolean;processing:boolean;consent:{revision:number;fields:string[]}|null;quota?:ClassificationQuotaView}
export interface ClassifyOutcome {state:'done'|'inflight'|'unknown';status:string;provider:string|null;model:string|null}
const knownFields=['appId','domain','title','text','image'];

function parseRowLabel(value:unknown):RowLabel|undefined{
 if(!obj(value)||!obj(value.labels))return undefined;
 const source=value.source,l=value.labels,category=text(l.categoryId,40),related=l.relatedIds;
 if(source!=='override'&&source!=='rule'&&source!=='inference'&&source!=='abstention')return undefined;
 if(!category||!(l.activityId===null||text(l.activityId,40)!==undefined)||!Array.isArray(related)||related.length>16||related.some(r=>text(r,64)===undefined))return undefined;
 const remote=obj(value.remoteInference)?value.remoteInference:undefined;
 return {source,categoryId:category,activityId:l.activityId as string|null,relatedIds:related as string[],provider:remote?text(remote.provider,64)??null:null,model:remote?text(remote.model,128)??null:null};
}
/** Rows keep only what the controls need (never the text itself); unreadable rows get no actions. */
export function parseSummaryVisits(visits:unknown[]):SummaryVisit[]{
 const rows:SummaryVisit[]=[];
 for(const v of visits){
  const c=obj(v)&&obj(v.context)?v.context:undefined,clock=obj(v)&&obj(v.clock)?v.clock:undefined;
  const key=obj(v)?text(v.key,512):undefined,revision=obj(v)?count(v.evidenceRevision):undefined,correction=obj(v)?count(v.correctionRevision):undefined;
  if(!obj(v)||!key||revision===undefined||correction===undefined||!c||!clock)continue;
  const state=c.textState;if(state!=='available'&&state!=='missing'&&state!=='expired')continue;
  const label=v.label===null?null:parseRowLabel(v.label);if(label===undefined)continue;
  rows.push({key,evidenceRevision:revision,correctionRevision:correction,open:clock.end===null,label,textState:state,titleChars:typeof c.title==='string'?c.title.length:0,textChars:typeof c.text==='string'?c.text.length:0});
 }
 return rows;
}
export function parseClassificationConfig(value:unknown):ClassificationConfigView|{configured:false}{
 if(!obj(value)||typeof value.configured!=='boolean')throw invalid();
 if(!value.configured)return {configured:false};
 const m=obj(value.model)?value.model:undefined,provider=m&&text(m.provider,64),id=m&&text(m.id,128);
 const c=value.consent,fields=obj(c)&&Array.isArray(c.fields)?c.fields:undefined;
 if(!m||!provider||!id||typeof m.vision!=='boolean'||typeof value.paused!=='boolean'||typeof value.processing!=='boolean')throw invalid();
 if(c!==null&&(!obj(c)||count(c.revision)===undefined||!fields||fields.length>5||fields.some(f=>!knownFields.includes(f as string))))throw invalid();
 const q=value.quota,perMinute=obj(q)?count(q.perMinute):undefined,perDay=obj(q)?count(q.perDay):undefined,usedMinute=obj(q)?count(q.usedMinute):undefined,usedDay=obj(q)?count(q.usedDay):undefined;
 if(q!==undefined&&(!obj(q)||perMinute===undefined||perDay===undefined||usedMinute===undefined||usedDay===undefined||perMinute<1||perDay<perMinute||usedMinute>perMinute||usedDay>perDay||typeof q.clockTrusted!=='boolean'))throw invalid();
 return {configured:true,model:{provider,id,vision:m.vision},paused:value.paused,processing:value.processing,consent:obj(c)?{revision:c.revision as number,fields:fields as string[]}:null,...q?{quota:{perMinute:perMinute!,perDay:perDay!,usedMinute:usedMinute!,usedDay:usedDay!,clockTrusted:q.clockTrusted as boolean}}:{}};
}
export function parseClassifyOutcome(value:unknown,expected:{requestId:string;key:string;evidenceRevision:number}):ClassifyOutcome{
 if(!obj(value)||value.requestId!==expected.requestId||value.key!==expected.key||value.evidenceRevision!==expected.evidenceRevision)throw invalid();
 const state=value.state;if(state!=='done'&&state!=='inflight'&&state!=='unknown')throw invalid();
 const status=state==='done'?text(value.status,40):'';if(status===undefined||state==='done'&&!/^[A-Za-z_-]{1,40}$/.test(status))throw invalid();
 return {state,status,provider:text(value.provider,64)??null,model:text(value.model,128)??null};
}
const settled=['suggested','abstained','user-choice-preserved','insufficient-evidence'];
const statusText:Record<string,string>={
 suggested:'AI suggestion saved. It is not your label until you confirm it.',
 abstained:'The model chose not to suggest a label. Nothing was changed.',
 'user-choice-preserved':'Your own label or rule is kept; the AI result was not applied.',
 'insufficient-evidence':'Not enough readable text to classify. Nothing was sent to the model.',
 STALE_REQUEST:'The item changed before it ran, so nothing was sent.',STALE_RESULT:'The item changed while it ran, so the result was discarded.',
 REMOTE_DISABLED:'AI consent does not cover this. Nothing was sent.',FIELDS_DENIED:'AI consent does not cover this. Nothing was sent.',
 INVALID_MODEL:'The service’s model did not match its declaration. Nothing was sent.',INVALID_SUGGESTION:'The model replied in a form that could not be used. No label was saved.',
};
/** Provider text is only ever shown as inert text and only when it is a short code. */
export function outcomeText(o:ClassifyOutcome):string{
 if(o.state==='inflight')return 'Still running on the service. Check the result again shortly; it was not started twice.';
 if(o.state==='unknown')return 'The service cannot tell whether this ran, so it was not retried. A new upload of this item can be classified.';
 return statusText[o.status]??`The model call did not produce a label (${o.status}). No label was saved.`;
}
export interface FlowHost {
 request(path:string,data:unknown,signal:AbortSignal):Promise<unknown>;
 signal:AbortSignal;live():boolean;rows():SummaryVisit[];
 /** Re-read the account's /sessions summary so labels shown come from the service. */
 reread():Promise<void>;changed():void;signin(error:unknown):void;
}
interface Note {revision:number;text:string;error:boolean}
export const newId=()=>Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const httpStatus=(error:unknown)=>Number(/^ACCOUNT_HTTP_(\d{3})/.exec(error instanceof Error?error.message:'')?.[1]);

/**
 * Per-view state machine. Nothing is persisted: automatic mode and AI consent choices
 * are re-derived from the service (consent) or default off (automatic) in every new view.
 */
export class ClassificationFlow {
 config:ClassificationConfigView|{configured:false}|undefined;
 configNote='';cardNote:{text:string;error:boolean}|undefined;
 auto=false;autoCount=0;busy=false;
 readonly notes=new Map<string,Note>();
 readonly #ids=new Map<string,string>();readonly #uncertain=new Set<string>();readonly #tried=new Set<string>();
 #baseline=new Map<string,number>();#inflight:AbortController|undefined;#autoRunning=false;#disposed=false;
 constructor(private readonly host:FlowHost){}
 get model(){return this.config?.configured?this.config.model:undefined;}
 /** Remote text classification is possible only with processing on, no operator pause and consent for a text field. */
 get ready(){const c=this.config;return !!c?.configured&&c.processing&&!c.paused&&!!c.consent?.fields.some(f=>f!=='image');}
 get consentedFields(){return this.config?.configured?this.config.consent?.fields??[]:[];}
 uncertain(row:SummaryVisit){return this.#uncertain.has(this.#tag(row));}
 #tag(row:SummaryVisit){return `${row.key}\0${row.evidenceRevision}`;}
 #live(){return !this.#disposed&&!this.host.signal.aborted&&this.host.live();}
 #automaticQuotaStop(refused=false){
  const q=this.config?.configured?this.config.quota:undefined;
  if(!q)return false;
  const exhausted=q.usedMinute>=q.perMinute||q.usedDay>=q.perDay;
  if(!refused&&!exhausted&&q.clockTrusted)return false;
  this.auto=false;
  this.cardNote={text:exhausted||refused?'Automatic classification is off because the service refused a request at its classification quota. Refresh to read current service usage before turning it on again.':'Automatic classification is off because the service clock is untrusted. Refresh to read current service usage before turning it on again.',error:true};
  this.host.changed();return true;
 }
 #say(row:SummaryVisit,message:string,error=false){this.notes.set(row.key,{revision:row.evidenceRevision,text:message,error});this.host.changed();}
 noteFor(row:SummaryVisit){const n=this.notes.get(row.key);return n&&n.revision===row.evidenceRevision?n:undefined;}
 /** Why this row cannot be sent, as plain text; undefined when it can. The service stays the final authority. */
 reason(row:SummaryVisit):string|undefined{
  const c=this.config;
  if(!c)return 'Checking AI settings…';
  if(!c.configured)return 'This account service has no AI model configured.';
  if(row.label?.source==='override'||row.label?.source==='rule')return 'Your own label is kept; AI will not replace it.';
  if(row.textState==='expired')return 'Details expired; there is nothing left to classify.';
  if(row.textState==='missing'&&!row.titleChars)return 'No text was uploaded for this item.';
  if(!c.processing)return 'Turn on label processing first.';
  if(c.paused)return 'Remote classification is paused by the service operator.';
  if(!this.ready)return 'Allow remote classification of title or text first.';
  if(c.quota&&!c.quota.clockTrusted)return 'The service classification quota clock is untrusted. Refresh to read the service again before classifying.';
  const f=c.consent!.fields,chars=(f.includes('title')?row.titleChars:0)+(f.includes('text')?row.textChars:0);
  if(!f.includes('title')&&!f.includes('text'))return 'Allow remote classification of title or text first.';
  if(row.open)return 'Still open; classify after the visit ends.';
  if(chars<MIN_EVIDENCE)return 'Too little allowed text to classify; nothing would be sent.';
  return undefined;
 }
 async loadConfig(){
  try{
   this.config=parseClassificationConfig(await this.host.request('/classification/config',{},this.host.signal));this.configNote='';
  }catch(error){
   if(!this.#live())return;
   const status=httpStatus(error);
   if(status===401||error instanceof Error&&error.message==='SIGNIN_REQUIRED')this.host.signin(error);
   else if([404,405,501,503].includes(status)){this.config={configured:false};this.configNote='';}
   else this.configNote='AI settings could not be read right now.';
  }
  if(this.#live())this.host.changed();
 }
 async #act(path:string,data:unknown,done:string){
  if(this.busy)return;this.busy=true;
  try{await this.host.request(path,data,this.host.signal);this.cardNote={text:done,error:false};}
  catch(error){if(!this.#live())return;this.cardNote={text:this.#failure(error),error:true};}
  finally{this.busy=false;}
  await this.loadConfig();await this.host.reread();
 }
 #failure(error:unknown){
  const status=httpStatus(error);
  if(status===401||error instanceof Error&&error.message==='SIGNIN_REQUIRED'){this.host.signin(error);return 'Your session ended.';}
  if(status===403)return 'The service refused this. Local label processing may be off, or the page needs a reload.';
  if(status===409)return 'The item changed or the service is busy. It was refreshed; check it and try again.';
  if(status===410)return 'Details expired, so there is nothing to change.';
  if(status===429)return 'The service refused this because its classification quota is used. The outcome is confirmed: nothing was sent to the model. Refresh to read current service usage.';
  if(status===404)return 'That item is no longer available.';
  if(status===503)return 'The service paused or does not offer this. Nothing was changed.';
  return 'The service could not be reached. The outcome is unconfirmed; refresh to see the current state.';
 }
 setProcessing(on:boolean){if(!on)this.setAuto(false);return this.#act('/processing',{local:on},on?'Local label processing is on.':'Local label processing is off. AI consent was revoked and AI suggestions were removed.');}
 grant(fields:string[]){return this.#act('/classification/consent',{enabled:true,fields},'AI consent saved for the selected fields only.');}
 revoke(){this.setAuto(false);this.#inflight?.abort();return this.#act('/classification/consent',{enabled:false},'AI consent revoked. Completed suggestions are kept until label processing is turned off.');}
 /** Automatic mode needs explicit consent and starts empty: only items that arrive after it is turned on count. */
 setAuto(on:boolean){
  if(on===this.auto)return;
  if(on&&!this.ready)return;
  this.auto=on;this.autoCount=0;this.#baseline=on?new Map(this.host.rows().map(r=>[r.key,r.evidenceRevision])):new Map();
  this.cardNote={text:on?'Automatic text classification is on while this page is open.':'Automatic classification is off.',error:false};this.host.changed();
 }
 #candidates(){
  return this.host.rows().filter(r=>{
   const base=this.#baseline.get(r.key);
   return (base===undefined||r.evidenceRevision>base)&&r.label!==null&&r.label.source!=='inference'&&!this.#tried.has(this.#tag(r))&&!this.reason(r);
  });
 }
 /** Called by the existing refresh cycle after each completed read; there is no timer of its own. */
 async afterSync(){
  if(!this.#live())return;
  await this.loadConfig();
  if(!this.auto||this.#autoRunning)return;
  if(!this.ready){this.setAuto(false);return;}
  if(this.#automaticQuotaStop())return;
  this.#autoRunning=true;
  try{
   for(let n=0;n<AUTO_BATCH&&this.auto&&this.#live()&&this.ready&&this.autoCount<AUTO_LIMIT;n++){
    const row=this.#candidates()[0];if(!row)break;
    this.autoCount++;await this.classify(row);
    if(this.#automaticQuotaStop())break;
    if(this.#uncertain.has(this.#tag(row)))break;
   }
   if(this.autoCount>=AUTO_LIMIT&&this.auto){this.cardNote={text:`Automatic classification paused after ${AUTO_LIMIT} items in this view. Turn it off and on to continue.`,error:false};this.host.changed();}
  }finally{this.#autoRunning=false;}
 }
 /** One explicit item, one stable request ID. An unconfirmed outcome is read back, never blindly re-paid. */
 async classify(row:SummaryVisit):Promise<void>{
  if(this.busy||!this.#live()||this.reason(row)&&!this.uncertain(row))return;
  const tag=this.#tag(row),id=this.#ids.get(tag)??newId();this.#ids.set(tag,id);this.#tried.add(tag);
  this.busy=true;const abort=this.#inflight=new AbortController(),signal=AbortSignal.any([this.host.signal,abort.signal]);
  this.#say(row,this.uncertain(row)?'Checking the earlier request…':'Classifying…');
  const expected={requestId:id,key:row.key,evidenceRevision:row.evidenceRevision};
  try{
   let outcome:ClassifyOutcome|undefined;
   if(this.#uncertain.has(tag)){
    try{outcome=parseClassifyOutcome(await this.host.request('/classification/status',{requestId:id},signal),expected);}
    catch(error){if(httpStatus(error)!==404)throw error;this.#uncertain.delete(tag);} // never admitted: the same ID is safe to submit
   }
   outcome??=parseClassifyOutcome(await this.host.request('/classification/classify',{key:row.key,evidenceRevision:row.evidenceRevision,requestId:id,mode:'text'},signal),expected);
   this.#uncertain.delete(tag);
   if(outcome.state==='inflight')this.#uncertain.add(tag);
   else if(outcome.state==='done'&&!settled.includes(outcome.status))this.#ids.delete(tag);
   if(!this.#live())return;
   this.#say(row,outcome.state==='done'&&outcome.status==='suggested'&&outcome.provider?`${outcomeText(outcome)} Model: ${outcome.provider} · ${outcome.model??'unknown'}.`:outcomeText(outcome),outcome.state==='done'&&!settled.includes(outcome.status));
  }catch(error){
   if(!this.#live())return;
   const status=httpStatus(error);
   if(status===401||error instanceof Error&&error.message==='SIGNIN_REQUIRED')this.host.signin(error);
   else if(status>=400&&status<500||status===503){
    if(status===409||status===503)this.#tried.delete(tag);
    if(status!==429)this.#ids.delete(tag);
    this.#uncertain.delete(tag);this.#say(row,this.#failure(error),true);
    if(status===429)this.#automaticQuotaStop(true);
   }
   else{this.#uncertain.add(tag);this.#say(row,'The outcome could not be confirmed. It may have run once on the service and was not retried. Use “Check result” to read it back.',true);}
  }finally{this.busy=false;if(this.#inflight===abort)this.#inflight=undefined;}
  if(this.#live()){await this.loadConfig();await this.host.reread();}
 }
 /** The ordinary corrections route: the label becomes the user's own, which is what qualifies for the study rule. */
 async confirm(row:SummaryVisit,categoryId:string){
  if(this.busy||!this.#live())return;this.busy=true;this.#say(row,'Saving your label…');
  const l=row.label;
  try{
   await this.host.request('/corrections',{key:row.key,evidenceRevision:row.evidenceRevision,expectedRevision:row.correctionRevision,labels:{categoryId,activityId:l?.activityId??null,relatedIds:l?.relatedIds??[]}},this.host.signal);
   this.#say(row,'Saved as your label.');
  }catch(error){if(!this.#live())return;this.#say(row,this.#failure(error),true);}
  finally{this.busy=false;}
  if(this.#live())await this.host.reread();
 }
 dispose(){this.#disposed=true;this.auto=false;this.#inflight?.abort();this.notes.clear();}
}
