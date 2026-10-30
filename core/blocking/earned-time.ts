import type {SessionReport} from '../tracking/session.js';
// Study -> earned leisure ledger. Pure, browser-safe (type-only imports), no
// clock, store, timer or network of its own. The caller injects server `now`
// and persists the returned state as one optional field of the existing
// account record inside its own FIFO transaction. Enforcement stays with the
// existing sitePolicy pause in browser-extension/blocking/worker.ts.
//
// Authority is user-owned observed history only: a projected visit (from
// projectSession, owner = account) whose label is the user's own exact
// correction or rule (`override`/`rule`) to category `learning`, and whose
// coverage is `observed` (awake, unlocked, no clock conflict). Model
// inference, confidence, abstention, unknown/partial coverage and focus-timer
// completion never earn. This is self-labelled observed time, not verified
// learning or attention.
export type ProjectedVisit=SessionReport['visits'][number];
export const EARNED_LEISURE_SCHEMA='spindle-earned-leisure/v1' as const;
export const CREDIT_RATIO=1; // leisure seconds per eligible learning second
export const WINDOW_MS=86_400_000; // credits and leases both roll off after 24 h
export const LEASE_MIN_SECONDS=30, LEASE_MAX_SECONDS=1800; // = worker PAUSE_MIN/MAX_SECONDS
const MAX_CREDITS=2048, MAX_LEASES=256;
export interface EarnedCredit {key:string;deviceId:string;evidenceRevision:number;correctionRevision:number;start:number;end:number}
export interface EarnedLease {requestId:string;accountId:string;deviceId:string;host:string;policyVersion:number;seconds:number;issuedAt:number;expiresAt:number}
export type BrowserLease=Pick<EarnedLease,'requestId'|'host'|'policyVersion'|'seconds'|'issuedAt'|'expiresAt'>;
export interface EarnedLeisureState {
 schema:typeof EARNED_LEISURE_SCHEMA;accountId:string;
 optIn:{since:number}|null;credits:EarnedCredit[];leases:EarnedLease[];
}
export interface RedeemRequest {requestId:string;deviceId:string;host:string;policyVersion:number;seconds:number}
export type Eligibility='eligible'|'no-label'|'foreign-owner'|'not-user-labelled'|'not-learning'|'unknown-coverage';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const host=(v:unknown):v is string=>typeof v==='string'&&v.length<=253&&/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v);
const int=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min;
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join()===[...names].sort().join();

export function emptyEarnedLeisure(accountId:string):EarnedLeisureState{
 if(!id(accountId))throw Error('EARNED_ACCOUNT_INVALID');
 return {schema:EARNED_LEISURE_SCHEMA,accountId,optIn:null,credits:[],leases:[]};
}
/** Fail closed on persisted state: an unreadable ledger is refused, never reset
 * (a reset would forget spent leases and so mint credit). */
export function validateEarnedLeisure(value:unknown,accountId:string):EarnedLeisureState{
 const fail=()=>{throw Error('EARNED_STATE_INVALID');};
 if(!obj(value)||!exact(value,['schema','accountId','optIn','credits','leases'])||value.schema!==EARNED_LEISURE_SCHEMA||value.accountId!==accountId||!id(accountId))fail();
 const v=value as Record<string,any>;
 if(v.optIn!==null&&(!obj(v.optIn)||!exact(v.optIn,['since'])||!int(v.optIn.since)))fail();
 if(!Array.isArray(v.credits)||v.credits.length>MAX_CREDITS||!Array.isArray(v.leases)||v.leases.length>MAX_LEASES)fail();
 for(const c of v.credits)if(!obj(c)||!exact(c,['key','deviceId','evidenceRevision','correctionRevision','start','end'])||typeof c.key!=='string'||c.key.length>400||!id(c.deviceId)||!int(c.evidenceRevision)||!int(c.correctionRevision)||!int(c.start)||!int(c.end)||c.end<c.start)fail();
 for(const l of v.leases)if(!obj(l)||!exact(l,['requestId','accountId','deviceId','host','policyVersion','seconds','issuedAt','expiresAt'])||!id(l.requestId)||l.accountId!==accountId||!id(l.deviceId)||!host(l.host)||!int(l.policyVersion,1)||!int(l.seconds,LEASE_MIN_SECONDS)||l.seconds>LEASE_MAX_SECONDS||!int(l.issuedAt)||l.expiresAt!==l.issuedAt+l.seconds*1000)fail();
 return structuredClone(v as EarnedLeisureState);
}
/** Opt-in starts at server `now`: no retroactive credit. Opt-out
 * drops unspent credits; leases stay for idempotent readback and spend. */
export function setEarnedOptIn(state:EarnedLeisureState,enabled:boolean,now:number):EarnedLeisureState{
 if(!int(now))throw Error('EARNED_CLOCK_INVALID');
 if(enabled===(state.optIn!==null))return state;
 return {...structuredClone(state),optIn:enabled?{since:now}:null,credits:[]};
}
export function eligibility(visit:ProjectedVisit,accountId:string):Eligibility{
 const label=visit.label;
 if(!label)return 'no-label';
 if(label.ref.ownerId!==accountId)return 'foreign-owner';
 if(label.source!=='override'&&label.source!=='rule')return 'not-user-labelled';
 if(label.labels.categoryId!=='learning')return 'not-learning';
 if(visit.coverage!=='observed'||!visit.available)return 'unknown-coverage';
 return 'eligible';
}
/** Range the caller passes to projectSession(accountId, entries, labels, from, to). */
export function settlementRange(state:EarnedLeisureState,now:number):{from:number;to:number}|null{
 if(!state.optIn||!int(now))return null;
 const from=Math.max(state.optIn.since,now-WINDOW_MS);
 return from<now?{from,to:now}:null;
}
/** Reconcile credits with one projected page plus its tombstones. Same key is
 * replaced (revisions/replays never add); older evidence revisions are ignored;
 * a now-ineligible or deleted record loses its credit; a visit whose label is no
 * longer observable (context expired) keeps but never gains credit. */
export function settleEarnedCredits(state:EarnedLeisureState,input:{visits:ProjectedVisit[];deletedKeys:string[];now:number}):EarnedLeisureState{
 const range=settlementRange(state,input.now);
 if(!range)return {...structuredClone(state),credits:[]};
 const credits=new Map(state.credits.map(c=>[c.key,c]));
 for(const key of input.deletedKeys)credits.delete(key);
 for(const v of input.visits){
  const old=credits.get(v.key);
  if(old&&old.evidenceRevision>v.evidenceRevision)continue;
  const reason=eligibility(v,state.accountId);
  if(reason==='no-label')continue;
  const start=Math.max(v.start,range.from),end=Math.min(v.end,range.to);
  if(reason!=='eligible'||end<=start||!int(start)||!int(end)){credits.delete(v.key);continue;}
  credits.set(v.key,{key:v.key,deviceId:v.deviceId,evidenceRevision:v.evidenceRevision,correctionRevision:v.correctionRevision,start,end});
 }
 const kept=[...credits.values()].filter(c=>c.end>input.now-WINDOW_MS).sort((a,b)=>a.start-b.start||a.key.localeCompare(b.key)).slice(-MAX_CREDITS);
 return {...structuredClone(state),credits:kept};
}
/** Union of credited intervals (overlap across visits/devices counts once). */
export function earnedBalance(state:EarnedLeisureState,now:number){
 if(!int(now))throw Error('EARNED_CLOCK_INVALID');
 const from=now-WINDOW_MS;let ms=0,cursor=-Infinity;
 if(state.optIn)for(const c of [...state.credits].sort((a,b)=>a.start-b.start)){
  const start=Math.max(c.start,from,cursor),end=Math.min(c.end,now);
  if(end>start)ms+=end-start;
  cursor=Math.max(cursor,end);
 }
 const earnedSeconds=Math.floor(ms/1000)*CREDIT_RATIO;
 const spentSeconds=state.leases.filter(l=>l.issuedAt>from).reduce((sum,l)=>sum+l.seconds,0);
 return {earnedSeconds,spentSeconds,availableSeconds:Math.max(0,earnedSeconds-spentSeconds),
  basis:'self-labelled observed learning time; not verified learning or attention'};
}
/** Atomic, idempotent debit. The same requestId replays the same lease (no
 * second debit); a different body under that ID is a conflict. No refunds. */
export function redeemEarnedLeisure(state:EarnedLeisureState,request:RedeemRequest,now:number):{state:EarnedLeisureState;lease:EarnedLease;replayed:boolean}{
 if(!int(now))throw Error('EARNED_CLOCK_INVALID');
 const r=request;
 if(!obj(r)||!exact(r as unknown as Record<string,unknown>,['requestId','deviceId','host','policyVersion','seconds'])||!id(r.requestId)||!id(r.deviceId)||!host(r.host)||!int(r.policyVersion,1)||!int(r.seconds,LEASE_MIN_SECONDS)||r.seconds>LEASE_MAX_SECONDS)throw Error('EARNED_REQUEST_INVALID');
 const prior=state.leases.find(l=>l.requestId===r.requestId);
 if(prior){
  if(prior.deviceId!==r.deviceId||prior.host!==r.host||prior.policyVersion!==r.policyVersion||prior.seconds!==r.seconds)throw Error('EARNED_REQUEST_CONFLICT');
  return {state,lease:structuredClone(prior),replayed:true};
 }
 if(!state.optIn)throw Error('EARNED_OPT_IN_REQUIRED');
 if(earnedBalance(state,now).availableSeconds<r.seconds)throw Error('EARNED_TIME_INSUFFICIENT');
 const lease:EarnedLease={requestId:r.requestId,accountId:state.accountId,deviceId:r.deviceId,host:r.host,policyVersion:r.policyVersion,seconds:r.seconds,issuedAt:now,expiresAt:now+r.seconds*1000};
 const leases=[...state.leases.filter(l=>l.issuedAt>now-WINDOW_MS),lease];
 if(leases.length>MAX_LEASES)throw Error('EARNED_LEASES_BOUND');
 return {state:{...structuredClone(state),leases},lease:structuredClone(lease),replayed:false};
}
/** The existing `site-pause` message that consumes a lease. The worker clamps
 * the pause to `lease.until`, keeps its 30–1800 s and version compare-and-set. */
export function leasePauseMessage(lease:BrowserLease){
 return {type:'site-pause' as const,version:lease.policyVersion,seconds:lease.seconds,lease:{id:lease.requestId,host:lease.host,until:lease.expiresAt}};
}
/** Readback after an uncertain reply: inspect `blocking-status`, never blindly
 * re-debit. `unapplied` may resend the same message (version CAS keeps it single-use). */
export function leaseStatus(lease:BrowserLease,sitePolicy:unknown,now:number):'applied'|'expired'|'unapplied'|'superseded'|'pending'{
 const p=obj(sitePolicy)?sitePolicy:undefined;
 if(now>=lease.expiresAt)return 'expired';
 if(p?.pending)return 'pending';
 if(p&&p.earnedLease===lease.requestId&&p.host===lease.host&&Number.isSafeInteger(p.pausedUntil)&&now<p.pausedUntil&&p.pausedUntil<=lease.expiresAt)return 'applied';
 if(!p||p.host!==lease.host||p.version!==lease.policyVersion)return 'superseded';
 return 'unapplied';
}
