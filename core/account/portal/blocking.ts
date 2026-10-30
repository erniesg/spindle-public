import type {PortalContext} from './types.js';
import {button as sharedButton} from '../../ui/dom.js';
import {newId} from './tracking.js';
/*
 * Blocking lane view. The policy authority is the enrolled Spindle Chrome extension
 * (its existing `sitePolicy` journal); this view never keeps a second store, timer
 * or pretend block. Every read/write is `context.client.request('/blocking/*')`,
 * the account adapter contract in docs/PORTAL_BLOCKING.md. Until the coordinator
 * wires that adapter the server answers 404 and the view says so.
 * Whole-site rules have no purpose/model prerequisite.
 */
export type BlockingReadinessState='ready'|'enrollment_required'|'native_host_absent'|'site_access_required'|'unsupported'|'unknown';
export type BlockingPolicyState='active'|'paused'|'pending'|'cleanup_incomplete';
export interface BlockingPolicy {host:string;subdomains:boolean;purpose:string;version:number;state:BlockingPolicyState;pausedUntil:string|null;appliedAt:string|null}
export interface BlockingSnapshot {
 /** Adapter revision for optimistic concurrency; every mutation echoes it as expectedRevision. */
 revision:number;
 readiness:{state:BlockingReadinessState;browser:'chrome'|'unknown';platform:'mac'|'windows'|'other'|'unknown';observedAt:string|null};
 policy:BlockingPolicy|null;
}
export const BLOCKING_PAUSE_MINUTES=[5,15,30] as const;
const readinessStates:BlockingReadinessState[]=['ready','enrollment_required','native_host_absent','site_access_required','unsupported','unknown'];
const policyStates:BlockingPolicyState[]=['active','paused','pending','cleanup_incomplete'];
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const time=(v:unknown)=>v===null||typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const version=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
/** Mirrors the extension's own hostname admission (browser-extension/blocking/worker.ts). */
export function blockingHost(raw:string):string|undefined{
 const host=raw.trim().toLowerCase().replace(/\.$/,'');
 return host.length<=253&&/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)?host:undefined;
}
/** Strict shape check: an unrecognised reply is shown as unknown, never partially trusted. */
export function parseBlockingSnapshot(raw:unknown):BlockingSnapshot{
 const fail=()=>{throw Error('BLOCKING_RESPONSE_INVALID');};
 if(!object(raw)||!version(raw.revision)||!object(raw.readiness))return fail();
 const r=raw.readiness;
 if(!readinessStates.includes(r.state as BlockingReadinessState)||!['chrome','unknown'].includes(r.browser as string)
  ||!['mac','windows','other','unknown'].includes(r.platform as string)||!time(r.observedAt))return fail();
 let policy:BlockingPolicy|null=null;
 if(raw.policy!==null){
  const p=raw.policy;
  if(!object(p)||typeof p.host!=='string'||blockingHost(p.host)!==p.host||typeof p.subdomains!=='boolean'
   ||typeof p.purpose!=='string'||p.purpose.length>120||!version(p.version)||(p.version as number)<1
   ||!policyStates.includes(p.state as BlockingPolicyState)||!time(p.pausedUntil)||!time(p.appliedAt)
   ||(p.state==='paused')!==(p.pausedUntil!==null))return fail();
  policy={host:p.host,subdomains:p.subdomains,purpose:p.purpose,version:p.version as number,state:p.state as BlockingPolicyState,pausedUntil:p.pausedUntil as string|null,appliedAt:p.appliedAt as string|null};
 }
 return {revision:raw.revision as number,readiness:{state:r.state as BlockingReadinessState,browser:r.browser as 'chrome'|'unknown',platform:r.platform as BlockingSnapshot['readiness']['platform'],observedAt:r.observedAt as string|null},policy};
}
type Failure={kind:'unwired'|'signin'|'stale'|'busy'|'denied'|'server'|'invalid'|'network'|'other';text:string};
export function blockingFailure(error:unknown):Failure{
 const message=error instanceof Error?error.message:'';
 const status=Number(/^ACCOUNT_HTTP_(\d{3})/.exec(message)?.[1]);
 if(status===404||status===405||status===501)return {kind:'unwired',text:'Site blocking is not connected to your account on this server yet. Nothing was changed. You can still manage blocking in the Spindle extension: Options → Site blocking and recovery.'};
 if(status===401||message==='SIGNIN_REQUIRED')return {kind:'signin',text:'Your session ended. Sign in again to manage site blocking.'};
 if(status===409)return {kind:'stale',text:'The policy changed elsewhere (another tab or device). The current state is shown below; review it and try again.'};
 if(status===429)return {kind:'busy',text:'Another blocking change is still in progress. Wait a moment, then retry.'};
 if(status===403)return {kind:'denied',text:'The server refused this request. Reload the page and sign in again.'};
 if(status>=500)return {kind:'server',text:'The blocking service is unavailable right now. Your browser keeps its last applied policy; retry later.'};
 if(message==='BLOCKING_RESPONSE_INVALID')return {kind:'invalid',text:'The server returned an unrecognised blocking state. Treat protection as unknown and check the extension.'};
 if(error instanceof TypeError||message==='RESPONSE_BOUND'||/timeout/i.test(message))return {kind:'network',text:'Could not reach Spindle. Check your connection and retry.'};
 return {kind:'other',text:'Site blocking request failed. Treat protection as unknown and retry.'};
}
const silent=(error:unknown)=>error instanceof Error&&(error.name==='AbortError'||error.message==='ACCOUNT_CHANGED');
const readinessText:Record<BlockingReadinessState,string>={
 ready:'Chrome extension enrolled and its native host is connected.',
 enrollment_required:'Install the Spindle Chrome extension and enroll it with this account to enforce blocking.',
 native_host_absent:'Unsupported here: the Spindle native host is not connected, so this browser cannot receive policy. Blocking needs the Spindle app on a supported Mac or Windows device.',
 site_access_required:'Approve site access in the Spindle extension. Chrome only lets the extension block a site after you allow that site.',
 unsupported:'Unsupported here: this device or browser cannot enforce Spindle site blocking.',
 unknown:'The extension has not reported its state yet. Protection is unknown.',
};
const policyText:Record<BlockingPolicyState,string>={
 active:'Active',paused:'Paused',pending:'Change incomplete',cleanup_incomplete:'Cleanup incomplete',
};
const stamp=(iso:string)=>new Date(iso).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});

/*
 * Study -> leisure (optional rule, off until the owner opts in). Presentation over the
 * account service's /earned-leisure/* routes. Credit comes only from time the owner
 * labelled Learning; this page never earns, spends or pauses on its own. Applying a pause
 * belongs to the enrolled Chrome extension / native bridge, which a web page cannot reach
 * without new permissions, so redeem exists only behind an adapter that supplies the
 * owned device, host and policy version. Without one the control stays disabled.
 */
export interface EarnedState {enabled:boolean;earnedSeconds:number;spentSeconds:number;availableSeconds:number;basis:string;ratio:number;windowHours:number;minimumSeconds:number;maximumSeconds:number}
export interface EarnedLease {requestId:string;deviceId:string;host:string;policyVersion:number;seconds:number;issuedAt:number;expiresAt:number}
export interface EarnedTarget {deviceId:string;host:string;policyVersion:number}
export interface EarnedAdapter {
 /** The device, host and policy version this browser actually owns; undefined while unknown. */
 target():EarnedTarget|undefined;
 /** Applies the leased pause through the extension. Resolve false when it was not applied. */
 apply(lease:EarnedLease):Promise<boolean>;
}
export interface BlockingOptions {earnedAdapter?:EarnedAdapter}
const natural=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function parseEarned(raw:unknown):EarnedState{
 const fail=()=>{throw Error('EARNED_RESPONSE_INVALID');};
 if(!object(raw)||raw.configured!==true||typeof raw.enabled!=='boolean'||!object(raw.balance)||!object(raw.policy))return fail();
 const b=raw.balance,p=raw.policy;
 if(!natural(b.earnedSeconds)||!natural(b.spentSeconds)||!natural(b.availableSeconds)||b.availableSeconds>b.earnedSeconds||typeof b.basis!=='string'||b.basis.length>200)return fail();
 if(!natural(p.ratio)||!natural(p.windowHours)||!natural(p.minimumSeconds)||!natural(p.maximumSeconds)||(p.minimumSeconds)>(p.maximumSeconds))return fail();
 return {enabled:raw.enabled,earnedSeconds:b.earnedSeconds,spentSeconds:b.spentSeconds,availableSeconds:b.availableSeconds,basis:b.basis,ratio:p.ratio,windowHours:p.windowHours,minimumSeconds:p.minimumSeconds,maximumSeconds:p.maximumSeconds};
}
export function parseEarnedLease(raw:unknown,expected?:string):EarnedLease{
 const l=object(raw)&&object(raw.lease)?raw.lease:undefined;
 if(!l||typeof l.requestId!=='string'||(expected!==undefined&&l.requestId!==expected)||typeof l.deviceId!=='string'||typeof l.host!=='string'||blockingHost(l.host)!==l.host||!natural(l.policyVersion)||!natural(l.seconds)||!natural(l.issuedAt)||!natural(l.expiresAt))throw Error('EARNED_RESPONSE_INVALID');
 return {requestId:l.requestId,deviceId:l.deviceId,host:l.host,policyVersion:l.policyVersion as number,seconds:l.seconds as number,issuedAt:l.issuedAt as number,expiresAt:l.expiresAt as number};
}
export function earnedDuration(seconds:number){const m=Math.floor(seconds/60),s=seconds%60;return m?`${m}m${s?` ${s}s`:''}`:`${s}s`;}
const httpOf=(error:unknown)=>Number(/^ACCOUNT_HTTP_(\d{3})/.exec(error instanceof Error?error.message:'')?.[1]);

export function mountBlocking(context:PortalContext):()=>void{return createBlocking(context);}

export function createBlocking(context:PortalContext,options:BlockingOptions={}):()=>void{
 const {root,client}=context,doc=root.ownerDocument;
 const account=client.account?.id;
 const local=new AbortController();const signal=AbortSignal.any([context.signal,local.signal]);
 let snapshot:BlockingSnapshot|undefined,busy=false,last:{text:string;error:boolean}|undefined,pauseTimer:ReturnType<typeof setInterval>|undefined;
 let output:HTMLElement|undefined,remainingNode:HTMLElement|undefined;
 let earned:EarnedState|undefined,earnedStatus:'loading'|'ready'|'unavailable'|'error'='loading',earnedNote:{text:string;error:boolean}|undefined,earnedBusy=false;
 let pending:(EarnedTarget&{requestId:string;seconds:number})|undefined,view:{loading?:boolean;failure?:Failure}={};
 const live=()=>!signal.aborted&&client.account?.id===account;
 const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text?:string)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
 const lane=(node:HTMLElement,name:string)=>{node.setAttribute('data-blocking',name);return node;};
 const section=el('section','blocking-view');section.setAttribute('aria-labelledby','blocking-title');
 root.append(section);

 const stopPauseTimer=()=>{if(pauseTimer!==undefined){clearInterval(pauseTimer);pauseTimer=undefined;}};
 async function call(path:string,data:Record<string,unknown>){
  const reply=await client.request(path,data,signal);
  return parseBlockingSnapshot(reply);
 }
 function report(error:unknown){
  if(silent(error)||!live())return undefined;
  const failure=blockingFailure(error);
  if(failure.kind==='other'||failure.kind==='invalid')context.onError(error);
  return failure;
 }
 async function load(){
  render({loading:true});
  try{const next=await call('/blocking/status',{});if(!live())return;snapshot=next;render({});}
  catch(error){const failure=report(error);if(failure){snapshot=undefined;render({failure});}}
 }
 async function mutate(path:string,data:Record<string,unknown>,done:string){
  if(busy||!snapshot)return;busy=true;last={text:'Saving…',error:false};render({});
  try{
   const next=await call(path,{...data,expectedRevision:snapshot.revision});if(!live())return;
   snapshot=next;last={text:done,error:false};
  }catch(error){
   const failure=report(error);if(!failure)return;
   last={text:failure.text,error:true};
   if(failure.kind==='stale'){busy=false;await load();if(live()){last={text:failure.text,error:true};render({});}return;}
   if(failure.kind==='unwired'||failure.kind==='signin'){snapshot=undefined;busy=false;render({failure});return;}
  }finally{busy=false;}
  if(live())render({});
 }

 function earnedFailure(error:unknown){
  const status=httpOf(error);
  if(status===401||error instanceof Error&&error.message==='SIGNIN_REQUIRED')return 'Your session ended. Sign in again.';
  if(status===409)return 'The earned-time ledger could not be updated right now. Nothing was spent.';
  if(status===403)return 'The server refused this request. Reload the page and sign in again.';
  if(status===400)return 'The server rejected that request. Nothing was spent.';
  if(status===404)return 'No such request was recorded, so nothing was spent.';
  return 'The earned-time service could not be reached. The outcome is unconfirmed.';
 }
 const earnedCatch=(error:unknown,fallback:string)=>{
  if(silent(error)||!live())return false;
  if(httpOf(error)===401)context.onError(error);
  earnedNote={text:earnedFailure(error)||fallback,error:true};return true;
 };
 async function loadEarned(){
  try{earned=parseEarned(await client.request('/earned-leisure/read',{},signal));earnedStatus='ready';}
  catch(error){
   if(silent(error)||!live())return;
   earned=undefined;earnedStatus=[404,405,501,503].includes(httpOf(error))?'unavailable':'error';
   if(httpOf(error)===401)context.onError(error);
  }
  if(live())render(view);
 }
 async function setOptIn(enabled:boolean){
  if(earnedBusy)return;earnedBusy=true;earnedNote=undefined;render(view);
  try{earned=parseEarned(await client.request('/earned-leisure/opt-in',{enabled},signal));earnedNote={text:enabled?'Study → leisure is on. Only learning time from now on counts.':'Study → leisure is off. Unspent credit was dropped.',error:false};}
  catch(error){if(!earnedCatch(error,'Could not change the rule.'))return;}
  finally{earnedBusy=false;}
  if(live())render(view);
 }
 async function redeem(seconds:number){
  const adapter=options.earnedAdapter,target=adapter?.target();
  if(earnedBusy||!adapter||!target||!earned?.enabled)return;
  if(!Number.isInteger(seconds)||seconds<earned.minimumSeconds||seconds>Math.min(earned.maximumSeconds,earned.availableSeconds)){earnedNote={text:`Choose between ${earned.minimumSeconds} and ${Math.min(earned.maximumSeconds,earned.availableSeconds)} seconds.`,error:true};render(view);return;}
  // One stable request ID per intended spend: a retry after an unconfirmed reply replays, never double-spends.
  const same=pending&&pending.seconds===seconds&&pending.deviceId===target.deviceId&&pending.host===target.host&&pending.policyVersion===target.policyVersion;
  const request=same?pending!:{...target,seconds,requestId:newId()};pending=request;
  earnedBusy=true;earnedNote={text:'Spending earned time…',error:false};render(view);
  try{
   const reply=await client.request('/earned-leisure/redeem',{requestId:request.requestId,deviceId:request.deviceId,host:request.host,policyVersion:request.policyVersion,seconds},signal);
   const lease=parseEarnedLease(reply,request.requestId);earned=parseEarned(reply);pending=undefined;
   const applied=await adapter.apply(lease).catch(()=>false);
   earnedNote=applied?{text:`Earned pause applied to ${lease.host} for ${earnedDuration(lease.seconds)}.`,error:false}:{text:`${earnedDuration(lease.seconds)} was deducted from your earned time, but the pause was not applied in this browser. Do not assume ${lease.host} is open.`,error:true};
  }catch(error){
   if(silent(error)||!live())return;
   const status=httpOf(error);
   if(status>=400&&status<500&&status!==401)pending=undefined;
   earnedCatch(error,'');
   if(pending)earnedNote={text:'The outcome could not be confirmed and was not retried. Use “Check result”.',error:true};
  }finally{earnedBusy=false;}
  if(live())render(view);
 }
 async function checkRedeem(){
  const adapter=options.earnedAdapter,request=pending;if(earnedBusy||!request)return;
  earnedBusy=true;
  try{
   const reply=await client.request('/earned-leisure/status',{requestId:request.requestId},signal) as {expired?:unknown};
   const lease=parseEarnedLease(reply,request.requestId);pending=undefined;
   const applied=reply.expired===false&&adapter?await adapter.apply(lease).catch(()=>false):false;
   earnedNote={text:applied?`The earlier request was recorded and the pause is now applied to ${lease.host}.`:`The earlier request was recorded (${earnedDuration(lease.seconds)} on ${lease.host}) but no pause was applied by this page.`,error:!applied};
   await loadEarned();
  }catch(error){
   if(silent(error)||!live())return;
   if(httpOf(error)===404){pending=undefined;earnedNote={text:'The service has no record of that request, so no earned time was spent.',error:false};}
   else earnedCatch(error,'');
  }finally{earnedBusy=false;}
  if(live())render(view);
 }
 function earnedCard(){
  const card=lane(el('article','portal-card blocking-earned'),'earned');
  card.append(el('h3','','Study → leisure (optional)'));
  card.append(el('p','portal-muted','Off until you turn it on. When on, time you have labelled Learning earns the same amount of leisure, which you can spend as a timed pause of a blocked site.'));
  if(!earned){
   card.append(lane(el('p',earnedStatus==='error'?'portal-error':'portal-muted',earnedStatus==='loading'?'Loading your earned time…':earnedStatus==='unavailable'?'Study → leisure is not available on this account service. Nothing is earned or spent.':'Could not read your earned time. Nothing was changed.'),'earned-unavailable'));
   return card;
  }
  const facts=el('dl','blocking-facts');
  const fact=(term:string,value:string,name:string)=>{facts.append(el('dt','',term),lane(el('dd','',value),name));};
  fact('Rate',`${earned.ratio} second${earned.ratio===1?'':'s'} of leisure per second of learning (${earned.ratio}:1)`,'earned-rate');
  fact('Window',`${earned.windowHours} hours; earned and spent time both roll off`,'earned-window');
  fact('One pause',`${earnedDuration(earned.minimumSeconds)} to ${earnedDuration(earned.maximumSeconds)}`,'earned-size');
  card.append(facts,lane(el('p','portal-muted','Based on user-confirmed learning labels and observed recorded time, not verified learning. Only labels you set or confirmed count; AI suggestions, model confidence and focus-timer completion never earn. Time recorded before you opt in does not count.'),'earned-basis'));
  const toggle=sharedButton(earned.enabled?'Turn off study → leisure':'Turn on study → leisure',{variant:earned.enabled?'quiet':'primary',disabled:earnedBusy});
  lane(toggle,'earned-toggle');toggle.addEventListener('click',()=>void setOptIn(!earned!.enabled),{signal});
  const row=el('div','portal-actions');row.append(toggle);card.append(row);
  if(earned.enabled){
   const balance=el('dl','blocking-facts');
   const stat=(term:string,value:number,name:string)=>{balance.append(el('dt','',term),lane(el('dd','',earnedDuration(value)),name));};
   stat('Earned (last 24 h)',earned.earnedSeconds,'earned-total');stat('Spent',earned.spentSeconds,'earned-spent');stat('Available',earned.availableSeconds,'earned-available');
   card.append(lane(balance,'earned-balance'));
   if(!earned.earnedSeconds)card.append(lane(el('p','portal-muted','Nothing earned yet. Label recorded time as Learning (or confirm an AI suggestion) on the Activity page and it counts from now on.'),'earned-zero'));
   const target=options.earnedAdapter?.target(),max=Math.min(earned.maximumSeconds,earned.availableSeconds);
   if(target&&max>=earned.minimumSeconds){
    const form=el('div','portal-actions blocking-earned-redeem'),input=lane(el('input'),'earned-seconds') as HTMLInputElement;
    input.type='number';input.min=String(earned.minimumSeconds);input.max=String(max);input.step='1';input.value=String(pending?.seconds??Math.max(earned.minimumSeconds,Math.min(300,max)));input.setAttribute('aria-label','Seconds of earned pause');
    const spend=sharedButton(`Use earned time on ${target.host}`,{variant:'primary',disabled:earnedBusy});lane(spend,'earned-redeem');
    spend.addEventListener('click',()=>void redeem(Number(input.value)),{signal});form.append(input,spend);
    if(pending){const check=sharedButton('Check result',{disabled:earnedBusy});lane(check,'earned-check');check.addEventListener('click',()=>void checkRedeem(),{signal});form.append(check);}
    card.append(form);
   }else{
    const spend=sharedButton('Use earned time',{disabled:true});lane(spend,'earned-redeem');
    card.append(spend,lane(el('p','portal-muted','This page cannot pause a site or spend earned time. The pause is applied by the Spindle extension on your paired device: use the earned-time control in the paired companion. Nothing is deducted or paused from here.'),'earned-instruction'));
   }
  }
  if(earnedNote)card.append(lane(el('p',earnedNote.error?'portal-error':'portal-status',earnedNote.text),'earned-note'));
  return card;
 }
 function header(){
  const top=el('header','blocking-header');
  top.append(el('p','blocking-eyebrow portal-muted','Focus · Site blocking'));
  const title=el('h2','blocking-title','Block distracting sites');title.id='blocking-title';
  top.append(title,el('p','blocking-lead portal-muted','Spindle asks your enrolled Chrome extension to block whole sites. No AI review is needed to block a site, and nothing is recorded.'));
  return top;
 }
 function readinessCard(failure?:Failure){
  const card=lane(el('article','portal-card blocking-readiness'),'readiness');
  card.append(el('h3','','This browser'));
  const list=el('ul','blocking-checklist');
  const item=(state:'done'|'todo'|'blocked',text:string)=>{const li=el('li','blocking-check is-'+state);li.append(el('span','blocking-check-mark',state==='done'?'✓':state==='blocked'?'!':'•'),el('span','',text));li.firstElementChild!.setAttribute('aria-hidden','true');list.append(li);};
  const name=client.account?.name;
  item(name?'done':'todo',name?`Signed in as ${name}`:'Not signed in');
  if(!snapshot){
   item('blocked',failure?.kind==='unwired'?'Extension readiness unavailable: the account blocking adapter is not connected yet.':'Extension readiness unknown.');
  }else{
   const r=snapshot.readiness;
   item(r.state==='ready'?'done':r.state==='unknown'?'todo':'blocked',readinessText[r.state]);
   if(r.observedAt)item('done',`Last reported by ${r.browser==='chrome'?'Chrome':'the browser'}${r.platform==='mac'?' on Mac':r.platform==='windows'?' on Windows':''}: ${stamp(r.observedAt)}`);
  }
  card.append(list,lane(el('p','portal-muted blocking-private','Private and Incognito windows are unsupported: the extension does not run there, so blocks do not apply in them.'),'private'));
  return card;
 }
 function policyCard(){
  const card=lane(el('article','portal-card blocking-policy'),'policy');
  card.append(el('h3','','Current block'));
  const policy=snapshot?.policy;
  if(!policy){card.append(lane(el('p','portal-muted','No site is blocked.'),'empty'));return card;}
  const badge=lane(el('span','portal-badge blocking-state is-'+policy.state,policyText[policy.state]),'state');
  const host=lane(el('p','blocking-host',policy.host),'host');host.prepend(badge,doc.createTextNode(' '));
  card.append(host);
  const facts=el('dl','blocking-facts');
  const fact=(term:string,value:string,name:string)=>{facts.append(el('dt','',term),lane(el('dd','',value),name));};
  fact('Scope',policy.subdomains?'This site and all its subdomains':'This exact site only','scope');
  fact('Allowed purpose',policy.purpose||'None. The whole site is blocked with no exceptions.','purpose');
  fact('Policy version',`v${policy.version}`,'version');
  fact('Applied by browser',policy.appliedAt?stamp(policy.appliedAt):'Not yet confirmed by the extension','applied');
  if(policy.state==='paused'&&policy.pausedUntil)fact('Paused until',stamp(policy.pausedUntil),'paused-until');
  card.append(facts);
  if(policy.state==='pending')card.append(el('p','portal-status','The change is incomplete and protection may be partial. Save the rule again, or remove it to recover.'));
  if(policy.state==='cleanup_incomplete')card.append(el('p','portal-status','Removal has not finished in the browser. Remove again, or open the extension controls.'));
  const actions=el('div','portal-actions blocking-actions');
  const button=(label:string,name:string,run:()=>void,disabled=false)=>{const b=lane(el('button','',label),name) as HTMLButtonElement;b.type='button';b.disabled=busy||disabled;b.addEventListener('click',run,{signal});actions.append(b);return b;};
  if(policy.state==='paused'){
   remainingNode=lane(el('p','portal-status',remainingText(policy.pausedUntil)),'pause-remaining');card.append(remainingNode);
   button('Resume blocking now','resume',()=>void mutate('/blocking/resume',{},'Blocking resumed.'));
  }else if(policy.state==='active'){
   for(const minutes of BLOCKING_PAUSE_MINUTES)button(`Pause ${minutes} min`,`pause-${minutes}`,()=>void mutate('/blocking/pause',{minutes},`Paused for ${minutes} minutes.`));
  }
  button('Remove block / recover access','remove',()=>void mutate('/blocking/remove',{},'Block removed. The extension keeps the site permission it shares with capture; revoke it in Chrome settings if you want.'));
  card.append(actions);
  return card;
 }
 function ruleForm(){
  const form=lane(el('form','portal-card blocking-form'),'form') as HTMLFormElement;
  form.noValidate=true;
  form.append(el('h3','',snapshot?.policy?'Replace the block':'Block a site'));
  const field=(label:string,input:HTMLInputElement,hint?:string)=>{const wrap=el('label','blocking-field');wrap.append(el('span','',label),input);if(hint)wrap.append(el('span','portal-muted',hint));form.append(wrap);};
  const host=lane(el('input'),'host-input') as HTMLInputElement;host.name='host';host.autocomplete='off';host.spellcheck=false;host.placeholder='example.com';host.maxLength=254;
  field('Website',host,'Hostname only, for example news.example.com.');
  const subdomains=lane(el('input'),'subdomains') as HTMLInputElement;subdomains.type='checkbox';subdomains.name='subdomains';
  const sub=el('label','blocking-field blocking-inline');sub.append(subdomains,el('span','','Also block all subdomains'));form.append(sub);
  const purpose=lane(el('input'),'purpose-input') as HTMLInputElement;purpose.name='purpose';purpose.maxLength=120;purpose.placeholder='Optional';
  field('Allowed purpose (optional)',purpose,'Leave blank to block the whole site. A purpose only matters for reviewing individual pages in the extension.');
  if(snapshot?.policy)form.append(el('p','portal-muted','Only one block is supported. Saving replaces the current block and clears its page exceptions.'));
  const submit=lane(el('button','','Block site'),'submit') as HTMLButtonElement;submit.type='submit';
  const unsupported=snapshot?.readiness.state==='unsupported'||snapshot?.readiness.state==='native_host_absent';
  submit.disabled=busy||unsupported;
  const actions=el('div','portal-actions');actions.append(submit);form.append(actions);
  if(unsupported)form.append(el('p','portal-muted','Blocking cannot be enforced from this device until a supported browser is enrolled.'));
  form.addEventListener('submit',event=>{
   event.preventDefault();
   const chosen=blockingHost(host.value);
   // Validation updates only the status line so typed input is kept.
   if(!chosen){say(/[/:]/.test(host.value)?'Enter a hostname only, without https:// or a path.':'Enter a website hostname, for example example.com.',true);host.focus();return;}
   const text=purpose.value.trim();
   if(text.length>120){say('The purpose must be at most 120 characters.',true);return;}
   void mutate('/blocking/rule',{host:chosen,subdomains:subdomains.checked,purpose:text},`Saved. Waiting for the extension to apply the block to ${chosen}.`);
  },{signal});
  return form;
 }
 function recoveryCard(){
  const card=lane(el('article','portal-card blocking-recovery'),'recovery');
  card.append(el('h3','','If something goes wrong'));
  for(const text of [
   'Remove block / recover access deletes the rule and any page exceptions.',
   'If this page is unavailable, open the Spindle extension: Options → Site blocking and recovery → Remove.',
   'Blocking is voluntary. Disabling or uninstalling the extension turns it off.',
   'A saved policy is not continuous proof of protection. A change marked incomplete may only partly apply until you retry or remove it.',
  ])card.append(el('p','portal-muted',text));
  return card;
 }
 function remainingText(until:string|null){
  const remaining=until?Math.max(0,Math.ceil((Date.parse(until)-Date.now())/60000)):0;
  return `Paused: the site is reachable for about ${remaining} more minute${remaining===1?'':'s'}. Blocking resumes automatically.`;
 }
 function say(text:string,error:boolean){
  last={text,error};
  if(output){output.className=error?'portal-error blocking-last':'portal-status blocking-last';output.textContent=text;}
 }
 function render(state:{loading?:boolean;failure?:Failure}){
  if(!live())return;
  view=state;
  stopPauseTimer();remainingNode=undefined;
  const body:HTMLElement[]=[header()];
  if(state.loading){body.push(lane(el('p','portal-status','Loading your blocking policy…'),'loading'));section.setAttribute('aria-busy','true');}
  else section.removeAttribute('aria-busy');
  if(state.failure){
   const box=lane(el('div','portal-error blocking-error'),state.failure.kind==='unwired'?'unwired':'error');box.setAttribute('role','alert');box.append(el('p','',state.failure.text));
   if(state.failure.kind!=='signin'){const retry=lane(el('button','','Retry'),'retry') as HTMLButtonElement;retry.type='button';retry.addEventListener('click',()=>void load(),{signal});box.append(retry);}
   body.push(box);
  }
  if(!state.loading){
   const grid=el('div','portal-grid blocking-grid');
   grid.append(readinessCard(state.failure));
   if(snapshot){grid.append(policyCard(),ruleForm());}
   grid.append(earnedCard(),recoveryCard());body.push(grid);
  }
  output=lane(el('p',last?.error?'portal-error blocking-last':'portal-status blocking-last',last?.text??''),'last');
  output.setAttribute('role','status');output.setAttribute('aria-live','polite');body.push(output);
  section.replaceChildren(...body);
  const until=snapshot?.policy?.state==='paused'?snapshot.policy.pausedUntil:null;
  if(until&&!busy){
   // Display refresh only; the extension enforces the pause end, not this tab.
   pauseTimer=setInterval(()=>{if(!live())return stopPauseTimer();if(Date.now()>=Date.parse(until)){stopPauseTimer();void load();}else if(remainingNode)remainingNode.textContent=remainingText(until);},15000);
  }
 }
 signal.addEventListener('abort',stopPauseTimer,{once:true});
 void load().then(loadEarned);
 return ()=>{local.abort();stopPauseTimer();section.remove();};
}
