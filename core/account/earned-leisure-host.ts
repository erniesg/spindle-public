import {emptyEarnedLeisure,validateEarnedLeisure,setEarnedOptIn,settlementRange,settleEarnedCredits,earnedBalance,redeemEarnedLeisure,type EarnedLeisureState,type RedeemRequest,CREDIT_RATIO,LEASE_MIN_SECONDS,LEASE_MAX_SECONDS} from '../blocking/earned-time.js';
import {projectSession,type LabelState} from '../tracking/session.js';
import type {Entry} from '../tracking/types.js';
interface Account {id:string;entries:Entry[];devices:{id:string}[];labels?:LabelState;earnedLeisure?:EarnedLeisureState}
export class EarnedLeisureFailure extends Error {constructor(readonly status:number,code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new EarnedLeisureFailure(status,code);};
const keys=(data:Record<string,unknown>,expected:string[])=>Object.keys(data).sort().join(',')===[...expected].sort().join(',');
/** Called ONLY inside the existing authenticated account transaction. No network,
 * new store or clock: history projection and lease accounting use the same now. */
export function handleEarnedLeisure(a:Account,sessionDevice:string|undefined,path:string,data:Record<string,unknown>,now=Date.now()):unknown{
 let state:EarnedLeisureState;
 try{state=a.earnedLeisure?validateEarnedLeisure(a.earnedLeisure,a.id):emptyEarnedLeisure(a.id);}catch{ return fail(409,'EARNED_STATE_UNAVAILABLE'); }
 if(path==='/earned-leisure/opt-in'){
  if(!keys(data,['enabled'])||typeof data.enabled!=='boolean')fail(400,'INVALID_EARNED_QUERY');
  state=setEarnedOptIn(state,data.enabled as boolean,now);
 }else if(path==='/earned-leisure/read'){
  if(Object.keys(data).length)fail(400,'INVALID_EARNED_QUERY');
 }else if(path==='/earned-leisure/redeem'){
  if(!keys(data,['requestId','deviceId','host','policyVersion','seconds']))fail(400,'INVALID_EARNED_QUERY');
  if(!a.devices.some(d=>d.id===data.deviceId)||sessionDevice!==undefined&&sessionDevice!==data.deviceId)fail(403,'DEVICE_DENIED');
 }else if(path==='/earned-leisure/status'){
  if(!keys(data,['requestId'])||typeof data.requestId!=='string')fail(400,'INVALID_EARNED_QUERY');
  const lease=state.leases.find(l=>l.requestId===data.requestId);if(!lease)fail(404,'EARNED_LEASE_NOT_FOUND');
  return {lease,expired:lease!.expiresAt<=now};
 }else fail(404,'NOT_FOUND');
 const bounds=settlementRange(state,now);
 if(bounds){
  const deletedKeys=a.entries.filter(e=>e.deleted).map(e=>e.key);
  // Reconcile existing credits before new keys can trigger the ledger's 2048
  // cap. Later revocations must not cause extra eviction of preserved credits.
  const creditedKeys=new Set(state.credits.map(c=>c.key));
  const liveKeys=a.entries.filter(e=>!e.deleted&&e.record).map(e=>e.key).sort((left,right)=>Number(creditedKeys.has(right))-Number(creditedKeys.has(left)));
  // Reconcile tombstones even with no live visits. Keep the ledger local until
  // every page and any redemption succeeds; never publish a partial settlement.
  state=settleEarnedCredits(state,{visits:[],deletedKeys,now});
  // 64 visits imply at most 129 blocks / 8,256 references, safely below both
  // projection bounds even for staggered overlaps. All entries still supply the
  // global clock mappings; only the projected keys are paged. The ledger unions
  // credited intervals across pages/devices, rather than adding page totals.
  for(let offset=0;offset<liveKeys.length;offset+=64){
   const report=projectSession(a.id,a.entries,a.labels??{local:false,corrections:{}},bounds.from,bounds.to,new Set(liveKeys.slice(offset,offset+64)));
   state=settleEarnedCredits(state,{visits:report.visits,deletedKeys:[],now});
  }
 }
 let lease:ReturnType<typeof redeemEarnedLeisure>['lease']|undefined,replayed=false;
 if(path==='/earned-leisure/redeem'){
  try{const result=redeemEarnedLeisure(state,data as unknown as RedeemRequest,now);state=result.state;lease=result.lease;replayed=result.replayed;}
  catch(error){const code=error instanceof Error?error.message:'EARNED_UNAVAILABLE';return fail(code==='EARNED_REQUEST_INVALID'?400:409,code);}
 }
 a.earnedLeisure=state;
 return {configured:true,enabled:state.optIn!==null,balance:earnedBalance(state,now),policy:{ratio:CREDIT_RATIO,windowHours:24,minimumSeconds:LEASE_MIN_SECONDS,maximumSeconds:LEASE_MAX_SECONDS,source:'user-confirmed learning label + observed history; not proof of learning'},...(lease?{lease,replayed}:{})};
}
