import { admitResource } from '../../core/blocking/admission.js';
import {resourceIdentity,type PolicyRevision} from '../../core/blocking/policy.js';
import {producePurposeContent} from './content.js';
import {requestPurposeEligibility} from './purpose-client.js';
export {installPurposeTransport} from './purpose-client.js';
// Independent voluntary controls; never reads capture enrollment, history or clocks.
const grants = new Map<number, {resource:string; expires:number; version:number;kind?:'jev'}>();
let purposePending:{tabId:number;controller:AbortController}|undefined;
let purposeGeneration=0;
function cancelPurpose(){purposeGeneration++;purposePending?.controller.abort();}
chrome.permissions.onRemoved?.addListener(cancelPurpose);
// In-memory provenance only: delivered cold-start events may invalidate restored
// authority, but never a new review that replaced it while the event was queued.
const restoredGrants = new WeakSet<object>();
// Existing exception wire signature, not a blanket numeric ID reservation.
// Other extension seams must not emit this exact protocol shape.
function ownedTab(rule:chrome.declarativeNetRequest.Rule):number|undefined {
 const c=rule.condition;
 const tab=c.tabIds?.[0];
 if(!Number.isSafeInteger(tab) || tab!<0 || rule.id!==tab!+100000 || rule.priority!==2
  || rule.action.type!=='allow' || Object.keys(rule.action).length!==1
  || c.tabIds?.length!==1 || c.resourceTypes?.length!==1 || c.resourceTypes[0]!=='main_frame'
  || c.isUrlFilterCaseSensitive!==true || typeof c.regexFilter!=='string'
  || Object.keys(c).some(key=>!['tabIds','resourceTypes','isUrlFilterCaseSensitive','regexFilter'].includes(key))) return;
 // Require the exact escaped HTTP(S) URL encoding emitted by resource-review.
 const encoded=c.regexFilter;
 if(!encoded.startsWith('^') || !encoded.endsWith('$')) return;
 const resource=encoded.slice(1,-1).replace(/\\([.*+?^${}()|[\]\\])/g,'$1');
 try {
  const url=new URL(resource);
  if(!['http:','https:'].includes(url.protocol) || url.href!==resource
   || `^${resource.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`!==encoded) return;
 } catch { return; }
 return tab;
}
let initialization:Promise<void>|undefined;
let initialized=false;
let policyDeletion=0;
let absenceVerified=false;
let cleanupRetryUsed=false;
async function recoverPolicy():Promise<void> {
 try { await reconcilePolicy(); cleanupRetryUsed=false; }
 catch(error) {
  // Absence is itself durable cleanup intent, including after storage.clear.
  // One automatic retry per failed cleanup burst; controls/startup can retry.
  if(!(await chrome.storage.local.get('sitePolicy')).sitePolicy && !cleanupRetryUsed) {
   cleanupRetryUsed=true;
   await chrome.alarms.create('blocking-recovery',{when:Date.now()+1000});
  }
  throw error;
 }
}
async function ensureReady():Promise<void> {
 if(initialized) return;
 if(!initialization) initialization=initialize().then(()=>{initialized=true;}).catch(async error=>{
  // One attempt per event/alarm, never a permanently rejected startup latch.
  // Unknown session authority must not be treated as a successful restore.
  try { await chrome.alarms.create('blocking-recovery',{when:Date.now()+1000}); }
  catch { /* known/tab-scoped authority is removed below even without a wakeup */ }
  const known=new Set(grants.keys());
  for(const id of known) {
   await revoke(id,false).catch(error=>console.error('Blocking initialization revocation pending',error));
   // The single recovery alarm owns initialization retries. Do not multiply
   // retries with a per-grant alarm after closing an uninspectable target.
   await chrome.alarms.clear(`blocking-${id}`).catch(()=>{});
  }
  // Unknown rules cannot safely be deleted using tab-derived numeric IDs.
  // Known grants close their tab if authority cannot be inspected below.
  throw error;
 }).finally(()=>{initialization=undefined;});
 return initialization;
}
const ready=ensureReady().catch(error=>console.error('Blocking initialization pending',error));
async function initialize():Promise<void> {
 if(!await chrome.permissions.contains({permissions:['declarativeNetRequestWithHostAccess']})) return;
 // Session metadata never creates network authority. Unreadable metadata fails closed.
 let blockingGrants:Record<string,{resource:string; expires:number; version:number;kind?:'jev'}>={};
 try { ({blockingGrants={}}=await chrome.storage.session.get('blockingGrants')); }
 catch(error) { console.error('Blocking exception metadata unavailable',error); }
 for(const [id,grant] of Object.entries(blockingGrants ?? {})) {
  const tab=Number(id);
  if(Number.isSafeInteger(tab) && tab>=0 && String(tab)===id) grants.set(tab,grant);
 }
 const rules=await chrome.declarativeNetRequest.getSessionRules();
 for(const rule of rules) {
  const id=ownedTab(rule);
  if(id!==undefined && !grants.has(id)) grants.set(id,{resource:'',expires:0,version:0});
 }
 for(const [id,grant] of grants) {
  const rule=rules.find(rule=>ownedTab(rule)===id);
  const expected=typeof grant?.resource==='string' ? `^${grant.resource.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$` : undefined;
  if(!rule || rule.condition.regexFilter!==expected || !Number.isSafeInteger(grant?.version)) {
   grants.set(id,{resource:'',expires:0,version:0});
   await revoke(id,false); continue;
  }
  restoredGrants.add(grant);
  // An automatic decision is a one-worker admission, not reusable authority
  // after host/worker restart. Whole-site rules remain independently durable.
  if(grant.kind==='jev'||!Number.isFinite(grant.expires) || Date.now()>=grant.expires) await revoke(id).catch(error=>console.error('Blocking startup revocation pending',error));
  else {
   try { await chrome.alarms.create(`blocking-${id}`,{when:grant.expires}); }
   catch { await revoke(id).catch(error=>console.error('Blocking startup revocation pending',error)); }
  }
 }
 await recoverPolicy().catch(error=>console.error('Blocking policy recovery pending; use controls',error));
 await resumeIfDue().catch(error=>console.error('Blocking pause expiry pending; use controls',error));
 if(!cleanupRetryUsed) await chrome.alarms.clear('blocking-recovery');
}
async function revoke(tabId:number,reload=true): Promise<void> {
 // Keep a recovery wakeup and the in-memory grant until network revocation succeeds.
 // Persistence is bookkeeping, never a prerequisite for removing authority.
 let retryScheduled=false;
 try { await chrome.alarms.create(`blocking-${tabId}`,{when:Date.now()+1000}); retryScheduled=true; } catch { /* still attempt network removal */ }
 try {
  const rule=(await chrome.declarativeNetRequest.getSessionRules()).find(rule=>rule.id===tabId+100000);
  if(rule && ownedTab(rule)===tabId) await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[rule.id]});
 }
 catch(error) {
  // Inspection failure must not delete another seam's rule. Closing the known
  // target bounds its tab-scoped authority while the recovery alarm retries.
  await chrome.tabs.remove(tabId).catch(()=>{});
  const grant=grants.get(tabId);
  if(grant) {
   grant.expires=0;
   // Persist the revocation intent, not its former future deadline. A restart
   // must retry immediately rather than re-arm an already cancelled grant.
   try { await saveGrants(); }
   catch { await chrome.tabs.remove(tabId); }
  }
  if(!retryScheduled) await chrome.tabs.remove(tabId);
  throw error;
 }
 grants.delete(tabId);
 try { await saveGrants(); } catch(error) { console.error('Blocking revoked metadata not persisted',error); }
 await chrome.alarms.clear(`blocking-${tabId}`);
 if(reload) try { await chrome.tabs.reload(tabId); } catch { /* closed */ }
}
chrome.alarms.onAlarm.addListener(alarm => {
 if(alarm.name==='blocking-recovery') { enqueue(recoverPolicy); return; }
 if(alarm.name===PAUSE_ALARM) { enqueue(resumeIfDue); return; }
 if (alarm.name.startsWith('blocking-')) enqueue(async()=>{
  const id=Number(alarm.name.slice(9));
  const grant=grants.get(id);
  if(grant) {
   if(Date.now()>=grant.expires) await revoke(id);
   else await chrome.alarms.create(`blocking-${id}`,{when:grant.expires});
  }
 });
});
async function saveGrants(): Promise<void> {
 if(grants.size) await chrome.storage.session.set({blockingGrants:Object.fromEntries(grants)});
 else await chrome.storage.session.remove('blockingGrants');
}
async function stopGuards(strict=false): Promise<void> {
 try { await chrome.scripting.unregisterContentScripts({ids:['blocking-guard']}); }
 catch(error) { if(strict && !(error instanceof Error && error.message==="Nonexistent script ID 'blocking-guard'")) throw error; }
 for(const tab of await chrome.tabs.query({})) if(tab.id!==undefined) await chrome.tabs.sendMessage(tab.id,{type:'blocking-stop'}).catch(()=>{});
}
chrome.storage.onChanged.addListener((changes,area)=>{
 if(area==='local' && changes.sitePolicy) {
  cancelPurpose();
  if(!changes.sitePolicy.newValue) { policyDeletion++; absenceVerified=false; }
  enqueue(async()=>{
   // Read current state, not the event snapshot: queued deletions may be stale.
   let {sitePolicy:policy}=await chrome.storage.local.get('sitePolicy');
   // A deletion event can arrive after the transaction's final write callback.
   // Cancel only that exact revision, never a later queued user enable.
   const cancelled=changes.sitePolicy.oldValue?.pending?.revision;
   if(!changes.sitePolicy.newValue && cancelled!==undefined && policy?.version===cancelled) {
    await chrome.storage.local.remove('sitePolicy'); policy=undefined;
   }
   if(policy?.pending) return; // Durable transaction owns partial enforcement.
   if(!policy) {
    await recoverPolicy();
    policy=(await chrome.storage.local.get('sitePolicy')).sitePolicy;
    if(policy?.pending) return;
   }
   for(const [tabId,grant] of grants) if(!policy || grant.version!==policy.version) await revoke(tabId);
  });
 }
});
chrome.tabs.onRemoved.addListener(tabId => {if(purposePending?.tabId===tabId)cancelPurpose();enqueue(async()=>{if(grants.has(tabId)) await revoke(tabId);});});
chrome.tabs.onUpdated.addListener((tabId, change) => {
 if(purposePending?.tabId===tabId&&(change.url||change.status==='loading'))cancelPurpose();
 // Preserve an observed departure before any await/current-tab read can erase
 // it on a rapid return. Mutate only the grant present at event receipt, never
 // a later review's replacement. Browser event delivery/DNR removal still race.
 const observed=grants.get(tabId);
 const restoring=!initialized;
 if(observed && change.url && change.url!==observed.resource) observed.expires=0;
 if(change.url || change.status) enqueue(async()=>{
  const grant=grants.get(tabId);
  if(!grant) return;
  // During cold restoration there may be no grant to expire at event receipt.
  // Preserve that event only against restored objects, not later user reviews.
  if(restoring && restoredGrants.has(grant) && change.url && change.url!==grant.resource) grant.expires=0;
  const tab=await chrome.tabs.get(tabId).catch(()=>undefined);
  if(Date.now()>=grant.expires || !tab || (tab.pendingUrl ?? tab.url)!==grant.resource) await revoke(tabId);
 });
});
const RULE = 78001;
async function reconcilePolicy():Promise<void> {
 const {sitePolicy}=await chrome.storage.local.get('sitePolicy');
 const pending=sitePolicy?.pending;
 if(!sitePolicy) {
  absenceVerified=false;
  // Reuse the transaction reconciler and owned IDs; no capture storage writes.
  // The mutation queue serializes controls with cleanup. Recheck external
  // storage changes after each await before deleting any further authority.
  const absent=async()=>!(await chrome.storage.local.get('sitePolicy')).sitePolicy;
  if(!await absent()) return;
  try { await chrome.scripting.unregisterContentScripts({ids:['blocking-guard']}); }
  catch(error) { if(!(error instanceof Error && error.message==="Nonexistent script ID 'blocking-guard'")) throw error; }
  if(!await absent()) return;
  const tabs=await chrome.tabs.query({});
  for(const tab of tabs) if(tab.id!==undefined) {
   if(!await absent()) return;
   await chrome.tabs.sendMessage(tab.id,{type:'blocking-stop'}).catch(()=>{});
  }
  if(!await absent()) return;
  for(const tabId of grants.keys()) {
   if(!await absent()) return;
   await revoke(tabId,false);
  }
  if(!await absent()) return;
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[RULE]});
  if(!await absent()) return;
  await chrome.alarms.clear(PAUSE_ALARM).catch(()=>{});
  absenceVerified=true;
  return;
 }
 if(!pending) return;
 const deletion=policyDeletion;
 // A journaled pause recovered at or beyond its deadline (or an implausible
 // one after a clock change) applies the block instead; never a fresh pause.
 const p=pending.policy && pending.policy.pausedUntil!==undefined && !pauseLive(pending.policy)
  ? withoutPause(pending.policy) : pending.policy;
 // Browser-owned expiry exists before any enforcement is lifted.
 if(p?.pausedUntil!==undefined) await chrome.alarms.create(PAUSE_ALARM,{when:p.pausedUntil});
 async function checkDeletion():Promise<void> {
  if(policyDeletion===deletion) return;
  // Capture revoke/clear is an independent fence, not a failed policy commit
  // to roll forward. Never republish policy after that deletion.
  await stopGuards(true);
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[RULE]});
  await chrome.storage.local.remove('sitePolicy');
  throw new Error('Policy change cancelled by storage deletion.');
 }
 // Forward recovery is idempotent; never roll back to a possibly unenforced
 // Active snapshot. One attempt per startup/control, no self-triggered loop.
 for(const tabId of grants.keys()) await revoke(tabId,false);
 await stopGuards(true);
 if(p?.pausedUntil!==undefined) {
  // Same journal, same owned rule: a pause is the policy without enforcement.
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[RULE]});
  await checkDeletion();
  await chrome.storage.local.set({sitePolicy:p,sitePolicyRevision:pending.revision});
  await checkDeletion();
 } else if(p) {
  const origins=[p.host,`${p.host}.`].flatMap(h=>[`http://${p.subdomains?'*.':''}${h}/*`,`https://${p.subdomains?'*.':''}${h}/*`]);
  if(!await chrome.permissions.contains({permissions:['declarativeNetRequestWithHostAccess'],origins})) throw new Error('Policy recovery needs site permission; remove policy to recover.');
  await chrome.scripting.registerContentScripts([{id:'blocking-guard',matches:origins,js:['blocking/guard.js'],runAt:'document_start',persistAcrossSessions:true}]);
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[RULE],addRules:[{
   id:RULE,priority:1,action:{type:chrome.declarativeNetRequest.RuleActionType.BLOCK},
   condition:{regexFilter:`^https?://(${p.subdomains?'([^/.]+\\.)*':''}${p.host.replaceAll('.','\\.')}\\.?)(:[0-9]+)?/`,resourceTypes:[chrome.declarativeNetRequest.ResourceType.MAIN_FRAME]}
  }]});
  // Registered scripts do not reach existing documents. Re-gate those before
  // publishing Active, including when startup is finishing an interrupted write.
  for(const tab of await chrome.tabs.query({})) {
   if(tab.incognito || !tab.url || tab.id===undefined) continue;
   const matches=(url:string):boolean=>{const host=new URL(url).hostname.replace(/\.$/,'');return host===p.host || (p.subdomains && host.endsWith(`.${p.host}`));};
   if(!matches(tab.url)) continue;
   try { await chrome.tabs.reload(tab.id); }
   catch {
    // Rejection does not mean closed. Query failure/unknown identity must keep
    // durable pending status; registration alone cannot gate a loaded document.
    const current=(await chrome.tabs.query({})).find(current=>current.id===tab.id);
    if(!current) continue;
    if(!current.url || matches(current.url) || (current.pendingUrl && matches(current.pendingUrl))) throw new Error('Existing tab protection incomplete; retry policy or remove it to recover.');
    // The tab demonstrably left this policy's host. Do not reload or retain
    // unrelated browsing identity; a future matching navigation is DNR-gated.
   }
  }
  await checkDeletion();
  await chrome.storage.local.set({sitePolicy:p,sitePolicyRevision:pending.revision});
  await checkDeletion();
  // A stale pause wakeup is harmless (resumeIfDue rereads); clearing is tidiness.
  await chrome.alarms.clear(PAUSE_ALARM).catch(()=>{});
 } else {
  if(await chrome.permissions.contains({permissions:['declarativeNetRequestWithHostAccess']})) await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[RULE]});
  await chrome.storage.local.set({sitePolicyRevision:pending.revision});
  await chrome.storage.local.remove('sitePolicy');
  await chrome.alarms.clear(PAUSE_ALARM).catch(()=>{});
 }
}
const PAUSE_ALARM='blocking-pause';
const PAUSE_MIN_SECONDS=30, PAUSE_MAX_SECONDS=1800;
type SitePolicy={host:string;subdomains:boolean;purpose:string;version:number;pausedUntil?:number;earnedLease?:string};
// Pause expiry is browser-owned: without alarms there is no pause, not a page timer.
const pauseSupported=():boolean=>typeof chrome.alarms?.create==='function';
function pauseLive(p:SitePolicy):boolean {
 const remaining=(p.pausedUntil ?? NaN)-Date.now();
 return Number.isSafeInteger(p.pausedUntil) && remaining>0 && remaining<=PAUSE_MAX_SECONDS*1000;
}
function withoutPause({pausedUntil:_,earnedLease:__,...p}:SitePolicy):SitePolicy { return p; }
async function journal(stored:Record<string,any>,policy:(version:number)=>SitePolicy|null):Promise<void> {
 const revision=Math.max(Number.isSafeInteger(stored.sitePolicyRevision) ? stored.sitePolicyRevision as number : 0, stored.sitePolicy?.pending?.revision ?? 0)+1;
 // Journal before changing either browser subsystem. Failed commits retain an
 // explicit pending state, not an Active claim about the previous policy.
 await chrome.storage.local.set({sitePolicy:{...stored.sitePolicy,pending:{policy:policy(revision),revision}}});
 await reconcilePolicy();
}
// Alarm, startup and status all converge here; an early wakeup re-arms the
// original deadline and never extends or restarts the pause.
async function resumeIfDue():Promise<void> {
 const stored=await chrome.storage.local.get(['sitePolicy','sitePolicyRevision']);
 const p=stored.sitePolicy;
 const pendingPause=p?.pending?.policy?.pausedUntil!==undefined ? p.pending.policy as SitePolicy : undefined;
 if(pendingPause) {
  // A pause whose final save failed may already have lifted enforcement. Its
  // deadline still binds a live worker: overdue reuses startup recovery (block
  // or honest pending without site access); early re-arms the same deadline.
  if(!pauseLive(pendingPause)) await reconcilePolicy();
  else await chrome.alarms.create(PAUSE_ALARM,{when:pendingPause.pausedUntil!});
  return;
 }
 if(!p || p.pending || p.pausedUntil===undefined) return;
 if(pauseLive(p)) {
  try { await chrome.alarms.create(PAUSE_ALARM,{when:p.pausedUntil}); return; }
  catch(error) { console.error('Pause expiry cannot be scheduled; resuming block',error); }
 }
 await journal(stored,version=>({...withoutPause(p),version}));
}
function blockingState(p:SitePolicy&{pending?:unknown}|undefined):string {
 if(!p) return absenceVerified ? 'none' : 'cleanup_incomplete';
 if(p.pending) return 'pending';
 return p.pausedUntil!==undefined ? 'paused' : 'active';
}
async function statusSnapshot():Promise<Record<string,unknown>> {
 const {sitePolicy}=await chrome.storage.local.get('sitePolicy');
 return {sitePolicy,absenceVerified,state:blockingState(sitePolicy),
  pause:{supported:pauseSupported(),minSeconds:PAUSE_MIN_SECONDS,maxSeconds:PAUSE_MAX_SECONDS}};
}
let mutation = Promise.resolve();
function enqueue(action:()=>Promise<void>): void {
 // Initialization calls revoke directly; queued events wait for initialization,
 // never the reverse. Keep a failed event from poisoning subsequent controls.
 mutation=mutation.then(async()=>{await ensureReady();await action();}).catch(error=>console.error('Blocking lifecycle reconciliation failed',error));
}
async function installResourceGrant(p:PolicyRevision,tabId:number,tab:chrome.tabs.Tab,resource:string,expires:number,kind?:'jev',valid:()=>boolean=()=>true):Promise<void>{
 const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 try{
  const occupying=(await chrome.declarativeNetRequest.getSessionRules()).find(rule=>rule.id===tabId+100000);
  if(occupying&&ownedTab(occupying)!==tabId)throw Error('Resource exception rule ID belongs to another control.');
  if(!valid())throw Error('Review cancelled before installation.');
  grants.set(tabId,{resource,expires,version:p.version,...(kind?{kind}:{})});
  await saveGrants();await chrome.alarms.create(`blocking-${tabId}`,{when:expires});
  if(!valid())throw Error('Review cancelled before installation.');
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[tabId+100000],addRules:[{id:tabId+100000,priority:2,action:{type:chrome.declarativeNetRequest.RuleActionType.ALLOW},condition:{regexFilter:`^${escape(resource)}$`,isUrlFilterCaseSensitive:true,tabIds:[tabId],resourceTypes:[chrome.declarativeNetRequest.ResourceType.MAIN_FRAME]}}]});
  const installedPolicy=(await chrome.storage.local.get('sitePolicy')).sitePolicy;
  const installedTab=await chrome.tabs.get(tabId);
  if(!valid()||installedPolicy?.pending||installedPolicy?.version!==p.version||installedPolicy?.purpose!==p.purpose
   ||installedTab.url!==tab.url||installedTab.pendingUrl!==tab.pendingUrl||Date.now()>=expires||!grants.has(tabId))throw Error('Policy, navigation or expiry changed during installation.');
  await chrome.alarms.create(`blocking-${tabId}`,{when:expires});
  if(!valid())throw Error('Review cancelled before navigation.');
  await chrome.tabs.update(tabId,{url:resource});
 }catch(error){await revoke(tabId);throw error;}
}
async function reviewWithJev(input:{processingConsent?:boolean;resource?:string;version?:number;tabId?:number;seconds?:number}):Promise<void>{
 // No reads of content, profile enrollment, model keys or provider budget before
 // this separate user choice. Whole-site blocking does not depend on this path.
 if(input.processingConsent!==true)throw Error('Separate processing consent is required; resource remains blocked.');
 if(purposePending)throw Error('Jev review busy; resource remains blocked.');
 if(!Number.isInteger(input.tabId))throw Error('Choose a target tab.');
 // Reserve the cancellable operation before the first await. Consent withdrawal
 // during initialization/permission/tab preparation must never become a new grant.
 const operation={tabId:input.tabId!,controller:new AbortController()},generation=purposeGeneration;
 purposePending=operation;const timer=setTimeout(()=>operation.controller.abort(),8000);
 const current=()=>purposePending===operation&&!operation.controller.signal.aborted&&generation===purposeGeneration;
 try{
  await ensureReady();if(!current())throw Error('Review cancelled; resource remains blocked.');
  const {sitePolicy:p}=await chrome.storage.local.get('sitePolicy');
  if(!current()||!p||p.pending||p.pausedUntil!==undefined||p.version!==input.version||!p.purpose)throw Error('Choose an allowed purpose and current active policy before Jev review.');
  const resource=input.resource??'';if(resourceIdentity(resource)!==resource)throw Error('Unsupported or unsanitised resource identity.');
  const url=new URL(resource),host=url.hostname.replace(/\.$/,'');
  if(host!==p.host&&!(p.subdomains&&host.endsWith(`.${p.host}`)))throw Error('Resource outside blocked host.');
  const permitted=()=>chrome.permissions.contains({origins:[`${url.origin}/*`]});
  if(!await permitted()||!current())throw Error('Chosen site permission or processing consent is unavailable.');
  const tab=await chrome.tabs.get(input.tabId!);
  if(!current()||tab.incognito!==false)throw Error('Private, cancelled or unknown tab state is not admitted.');
  const evidence=await producePurposeContent(resource,operation.controller.signal);
  const fresh=await chrome.tabs.get(operation.tabId),policy=(await chrome.storage.local.get('sitePolicy')).sitePolicy;
  if(!current()||fresh.url!==tab.url||fresh.pendingUrl!==tab.pendingUrl||policy?.pending||policy?.version!==p.version||policy?.purpose!==p.purpose||!await permitted())throw Error('Source, navigation or policy changed; review again.');
  const result=await requestPurposeEligibility({resource,purpose:p.purpose,policyVersion:p.version,
   source:{resource,evidenceId:evidence.evidenceId,mode:'static-resource'},title:evidence.title,summary:evidence.summary,pageText:evidence.pageText},current,operation.controller.signal);
  if(result.verdict!=='allow')throw Error(`Jev ${result.verdict}: ${result.reason}; resource remains blocked.`);
  const next=mutation.then(async()=>{
   const policy=(await chrome.storage.local.get('sitePolicy')).sitePolicy,latest=await chrome.tabs.get(operation.tabId);
   if(!current()||policy?.pending||policy?.version!==p.version||policy?.purpose!==p.purpose||latest.url!==tab.url||latest.pendingUrl!==tab.pendingUrl||latest.incognito!==false||!await permitted())throw Error('Stale Jev eligibility; resource remains blocked.');
   const now=Date.now(),expires=now+Math.min(300,Math.max(1,input.seconds??60))*1000;
   const admitted=await admitResource({policy:p,resource,requestedAt:now,expires},()=>policy,Date.now,async()=>result.verdict);
   if(!admitted.grant)throw Error(`Jev eligibility refused: ${admitted.reason}.`);
   await installResourceGrant(p,operation.tabId,tab,resource,expires,'jev',current);
  });
  // Only authority installation enters the existing mutation queue. Content and
  // model latency must not hold Remove, policy changes or lifecycle cleanup.
  mutation=next.then(()=>{}).catch(()=>{});await next;
 }catch(error){
  const cleanup=mutation.then(async()=>{if(grants.get(operation.tabId)?.kind==='jev')await revoke(operation.tabId);});
  mutation=cleanup.catch(()=>{});await cleanup;throw error;
 }finally{clearTimeout(timer);if(purposePending===operation)purposePending=undefined;}
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
 const input = message as { type?: string; host?: string; subdomains?: boolean; purpose?:string; resource?:string; override?:boolean; version?:number; tabId?:number; seconds?:number; processingConsent?:boolean; lease?:{id?:unknown;host?:unknown;until?:unknown} };
 if (sender.id !== chrome.runtime.id) return;
 if (input.type==='resource-check' && sender.tab?.id !== undefined) {
  void ensureReady().then(async()=>{
   const {sitePolicy:p}=await chrome.storage.local.get('sitePolicy');
   if(p?.pending) {
    if(p.pending.policy?.pausedUntil!==undefined && !pauseLive(p.pending.policy)) enqueue(resumeIfDue);
    reply({active:true,gated:true}); return;
   }
   if(p?.pausedUntil!==undefined) {
    // A live pause stops the guard; an overdue one stays gated while expiry runs.
    if(pauseLive(p)) reply({active:false});
    else { enqueue(resumeIfDue); reply({active:true,gated:true}); }
    return;
   }
   const host=new URL(sender.url!).hostname.replace(/\.$/,'');
   const applies=p && (host===p.host || (p.subdomains && host.endsWith(`.${p.host}`)));
   const g=grants.get(sender.tab!.id!);
   reply({active:Boolean(applies),expires:g?.expires,gated:Boolean(applies && (!g || g.resource!==input.resource || g.resource!==sender.url || g.version!==p.version || Date.now()>=g.expires))});
  }).catch(()=>reply({active:true,gated:true})); return true;
 }
 if (sender.url !== chrome.runtime.getURL('blocking.html')) return;
 if(input.type==='purpose-cancel'){
  cancelPurpose();enqueue(async()=>{for(const [id,g] of grants)if(g.kind==='jev')await revoke(id);});reply({ok:true});return;
 }
 if(input.type==='resource-jev'){
  void reviewWithJev(input).then(()=>reply({ok:true,mode:'jev'})).catch(error=>reply({ok:false,error:error instanceof Error?error.message:'Jev unavailable; resource remains blocked.'}));return true;
 }
 if (!['site-block','site-remove','site-pause','site-resume','resource-review','blocking-status'].includes(input.type ?? '')) return;
 mutation = mutation.then(async () => {
  await ensureReady();
  if(input.type==='blocking-status') {
   if(!(await chrome.storage.local.get('sitePolicy')).sitePolicy) await recoverPolicy();
   // A failed expiry that left a durable pending journal is reported as that
   // state; any other failure (e.g. an overdue committed pause) stays an error.
   let expiry:unknown;
   await resumeIfDue().catch(error=>{expiry=error??Error('Pause expiry failed');});
   const snapshot=await statusSnapshot();
   if(expiry!==undefined && snapshot.state!=='pending') throw expiry;
   reply({ok:true,...snapshot}); return;
  }
  const stored = await chrome.storage.local.get(['sitePolicy', 'sitePolicyRevision']);
  if(input.type==='resource-review') {
   const p=stored.sitePolicy;
   if(!p || p.pending || p.version!==input.version || !Number.isInteger(input.tabId)) throw new Error('Stale policy or missing target tab.');
   if(p.pausedUntil!==undefined) throw new Error('Blocking is paused; no resource exception is needed or recorded.');
   if(!p.purpose) throw new Error('Choose an allowed purpose before reviewing a resource.');
   const url=new URL(input.resource ?? '');
   if(url.hostname!==p.host && !(p.subdomains && url.hostname.endsWith(`.${p.host}`))) throw new Error('Resource outside blocked host.');
   if(input.override!==true) throw new Error('Unverified local suggestion: explicit user override required.');
   const tab=await chrome.tabs.get(input.tabId!);
   if(tab.incognito) throw new Error('Private tabs unsupported.');
   const requestedAt=Date.now();
   const expires=requestedAt+Math.min(300,Math.max(1,input.seconds ?? 60))*1000;
   const result=await admitResource({policy:p,resource:url.href,requestedAt,expires},()=>p,Date.now,async()=> 'allow');
   const current=(await chrome.storage.local.get('sitePolicy')).sitePolicy;
   if(!result.grant || current?.pending || current?.version!==p.version || current?.purpose!==p.purpose) throw new Error(`Gated: ${result.reason}`);
   const latestTab=await chrome.tabs.get(input.tabId!);
   if(latestTab.url!==tab.url || latestTab.pendingUrl!==tab.pendingUrl) throw new Error('Navigation changed during review.');
   await installResourceGrant(p,input.tabId!,tab,url.href,expires);
   reply({ok:true}); return;
  }
  if (input.type === 'site-remove') {
   await journal(stored,()=>null);
   reply({ok:true}); return;
  }
  if(input.type==='site-pause' || input.type==='site-resume') {
   const p=stored.sitePolicy;
   if(!p) throw new Error('No site policy to pause or resume.');
   if(p.pending) throw new Error('Policy change incomplete; retry the policy or Remove before pausing or resuming.');
   // Compare-and-set on the committed policy version; the reply carries current state.
   if(input.version!==p.version) { reply({ok:false,error:'Policy changed elsewhere; nothing was changed.',...await statusSnapshot()}); return; }
   if(input.type==='site-resume') {
    // Resuming an active policy is an idempotent no-op, not a new revision.
    if(p.pausedUntil!==undefined) await journal(stored,version=>({...withoutPause(p),version}));
    reply({ok:true,...await statusSnapshot()}); return;
   }
   if(!pauseSupported()) throw new Error('Pause unsupported: no browser-owned expiry is available; blocking unchanged.');
   if(p.pausedUntil!==undefined) throw new Error('Already paused; resume first. A pause is never extended silently.');
   const seconds=input.seconds;
   if(!Number.isInteger(seconds) || seconds!<PAUSE_MIN_SECONDS || seconds!>PAUSE_MAX_SECONDS) throw new Error(`Pause must be ${PAUSE_MIN_SECONDS}–${PAUSE_MAX_SECONDS} whole seconds.`);
   // Optional earned-leisure lease (core/blocking/earned-time.ts): same bounds and
   // compare-and-set; its deadline only shortens the pause and is journaled for readback.
   const lease=input.lease;
   if(lease!==undefined && (typeof lease!=='object' || lease===null || typeof lease.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(lease.id) || lease.host!==p.host || !Number.isSafeInteger(lease.until) || (lease.until as number)<=Date.now())) throw new Error('Earned leisure lease expired or does not match this policy; blocking unchanged.');
   const pausedUntil=Math.min(Date.now()+seconds!*1000,lease ? lease.until as number : Infinity);
   // Arm expiry before the journal: a refused alarm leaves enforcement untouched,
   // and an orphan wakeup only rereads the current policy.
   await chrome.alarms.create(PAUSE_ALARM,{when:pausedUntil});
   await journal(stored,version=>({...withoutPause(p),version,pausedUntil,...(lease ? {earnedLease:lease.id as string} : {})}));
   reply({ok:true,...await statusSnapshot()}); return;
  }
  const host = input.host?.trim().toLowerCase().replace(/\.$/,'') ?? '';
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) || host.length > 253) throw new Error('Enter a hostname, not a URL.');
  const subdomains = input.subdomains === true;
  const origins = [host,`${host}.`].flatMap(h=>[`http://${subdomains ? '*.' : ''}${h}/*`, `https://${subdomains ? '*.' : ''}${h}/*`]);
  if (!await chrome.permissions.contains({origins})) throw new Error('Site permission required.');
  const purpose=(input.purpose ?? '').trim();
  if(purpose.length>120) throw new Error('Purpose must be at most 120 characters.');
  // A new block replaces the policy and so also ends any pause.
  await journal(stored,version=>({host, subdomains, purpose, version}));
  reply({ok:true});
 }).catch(error => reply({ok:false, error:error instanceof Error ? error.message : 'Control failed'}));
 return true;
});
