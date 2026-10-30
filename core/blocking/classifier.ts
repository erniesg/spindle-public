import type {BudgetAccount} from '../models/provider.js';
import {buildJevComparison,parseJevComparison,type JevComparison} from './jev.js';
import {preparePurpose,fencePurpose,type PurposeIdentity,type PurposeReply,type PurposeScope,type PurposeVerdict} from './purpose.js';

// The existing pinned System One classifier, not an application URL fetcher.
export const JEV_ENDPOINT='https://api.typesafe.ai/v1/systemone';
export const JEV_INPUT_USD_PER_MILLION=.042;
// Integer nano-USD arithmetic avoids a floating-point extra reservation unit.
export const JEV_RESERVE_USD=(2*65536*42)/1_000_000_000;
export const JEV_HOST_TIMEOUT_MS=1400;
export interface PurposeAdmission {
 scope:PurposeScope;
 // Authenticated profile/account, processing grant and source/policy snapshot.
 // A browser expectation or model response must never supply this callback.
 current:()=>PurposeIdentity|undefined;
 signal?:AbortSignal;
}
const ids=['requestId','resource','purpose','policyVersion','modelRevision','consentRevision','evidenceId'] as const;

/** Eligibility belongs to application policy, not a model's permission claim.
 * Confidence is not probability of correctness. Require agreement of all three
 * predeclared semantic signals; inadequate/mixed evidence cannot unlock a URL.
 */
export function jevPurposeVerdict(result:JevComparison):PurposeVerdict {
 if(result.choice.label==='relevant'&&result.choice.probabilities.relevant>=.9&&result.choice.confidence>=.8
  &&result.score.value>=3&&result.score.confidence>=.8&&result.noul.probability>=.9)
  return {verdict:'allow',reason:'classified'};
 if(result.choice.label==='unrelated'&&result.choice.probabilities.unrelated>=.9&&result.choice.confidence>=.8
  &&result.score.value<=1&&result.noul.probability<=.1)return {verdict:'deny',reason:'classified'};
 return {verdict:'unknown',reason:'uncertain'};
}
function wait<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
 if(signal.aborted)return Promise.reject(new Error('cancelled'));
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(new Error('cancelled'));
  signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
async function responseJson(response:Response,signal:AbortSignal):Promise<unknown> {
 if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw new Error('unavailable');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try {
  while(true){const item=await wait(reader.read(),signal);if(item.done)break;
   bytes+=item.value.byteLength;if(bytes>65536)throw new Error('response bound');chunks.push(item.value);}
  const body=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
 } catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
}

/** One purpose-only slot, independent of capture/timer/revoke. No retries, raw
 * evidence persistence, enrollment lookup or automatic credential discovery.
 * Caller owns an explicitly selected cumulative budget and host-only key.
 */
export class PurposeClassifier {
 #busy=false;
 constructor(private budget:BudgetAccount,private credential:()=>Promise<string>,
  private transport:typeof fetch=fetch,private now:()=>number=()=>performance.now(),private maximumCalls=100){
  if(!Number.isSafeInteger(maximumCalls)||maximumCalls<1||maximumCalls>100)throw Error('INVALID_PURPOSE_CALL_LIMIT');
 }
 async classify(raw:unknown,admission:PurposeAdmission):Promise<PurposeReply|undefined> {
  // Busy/denied work must not read keys, reserve funds or enter a provider queue.
  if(this.#busy||admission.signal?.aborted)return;
  const ticket=preparePurpose(raw,admission.scope,this.now());
  if(!ticket)return;
  const identity=Object.fromEntries(ids.map(key=>[key,ticket.input[key]])) as unknown as PurposeIdentity;
  const reply=(verdict:PurposeVerdict):PurposeReply=>({...identity,...verdict,authority:'none'});
  const body=buildJevComparison(ticket);if(!body)return;
  const deadline=new AbortController();
  const signal=admission.signal?AbortSignal.any([deadline.signal,admission.signal]):deadline.signal;
  const expires=Math.min(ticket.deadline,ticket.startedAt+JEV_HOST_TIMEOUT_MS);
  const current=()=>{const value=admission.current();return value&&ids.every(key=>value[key]===ticket.input[key])?value:undefined;};
  const invalid=():PurposeVerdict|undefined=>{
   if(admission.signal?.aborted)return {verdict:'unknown',reason:'cancelled'};
   const instant=this.now();if(signal.aborted||!Number.isFinite(instant)||instant<ticket.startedAt||instant>=expires)return {verdict:'unknown',reason:'timeout'};
   if(!current())return {verdict:'unknown',reason:'stale'};
  };
  const initial=invalid();if(initial)return reply(initial);
  this.#busy=true;
  const timer=setTimeout(()=>deadline.abort(),JEV_HOST_TIMEOUT_MS);
  let reserved=false;
  try {
   // Count the operator-selected cumulative journal, not a restart-local counter.
   const budget=this.budget.snapshot();
   const remainingNanoUsd=Math.floor(budget.limitUsd*1e9)-Math.round(budget.accountedUsd*1e9);
   if(budget.exhausted||budget.calls>=this.maximumCalls||!Number.isSafeInteger(remainingNanoUsd)
    ||remainingNanoUsd<Math.ceil(JEV_RESERVE_USD*1e9))return reply({verdict:'unknown',reason:'budget-denied'});
   const key=await wait(this.credential(),signal);
   if(!key||key.length>8192||/[\r\n]/.test(key))return reply({verdict:'unknown',reason:'unavailable'});
   const before=invalid();if(before)return reply(before);
   let reservation:number;
   try{reservation=this.budget.reserve(JEV_RESERVE_USD,this.maximumCalls);reserved=true;}
   catch{return reply({verdict:'unknown',reason:'budget-denied'});}
   // Durable budget writes can block the event loop; timers alone are not a deadline.
   const dispatch=invalid();if(dispatch)return reply(dispatch);
   const response=await wait(this.transport(JEV_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal,redirect:'error',credentials:'omit',cache:'no-store'}),signal);
   const parsed=parseJevComparison(await responseJson(response,signal));
   if(!parsed)return reply({verdict:'unknown',reason:'malformed'});
   // Account valid usage before rejecting an otherwise late/stale result.
   this.budget.settle(reservation,(parsed.usage.inputTokens*42)/1_000_000_000);
   const late=invalid();if(late)return reply(late);
   const result=reply(jevPurposeVerdict(parsed));
   return reply(fencePurpose(ticket,result,current(),this.now(),signal));
  }catch{
   // A dispatched/unknown call retains its full reservation. Never retry or
   // clear a cumulative journal merely because the provider did not answer.
   return reply(invalid()??{verdict:'unknown',reason:reserved?'unavailable':'not-authorised'});
  }finally{clearTimeout(timer);this.#busy=false;}
 }
}
