import type {TrackingClient,EarnedReply} from '../tracking/client.js';
// Paired-profile access to study -> earned leisure (docs/STUDY_LEISURE.md). The
// ledger stays in the account service; this owner only decides whether the
// currently paired profile may read the balance and spend it through the
// existing authenticated TrackingClient. The grant is in memory only, default
// off, separate from the timer grant, and is retired with the profile, the
// account client or the host. No store, timer, retry, refund or second wallet.
type Run=<T>(operation:()=>Promise<T>)=>Promise<T>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const codes=['EARNED_ACCESS_REQUIRED','EARNED_REQUEST_INVALID','EARNED_BUSY','ACCOUNT_CHANGED','SIGNIN_REQUIRED','PROFILE_REQUIRED','EARNED_DEVICE_DENIED','EARNED_LEASE_NOT_FOUND','EARNED_REDEEM_REFUSED','EARNED_REQUEST_REFUSED','EARNED_RESULT_UNKNOWN','EARNED_RESPONSE_RETIRED','EARNED_GRANT_RETIRED'];
export function earnedCode(error:unknown,fallback='EARNED_RESULT_UNKNOWN'){
 const code=error instanceof Error?error.message:'';
 if(code==='CLIENT_BUSY'||code==='CONTROL_BUSY')return 'EARNED_BUSY';
 return codes.includes(code)?code:fallback;
}
interface Grant {profile:string;client:TrackingClient;account:string;deviceId:string}
export class EarnedControl {
 private grant:Grant|undefined;private epoch=0;private pending=false;private closed=false;
 constructor(private profile:()=>string|undefined,private client:()=>TrackingClient|undefined,private run:Run=operation=>operation()){}
 get accessEnabled(){const g=this.grant;return !this.closed&&!!g&&g.profile===this.profile()&&g.client===this.client();}
 /** Profile, account, sign-out, re-pair and shutdown all land here. */
 revoke(){this.grant=undefined;this.epoch++;}
 close(){this.closed=true;this.revoke();}
 /** Trusted local owner only. Pairing alone never grants account read/debit. */
 async setAccess(enabled:unknown){
  if(typeof enabled!=='boolean')throw Error('EARNED_REQUEST_INVALID');
  this.revoke();if(!enabled||this.closed)return {enabled:false};
  const profile=this.profile(),client=this.client();
  if(!profile)throw Error('PROFILE_REQUIRED');if(!client)throw Error('SIGNIN_REQUIRED');
  const epoch=this.epoch,identity=await client.inspect();
  if(this.closed||epoch!==this.epoch||profile!==this.profile()||client!==this.client())throw Error('EARNED_GRANT_RETIRED');
  if(!identity.account||!identity.deviceId)throw Error('SIGNIN_REQUIRED');
  this.grant={profile,client,account:identity.accountId??identity.account,deviceId:identity.deviceId};
  return {enabled:true};
 }
 /** Trusted local owner: read the balance or set this account's own opt-in. */
 async local(action:'read'|'opt-in',data:Record<string,unknown>={}):Promise<EarnedReply>{
  const client=this.client();if(this.closed||!client)throw Error('SIGNIN_REQUIRED');
  if(this.pending)throw Error('EARNED_BUSY');this.pending=true;
  try{const reply=await this.run(()=>client.earnedLeisure(action,data));if(this.closed||client!==this.client())throw Error('ACCOUNT_CHANGED');return reply;}
  finally{this.pending=false;}
 }
 /** Paired extension: read, redeem (own device forced by the client) or status of one request. */
 async extension(value:unknown,profile:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const grant=this.grant;
  if(this.closed||typeof profile!=='string'||!grant||profile!==grant.profile||profile!==this.profile()||grant.client!==this.client())return {ok:false,code:'EARNED_ACCESS_REQUIRED'};
  if(!object(value)||typeof value.action!=='string'||!['read','redeem','status'].includes(value.action))return {ok:false,code:'EARNED_REQUEST_INVALID'};
  if(this.pending)return {ok:false,code:'EARNED_BUSY'};
  const {action,...data}=value,epoch=this.epoch;this.pending=true;
  // A late reply never resurrects a retired grant, profile or account.
  const current=()=>!this.closed&&!signal?.aborted&&epoch===this.epoch&&this.grant===grant&&this.profile()===profile&&this.client()===grant.client;
  try{
   const reply=await this.run(async()=>{
    const identity=await grant.client.inspect();
    if(!current())throw Error('EARNED_RESPONSE_RETIRED');
    if((identity.accountId??identity.account)!==grant.account||identity.deviceId!==grant.deviceId)throw Error('ACCOUNT_CHANGED');
    return grant.client.earnedLeisure(action as 'read'|'redeem'|'status',data);
   });
   if(!current())return {ok:false,code:'EARNED_RESPONSE_RETIRED'};
   return {ok:true,value:reply};
  }catch(error){return {ok:false,code:earnedCode(error,action==='redeem'?'EARNED_RESULT_UNKNOWN':'EARNED_REQUEST_REFUSED')};}
  finally{this.pending=false;}
 }
}
