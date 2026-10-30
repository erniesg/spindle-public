import {leasePauseMessage,leaseStatus,type BrowserLease as EarnedLease} from '../../core/blocking/earned-time.js';
// Study -> earned leisure on the blocking page (docs/STUDY_LEISURE.md). The
// balance and debit live in the account service behind the local app's
// authenticated native bridge; enforcement is ONLY the existing site-pause with
// its lease. This page keeps no timer, store, wallet, retry or refund: an
// uncertain reply is read back for the same request and never debited again.
export type EarnedWire={ok:boolean;value?:unknown;code?:string};
export interface EarnedDeps {
 native:(data:Record<string,unknown>)=>Promise<EarnedWire>;
 send:(message:Record<string,unknown>)=>Promise<unknown>;
 now:()=>number;
}
export type RedeemOutcome=
 |{state:'applied';lease:EarnedLease;pausedUntil:number}
 |{state:'refused';code:string}
 |{state:'unknown';requestId:string;lease?:EarnedLease}
 |{state:'unapplied'|'superseded'|'expired';lease:EarnedLease;error?:string};
// Refusals that the account/bridge returns before any debit.
const definitive=['EARNED_ACCESS_REQUIRED','EARNED_REQUEST_INVALID','EARNED_BUSY','ACCOUNT_CHANGED','SIGNIN_REQUIRED','PROFILE_REQUIRED','EARNED_DEVICE_DENIED','EARNED_REDEEM_REFUSED','EARNED_REQUEST_REFUSED'];
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function leaseOf(value:unknown,requestId:string):EarnedLease|undefined{
 const l=object(value)&&object(value.lease)?value.lease:undefined;
 if(!l||l.requestId!==requestId||typeof l.host!=='string'||!Number.isSafeInteger(l.policyVersion)||!Number.isSafeInteger(l.seconds)||!Number.isSafeInteger(l.expiresAt)||l.expiresAt!==l.issuedAt+l.seconds*1000)return;
 return l as EarnedLease;
}
async function policy(deps:EarnedDeps){
 const status=await deps.send({type:'blocking-status'}).catch(()=>undefined);
 return object(status)&&status.ok===true?status:undefined;
}
/** Apply a canonical lease through the existing worker, then trust only readback. */
export async function deliverLease(deps:EarnedDeps,lease:EarnedLease):Promise<RedeemOutcome>{
 const before=await policy(deps);if(!before)return {state:'unknown',requestId:lease.requestId,lease};
 const first=leaseStatus(lease,before.sitePolicy,deps.now());
 if(first==='pending')return {state:'unknown',requestId:lease.requestId,lease};
 if(first==='applied')return {state:'applied',lease,pausedUntil:before.sitePolicy.pausedUntil};
 if(first!=='unapplied')return {state:first,lease};
 const result=await deps.send(leasePauseMessage(lease)).catch(()=>undefined);
 const after=await policy(deps);if(!after)return {state:'unknown',requestId:lease.requestId,lease};
 const final=leaseStatus(lease,after.sitePolicy,deps.now());
 if(final==='pending')return {state:'unknown',requestId:lease.requestId,lease};
 if(final==='applied')return {state:'applied',lease,pausedUntil:after.sitePolicy.pausedUntil};
 return {state:final,lease,...(object(result)&&typeof result.error==='string'?{error:result.error.slice(0,200)}:{})};
}
/** Read back one request after an uncertain reply. Not found = never debited. */
export async function checkRequest(deps:EarnedDeps,requestId:string):Promise<RedeemOutcome>{
 const status=await deps.native({action:'status',requestId});
 if(!status.ok)return status.code==='EARNED_LEASE_NOT_FOUND'?{state:'refused',code:'EARNED_NOT_DEBITED'}:{state:'unknown',requestId};
 const lease=leaseOf(status.value,requestId);
 return lease?deliverLease(deps,lease):{state:'unknown',requestId};
}
export async function redeemEarned(deps:EarnedDeps,current:{host:string;version:number},seconds:number,requestId:string):Promise<RedeemOutcome>{
 const reply=await deps.native({action:'redeem',requestId,host:current.host,policyVersion:current.version,seconds});
 if(!reply.ok)return definitive.includes(reply.code??'')?{state:'refused',code:reply.code!}:checkRequest(deps,requestId);
 const lease=leaseOf(reply.value,requestId);
 if(!lease||lease.host!==current.host||lease.policyVersion!==current.version||lease.seconds!==seconds)return checkRequest(deps,requestId);
 return deliverLease(deps,lease);
}
/** One native request on its own short-lived port to the paired local app. */
export function earnedNative(data:Record<string,unknown>,timeoutMs=13000):Promise<EarnedWire>{
 return new Promise(resolve=>{void(async()=>{
  const {profileToken}=await chrome.storage.local.get('profileToken');
  if(typeof profileToken!=='string'||!profileToken){resolve({ok:false,code:'EARNED_ACCESS_REQUIRED'});return;}
  const port=chrome.runtime.connectNative('ai.berlayar.spindle.preview'),id=Math.floor(Math.random()*999999)+1;let done=false;
  const finish=(value:EarnedWire)=>{if(done)return;done=true;clearTimeout(timer);try{port.disconnect();}catch{/* Already closed. */}resolve(value);};
  const timer=setTimeout(()=>finish({ok:false,code:'EARNED_RESULT_UNKNOWN'}),timeoutMs);
  port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;finish({ok:false,code:'EARNED_BRIDGE_UNAVAILABLE'});});
  port.onMessage.addListener((m:unknown)=>{if(!object(m)||m.id!==id)return;finish(m.ok===true?{ok:true,value:m.value}:{ok:false,code:typeof m.code==='string'?m.code:'EARNED_BRIDGE_UNAVAILABLE'});});
  port.postMessage({schema:'spindle-browser-preview/v1',id,kind:'earned',profileToken,data});
 })().catch(()=>resolve({ok:false,code:'EARNED_BRIDGE_UNAVAILABLE'}));});
}
const minutes=(s:number)=>s>=60?`${Math.floor(s/60)} min${s%60?` ${s%60} s`:''}`:`${s} s`;
const messages:Record<string,string>={
 EARNED_ACCESS_REQUIRED:'Not allowed yet. In Spindle on your computer, pair this profile and turn on “Let this paired Chrome profile use earned leisure”.',
 EARNED_BRIDGE_UNAVAILABLE:'Spindle on your computer is not reachable. Open it, sign in, then retry.',
 EARNED_BUSY:'Spindle is busy with another account action. Nothing was spent; retry in a moment.',
 SIGNIN_REQUIRED:'Sign in to your Spindle account on your computer first. Nothing was spent.',
 ACCOUNT_CHANGED:'The signed-in account or pairing changed. Nothing was spent; re-allow access in Spindle.',
 EARNED_REDEEM_REFUSED:'Not spent: earned leisure is off, the balance is too low, or the request conflicted. Balance re-read.',
 EARNED_NOT_DEBITED:'The request never reached your account. Nothing was spent.',
};
/** Compact page section. All values come from the account reply and the worker readback. */
export function mountEarned(doc:Document,deps:EarnedDeps={native:earnedNative,send:message=>chrome.runtime.sendMessage(message),now:Date.now}){
 const $=<T extends HTMLElement>(id:string)=>doc.getElementById(id) as T;
 const balance=$('earned-balance'),rule=$('earned-rule'),seconds=$<HTMLInputElement>('earned-seconds'),use=$<HTMLButtonElement>('earned-use'),check=$<HTMLButtonElement>('earned-check'),status=$('earned-status');
 let shown=false,available=0,enabled=false,active:{host:string;version:number}|undefined,pending:{requestId:string;lease?:EarnedLease}|undefined,busy=false,revision=0;
 const say=(state:'idle'|'loading'|'success'|'error',text:string)=>{status.dataset.state=state;status.textContent=text;};
 const draw=()=>{
  const max=Math.min(1800,available);seconds.max=String(Math.max(30,max));if(max>=30&&Number(seconds.value)>max)seconds.value=String(max);
  use.disabled=busy||!!pending||!enabled||!active||max<30;check.hidden=!pending;check.disabled=busy;
 };
 // One read at a time: overlapping refreshes coalesce, and a busy bridge is retried briefly.
 let reading:Promise<void>|undefined,again=false;
 function refresh():Promise<void>{
  if(reading){again=true;return reading;}
  reading=(async()=>{do{again=false;await load();}while(again);})().finally(()=>{reading=undefined;});
  return reading;
 }
 async function load(){
  const mine=++revision;active=undefined;draw();
  let read=await deps.native({action:'read'});
  for(let i=0;i<3&&!read.ok&&read.code==='EARNED_BUSY';i++){await new Promise(r=>setTimeout(r,400));read=await deps.native({action:'read'});}
  const current=await policy(deps);
  if(mine!==revision)return;
  const p=current?.sitePolicy;
  active=current&&current.state==='active'&&current.pause?.supported===true&&p&&!p.pending?{host:p.host,version:p.version}:undefined;
  if(!read.ok||!object(read.value)||!object(read.value.balance)){enabled=false;available=0;balance.textContent='Balance unavailable.';say('error',messages[read.code??'']??`Earned leisure unavailable (${read.code??'unknown'}).`);draw();return;}
  const v=read.value;enabled=v.enabled===true;available=Number(v.balance.availableSeconds)||0;
  rule.textContent=`${v.policy?.ratio??1} s of your own observed learning time earns ${v.policy?.ratio??1} s of leisure, counted over the last ${v.policy?.windowHours??24} h. Only time you labelled “learning” yourself (a correction or saved rule) on observed history counts. It is not proof of learning, and model guesses or finished timers never count. Spend ${v.policy?.minimumSeconds??30}–${v.policy?.maximumSeconds??1800} s as a pause of the current site block.`;
  balance.textContent=enabled?`${minutes(available)} available · ${minutes(v.balance.earnedSeconds)} earned · ${minutes(v.balance.spentSeconds)} spent (24 h)`:'Earned leisure is off for this account. Turn it on in Spindle on your computer.';
  if(!shown&&!busy)say('idle',active?'':'No active, pausable site block. Enable a block above first.');
  draw();
 }
 function show(outcome:RedeemOutcome){
  pending=undefined;shown=true;
  if(outcome.state==='applied')say('success',`Earned pause applied to ${outcome.lease.host} until ${new Date(outcome.pausedUntil).toLocaleTimeString()}. Blocking returns automatically.`);
  else if(outcome.state==='refused')say('error',messages[outcome.code]??`Not spent (${outcome.code}).`);
  else if(outcome.state==='unknown'){pending={requestId:outcome.requestId,...(outcome.lease?{lease:outcome.lease}:{})};say('error','Result unknown. Use “Check result” to read this same request back; it is never spent twice.');}
  else if(outcome.state==='unapplied'){pending={requestId:outcome.lease.requestId,lease:outcome.lease};say('error',`Spent ${minutes(outcome.lease.seconds)} but the pause is not applied yet${outcome.error?`: ${outcome.error}`:''}. “Check result” retries this same lease.`);}
  else say('error',outcome.state==='expired'?'This earned pause has already expired; it is not refunded.':'The site policy changed before this pause applied, so it was not used. Spent time is not refunded.');
 }
 use.addEventListener('click',()=>{
  const value=Number(seconds.value),current=active;
  if(!current||!Number.isInteger(value)||value<30||value>Math.min(1800,available)){say('error',`Choose 30–${Math.min(1800,available)} whole seconds.`);return;}
  busy=true;draw();say('loading','Spending earned leisure…');
  const requestId=crypto.randomUUID();pending={requestId};
  void redeemEarned(deps,current,value,requestId).then(show,()=>show({state:'unknown',requestId})).finally(()=>{busy=false;void refresh();});
 });
 check.addEventListener('click',()=>{
  const request=pending;if(!request)return;busy=true;draw();say('loading','Reading back this request…');
  void (request.lease?deliverLease(deps,request.lease):checkRequest(deps,request.requestId)).then(show,()=>show({state:'unknown',requestId:request.requestId})).finally(()=>{busy=false;void refresh();});
 });
 chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&(changes.sitePolicy||changes.profileToken))void refresh();});
 void refresh();
 return {refresh};
}
