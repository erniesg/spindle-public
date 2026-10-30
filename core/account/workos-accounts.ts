import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {WorkOSIdentity} from './workos-provider.js';
import type {SpindleWorkOSSession} from './workos-routes.js';

export interface WorkOSAccountBinding {issuer:string;subject:string;clientId:string}
export interface WorkOSAccount {
 id:string;name:string;salt:string;password:string;
 devices:unknown[];entries:unknown[];seq:number;workos?:WorkOSAccountBinding;
}
export interface WorkOSStoredSession {
 account:string;csrf:string;expires:number;device?:string;workosSessionId?:string;
}
/** Structural subset of the existing encrypted state; no second account store. */
export interface WorkOSAccountState {
 accounts:WorkOSAccount[];
 sessions:Record<string,WorkOSStoredSession>;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const reject=(code:string):never=>{throw new Error(code);};

/**
 * Call synchronously inside the existing EncryptedStore transaction after token
 * verification. This adapter accepts no email, password-account name or tokens.
 * All validation and capacity checks precede mutations, including expiry cleanup.
 */
export function issueWorkOSAccountSessions(
 state:WorkOSAccountState,identity:WorkOSIdentity,issuer:string,count:1|2,now=Date.now(),
):SpindleWorkOSSession[] {
 if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+12*3600000)||
    (count!==1&&count!==2)||!identity||
    typeof identity.subject!=='string'||!/^user_[A-Za-z0-9]{1,250}$/.test(identity.subject)||
    typeof identity.sessionId!=='string'||!/^session_[A-Za-z0-9]{1,247}$/.test(identity.sessionId)||
    typeof identity.clientId!=='string'||!/^client_[A-Za-z0-9]{1,248}$/.test(identity.clientId)||
    !Number.isFinite(identity.expiresAt)||identity.expiresAt<=now/1000)
  reject('WORKOS_IDENTITY_INVALID');
 // This is the exact trusted configured issuer passed by the server, with the
 // same strict public WorkOS URL shape used by the provider verifier.
 if(typeof issuer!=='string'||!/^https:\/\/api\.workos\.com\/user_management\/client_[A-Za-z0-9]{1,248}$/.test(issuer))
  reject('WORKOS_ISSUER_INVALID');
 const matches=state.accounts.filter(a=>a.workos?.issuer===issuer&&a.workos.subject===identity.subject);
 if(matches.length>1||matches.some(a=>a.workos!.clientId!==identity.clientId))reject('WORKOS_ACCOUNT_CONFLICT');
 const name='workos.'+hash(JSON.stringify([issuer,identity.subject])).slice(0,32);
 let account=matches[0];
 if(!account&&state.accounts.some(a=>a.name===name))reject('WORKOS_ACCOUNT_CONFLICT');
 if(state.accounts.length>100||!account&&state.accounts.length>=100)reject('WORKOS_ACCOUNT_BOUND');
 const expired:string[]=[];
 for(const [id,session]of Object.entries(state.sessions)){
  if(!Number.isFinite(session.expires))reject('WORKOS_SESSION_INVALID');
  if(session.expires<=now)expired.push(id);
 }
 if(Object.keys(state.sessions).length-expired.length+count>500)reject('WORKOS_SESSION_BOUND');
 const newAccount:WorkOSAccount|undefined=account?undefined:{
  id:randomUUID(),name,salt:token(),password:'',devices:[],entries:[],seq:0,
  workos:{issuer,subject:identity.subject,clientId:identity.clientId},
 };
 account??=newAccount!;
 const issued:SpindleWorkOSSession[]=[];
 const sessions:Record<string,WorkOSStoredSession>={};
 for(let i=0;i<count;i++){
  const sid=token(),csrf=token(),id=hash(sid);
  // A cryptographic collision is extraordinarily unlikely; fail without any
  // state changes rather than replace a still-valid session.
  if(Object.hasOwn(state.sessions,id)||Object.hasOwn(sessions,id)||issued.some(s=>s.csrf===csrf))
   reject('WORKOS_SESSION_COLLISION');
  sessions[id]={account:account.id,csrf,expires:now+12*3600000,workosSessionId:identity.sessionId};
  issued.push({account:{id:account.id,name:account.name},cookie:'spindle_session='+sid,csrf});
 }
 if(newAccount)state.accounts.push(newAccount);
 for(const id of expired)delete state.sessions[id];
 Object.assign(state.sessions,sessions);
 return issued;
}
