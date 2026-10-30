import type {EncryptedStore} from '../tracking/store.js';
/** Temporary trusted operator release boundary, never request-supplied eligibility. */
export type PublicPaidAccess={mode:'connection-only'}|{mode:'owned-pilot';accountId:string;scopeId:string}|{mode:'owner';accountId:string;dailyTasks:number};
/** Validate before any listener/store creation; copy so caller mutation cannot open a gate. */
export function validatePublicPaidAccess(value:unknown):PublicPaidAccess|undefined {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('PUBLIC_PAID_ACCESS_INVALID');
 const p=value as Record<string,unknown>,keys=Object.keys(p);
 if(p.mode==='connection-only'&&keys.length===1&&keys[0]==='mode')return Object.freeze({mode:'connection-only'});
 if(p.mode==='owned-pilot'&&keys.length===3&&keys.every(k=>['mode','accountId','scopeId'].includes(k))&&typeof p.accountId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.accountId)&&typeof p.scopeId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.scopeId))return Object.freeze({mode:'owned-pilot',accountId:p.accountId,scopeId:p.scopeId});
 // Owner mode: one named account, a daily task bound (money stays bounded by the budget journal).
 if(p.mode==='owner'&&keys.length===3&&keys.every(k=>['mode','accountId','dailyTasks'].includes(k))&&typeof p.accountId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.accountId)&&Number.isSafeInteger(p.dailyTasks)&&(p.dailyTasks as number)>=1&&(p.dailyTasks as number)<=200)return Object.freeze({mode:'owner',accountId:p.accountId,dailyTasks:p.dailyTasks as number});
 throw Error('PUBLIC_PAID_ACCESS_INVALID');
}
interface PilotReservation {scopeId:string;identity:string;taskId?:string}
/** Unknown daily reservations survive indefinitely; known daily admissions expire after 24h.
 * Pilot history NEVER expires/refunds. At 64 scopes fail closed; never prune history. */
export interface PaidTaskQuota {lastObservedAt:number;admissions:{identity:string;at:number;taskId?:string}[];pilots?:PilotReservation[]}
export interface PaidTaskAdmission {
 <T extends {id:string}>(owner:string,identity:string,create:()=>T):Promise<T>;
 /** Reconcile existing reservations only; pilot continuation requires an already-bound Task. */
 reconcile(owner:string,identity:string,taskId:string):Promise<void>;
}
export class PaidTaskQuotaFailure extends Error {readonly status=429;constructor(){super('PAID_TASK_QUOTA');}}
const refuse=():never=>{throw new PaidTaskQuotaFailure();};
const windowMs=24*60*60*1000;
/** Reserve in the existing encrypted account store BEFORE local Task initialization.
 * The two stores are not atomic: interruption consumes a conservative unknown slot.
 * The initializer must use the stable SQLite event key and must never dispatch I/O.
 */
export function paidTaskAdmission<S extends {accounts:{id:string;paidTasks?:PaidTaskQuota}[]}>(store:EncryptedStore<S>,now=Date.now,access?:PublicPaidAccess):PaidTaskAdmission {
 const policy=validatePublicPaidAccess(access);
 const ownerGate=(owner:string)=>{if(policy&&(policy.mode==='connection-only'||policy.accountId!==owner))refuse();};
 const daily=policy?.mode==='owner'?policy.dailyTasks:2;
 const pilot=(s:S,owner:string,identity:string,taskId?:string)=>{
  ownerGate(owner);if(policy?.mode!=='owned-pilot')return undefined;
  // A scope cannot be reused for a different account, even after operator reconfiguration.
  const matches=s.accounts.flatMap(a=>(a.paidTasks?.pilots??[]).filter(p=>p.scopeId===policy.scopeId).map(p=>({owner:a.id,p})));
  if(matches.length>1||matches.some(m=>m.owner!==owner||m.p.identity!==identity))refuse();
  const entry=matches[0]?.p;
  if(taskId!==undefined&&(!entry?.taskId||entry.taskId!==taskId))refuse();
  return entry;
 };
 const bind=async(owner:string,identity:string,taskId:string,required=false)=>store.transaction(s=>{
  const q=s.accounts.find(a=>a.id===owner)?.paidTasks,entry=q?.admissions.find(a=>a.identity===identity);
  if(!entry){if(required)refuse();return;}
  if(entry.taskId&&entry.taskId!==taskId)refuse();
  if(policy?.mode==='owned-pilot'){
   const p=pilot(s,owner,identity);if(!p||p.taskId&&p.taskId!==taskId)refuse();
   p!.taskId=taskId;
  }
  entry.taskId=taskId;
  // Confirmed aliases refer to one Task. Unknown reservations are not discarded.
  q!.admissions=q!.admissions.filter(a=>a===entry||a.taskId!==taskId);
 });
 const admit:PaidTaskAdmission=Object.assign(async<T extends {id:string}>(owner:string,identity:string,create:()=>T)=>{
  ownerGate(owner);if(!identity||identity.length>1024)refuse();
  await store.transaction(s=>{
   const account=s.accounts.find(a=>a.id===owner);if(!account)refuse();
   const at=now(),q=account!.paidTasks??={lastObservedAt:at,admissions:[]};
   if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(q.lastObservedAt)||q.admissions.length>daily)refuse();
   if(policy?.mode==='owned-pilot'&&!pilot(s,owner,identity)){
    const history=q.pilots??=[];if(history.length>=64)refuse();
    history.push({scopeId:policy.scopeId,identity});
   }
   // Retry the exact reserved identity even if its Task-id attachment was interrupted.
   if(q.admissions.some(a=>a.identity===identity)){q.lastObservedAt=Math.max(at,q.lastObservedAt);return;}
   if(at<q.lastObservedAt)refuse();
   q.admissions=q.admissions.filter(a=>!a.taskId||at-a.at<windowMs);
   if(q.admissions.length>=daily)refuse();
   q.lastObservedAt=at;q.admissions.push({identity,at});
  });
  const task=create();
  await bind(owner,identity,task.id,true);
  return task;
 },{
  async reconcile(owner:string,identity:string,taskId:string){
   ownerGate(owner);
   if(policy){
    // Pilot continuation/replay never adopts retained or unbound work. Only the
    // exact admission initializer may finish binding an interrupted reservation.
    await store.transaction(s=>{
     pilot(s,owner,identity,taskId);
     const entry=s.accounts.find(a=>a.id===owner)?.paidTasks?.admissions.find(a=>a.identity===identity);
     if(entry?.taskId&&entry.taskId!==taskId)refuse();
    },false);return;
   }
   const unbound=await store.transaction(s=>{
    const entry=s.accounts.find(a=>a.id===owner)?.paidTasks?.admissions.find(a=>a.identity===identity);
    if(entry?.taskId&&entry.taskId!==taskId)refuse();
    return !!entry&&!entry.taskId;
   },false);
   // No reservation creation, expiry refresh, or charge for absent/pre-feature
   // work. Recheck in the write transaction: another replay may have bound it.
   if(unbound)await bind(owner,identity,taskId);
  }
 });
 return admit;
}
