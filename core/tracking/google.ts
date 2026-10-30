import {randomUUID} from 'node:crypto';
import {GoogleOAuth,GoogleOAuthFailure,parseGoogleConnection,scopes,type CredentialStore,type GoogleOperation,type GoogleOAuthCode,type GoogleOAuthStage,type GoogleCallbackReason,type GoogleOAuthBoundary} from '../connectors/google/oauth.js';
import {DriveReader} from '../connectors/google/drive.js';
import {boundedJson} from '../connectors/google/bounded.js';
import type {EncryptedStore} from './store.js';
import type {GoogleTriggerAuthority} from '../connectors/google/trigger-runtime.js';
import type {GoogleOutputReadiness} from '../account/google-client.js';
import {mailSendGrants} from '../connectors/google/outgoing.js';

/** Private encrypted account collection. Never included in account/history/memory projections. */
export interface PrivateGoogleConnection {
 id:string; incarnation:string; identity?:string; credential?:string; roots:string[]; rootRevision:number;
 revocation?:'confirmed'|'uncertain';
 lastAttempt?:GoogleAttempt;
}
interface GoogleState {
 accounts:{id:string;google?:PrivateGoogleConnection[]}[];
 sessions:Record<string,{account:string;expires:number}>;
}
export interface GoogleAttempt {status:'pending'|'failed'|'succeeded'|'disconnected';correlation:string;at:number;expiresAt?:number;code?:GoogleOAuthCode;stage?:GoogleOAuthStage;reason?:GoogleCallbackReason;httpStatus?:number}
export interface GoogleTelemetry {operation:'google_oauth';stage:GoogleOAuthStage;code:GoogleOAuthBoundary['code']|'GOOGLE_CONNECTED'|'GOOGLE_FLOW_EXPIRED_OR_USED'|'GOOGLE_CONTEXT_CHANGED'|'STORE_OR_REQUEST_UNAVAILABLE';status:number;correlation:string;reason?:GoogleCallbackReason}
export interface SharedGoogleConfig {clientId:string;clientSecret:string;http?:typeof fetch;picker?:{appId:string;developerKey:string};telemetry?:(event:GoogleTelemetry)=>void}
/** Supplied only by the trusted host from explicit standing owner configuration, never a model/email/HTTP body. */
export interface BackgroundGoogleAuthorization {ownerId:string;connectionId:string;isCurrent:()=>boolean}
export class GoogleAccountFailure extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new GoogleAccountFailure(status,code);};
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(id);
const outputGrant='https://www.googleapis.com/auth/drive.file';
const composeGrant='https://www.googleapis.com/auth/gmail.compose';
const fullDriveGrant='https://www.googleapis.com/auth/drive';
type Flow=ReturnType<GoogleOAuth['beginRedirect']>;
interface Lease {owner:string;session:string;connection:string;incarnation:string;flow:Flow;used:boolean;expectedIdentity?:string;correlation:string;upgrade?:'output'|'mail';rootRevision?:number;expectedEpoch?:string}

/** Owns no database/crypto/clock. All commits use the existing encrypted serialized transaction. */
export class SharedGoogle<S extends GoogleState> {
 private pending=new Map<string,Lease>();
 private jobs=new Set<Promise<unknown>>();
 private beginTail:Promise<unknown>=Promise.resolve();
 private emit(event:GoogleTelemetry){try{this.config.telemetry?.(event);}catch{/* Diagnostics cannot change authority or a response. */}}
 private closing=false;
 private http:typeof fetch;
 constructor(private store:EncryptedStore<S>,private config:SharedGoogleConfig,private origin:()=>string){
  if(typeof config.clientId!=='string'||!config.clientId||config.clientId.length>2048||typeof config.clientSecret!=='string'||!config.clientSecret||config.clientSecret.length>8192)throw Error('GOOGLE_WEB_CONFIG_REQUIRED');
  this.http=config.http??fetch;
 }
 private session(s:S,owner:string,session:string){
  const current=s.sessions[session];if(this.closing||!current||current.account!==owner||current.expires<=Date.now())fail(401,'GOOGLE_AUTH_CONTEXT_CHANGED');
 }
 private row(s:S,owner:string,id:string){
  const a=s.accounts.find(a=>a.id===owner),row=a?.google?.find(c=>c.id===id);
  if(!row)fail(404,'GOOGLE_CONNECTION_NOT_FOUND');return row!;
 }
 private current(s:S,owner:string,session:string,id:string,incarnation?:string){
  this.session(s,owner,session);const row=this.row(s,owner,id);
  if(incarnation!==undefined&&row.incarnation!==incarnation)fail(409,'GOOGLE_CONNECTION_CHANGED');return row;
 }
 private checkLease(s:S,lease:Lease){
  if(this.pending.get(lease.flow.state)!==lease||Date.now()>=lease.flow.expiresAt)fail(409,'GOOGLE_FLOW_EXPIRED');
  const c=this.current(s,lease.owner,lease.session,lease.connection,lease.incarnation);
  if(lease.rootRevision!==undefined&&c.rootRevision!==lease.rootRevision)fail(409,'GOOGLE_ROOT_CHANGED');
  if(lease.expectedEpoch!==undefined&&parseGoogleConnection(c.credential)?.connectionEpoch!==lease.expectedEpoch)fail(409,'GOOGLE_CONNECTION_CHANGED');
  return c;
 }
 private credentials(owner:string,session:string,id:string,incarnation:string,lease?:Lease):CredentialStore {
  return this.credentialAdapter(id,s=>lease?this.checkLease(s,lease):this.current(s,owner,session,id,incarnation),lease?c=>{c.lastAttempt={status:'succeeded',correlation:lease.correlation,at:Date.now()};}:undefined,lease?.upgrade==='mail');
 }
 /** One protected CAS implementation for session and explicitly authorized background owners. */
 private credentialAdapter(id:string,row:(state:S)=>PrivateGoogleConnection,onSet?:(connection:PrivateGoogleConnection)=>void,retainPriorGrants=false):CredentialStore {
  return {
   get:async requested=>{if(requested!==id)fail(404,'GOOGLE_CONNECTION_NOT_FOUND');return this.store.transaction(s=>row(s).credential,false);},
   // No unconditional write or delete: absence is not creation authority.
   set:async()=>{fail(409,'GOOGLE_CAS_REQUIRED');},delete:async()=>{fail(409,'GOOGLE_CAS_REQUIRED');},
   compareAndSet:async(requested,expected,value,options?:GoogleOperation)=>{
    if(requested!==id)fail(404,'GOOGLE_CONNECTION_NOT_FOUND');
    return this.store.transaction(s=>{
     options?.signal?.throwIfAborted();const c=row(s);
     if(c.credential!==expected)return false;
     const parsed=parseGoogleConnection(value);if(!parsed)fail(409,'GOOGLE_CREDENTIAL_REQUIRED');
     if(c.identity&&c.identity!==parsed!.accountId)fail(409,'GOOGLE_IDENTITY_CHANGED');
     // A concurrent readonly refresh may have recorded additional real grants since begin.
     if(retainPriorGrants&&parseGoogleConnection(c.credential)?.grants.some(g=>!parsed!.grants.includes(g)))throw new GoogleOAuthFailure(403,'GOOGLE_MAIL_GRANT_REQUIRED','credential');
     c.credential=value;c.identity=parsed!.accountId;delete c.revocation;
     onSet?.(c);return true;
    });
   },
   compareAndDelete:async(requested,expected)=>this.store.transaction(s=>{if(requested!==id)return false;const c=row(s);if(c.credential!==expected)return false;delete c.credential;c.incarnation=randomUUID();return true;})
  };
 }
 private oauth(store:CredentialStore,http=this.http){return new GoogleOAuth(this.config.clientId,store,http,{clientSecret:this.config.clientSecret});}
 private pickerConfiguration(){
  const picker=this.config.picker;
  return picker&&/^\d{1,32}$/.test(picker.appId)&&/^[A-Za-z0-9_-]{20,256}$/.test(picker.developerKey)?picker:undefined;
 }
 private outputReadiness(grants:readonly string[]):GoogleOutputReadiness {
  const full=grants.includes(fullDriveGrant),pickerConfigured=full||!!this.pickerConfiguration(),grantPresent=full||grants.includes(outputGrant);
  return {pickerConfigured,grantPresent,...(!pickerConfigured?{blocker:'GOOGLE_PICKER_CONFIGURATION_REQUIRED' as const}:!grantPresent?{blocker:'GOOGLE_OUTPUT_GRANT_REQUIRED' as const}:{})};
 }
 private async assertOutputGrant(owner:string,session:string,id:string,binding:{incarnation:string;rootRevision:number;rootId:string;connectionEpoch:string}){
  await this.store.transaction(s=>{
   const c=this.current(s,owner,session,id,binding.incarnation),parsed=parseGoogleConnection(c.credential);
   if(c.rootRevision!==binding.rootRevision||!c.roots.includes(binding.rootId)||parsed?.connectionEpoch!==binding.connectionEpoch)fail(409,'GOOGLE_ROOT_CHANGED');
   if(!parsed?.grants.includes(outputGrant))fail(403,'GOOGLE_OUTPUT_GRANT_REQUIRED');
  },false);
 }
 private project(c:PrivateGoogleConnection){
  const parsed=parseGoogleConnection(c.credential),grants=parsed?.grants??[];
  let lastAttempt=c.lastAttempt;
  const activeLease=[...this.pending.values()].some(l=>l.connection===c.id&&l.incarnation===c.incarnation&&l.flow.expiresAt>Date.now());
  if(lastAttempt?.status==='pending'&&!activeLease)lastAttempt={status:'failed',correlation:lastAttempt.correlation,at:lastAttempt.at,code:'GOOGLE_FLOW_EXPIRED_OR_USED',stage:'callback',httpStatus:409};
  // Legacy rows have no attempt history. Project inactivity without inventing a provider cause or writing a migration.
  const recovery=!parsed&&!c.identity&&!c.revocation&&!lastAttempt&&!activeLease?'no_active_authorization':undefined;
  return {id:c.id,...(c.identity?{accountId:c.identity}:{}),status:parsed?'connected':c.identity||c.revocation||lastAttempt?.status==='failed'||recovery?'disconnected':'pending',grants,missingGrants:[scopes.mail,scopes.drive,composeGrant,fullDriveGrant].filter(s=>!grants.includes(s)),roots:[...c.roots],rootRevision:c.rootRevision,outputReadiness:this.outputReadiness(grants),mailReadiness:{canDraft:[mailSendGrants.compose,mailSendGrants.modify,mailSendGrants.full].some(g=>grants.includes(g)),canSend:Object.values(mailSendGrants).some(g=>grants.includes(g)),requiresExactOwnerReview:true},...(c.revocation?{revocation:c.revocation}:{}),...(lastAttempt?{lastAttempt}:{}),...(recovery?{recovery}:{})};
 }
 private prune(){for(const [state,lease] of this.pending)if(Date.now()>=lease.flow.expiresAt)this.pending.delete(state);}
 async handle(owner:string,session:string,path:string,data:Record<string,unknown>):Promise<unknown> {
  if(this.closing)fail(503,'GOOGLE_STOPPING');
  // Workspace labels are not membership. This backend currently exposes account-private use only.
  const fields:Record<string,string[]>={
   '/google/list':[], '/google/begin':['connectionId'], '/google/output/begin':['connectionId'], '/google/mail/begin':['connectionId'], '/google/roots':['connectionId','roots'], '/google/disconnect':['connectionId'],
   '/google/output/picker':['connectionId','rootId'], '/google/output/parent':['connectionId','rootId'],
   '/google/drive/check':['connectionId','rootId'], '/google/drive/list':['connectionId','rootId','folder','page'], '/google/drive/read':['connectionId','rootId','fileId']
  };
  const allowed=fields[path];if(!allowed)fail(404,'NOT_FOUND');
  if(Object.keys(data).some(k=>!allowed.includes(k)))fail(400,'INVALID_GOOGLE_FIELDS');
  if(path==='/google/list')return this.store.transaction(s=>{this.session(s,owner,session);return {connections:(s.accounts.find(a=>a.id===owner)?.google??[]).map(c=>this.project(c))};},false);
  if(path==='/google/begin'||path==='/google/output/begin'||path==='/google/mail/begin'){
   if(path!=='/google/begin'&&!validId(data.connectionId))fail(400,'INVALID_CONNECTION_ID');
   const task=this.beginTail.catch(()=>{}).then(()=>this.begin(owner,session,data.connectionId,path==='/google/mail/begin'?'mail':path==='/google/output/begin'?'output':undefined));this.beginTail=task;return task;
  }
  if(!validId(data.connectionId))fail(400,'INVALID_CONNECTION_ID');const id=data.connectionId as string;
  if(path==='/google/roots'){
   if(!Array.isArray(data.roots)||data.roots.length>32||data.roots.some(r=>!validId(r))||new Set(data.roots).size!==data.roots.length)fail(400,'INVALID_GOOGLE_ROOTS');
   return this.store.transaction(s=>{const c=this.current(s,owner,session,id);if(!c.credential)fail(409,'GOOGLE_RECONNECT_REQUIRED');c.roots=[...data.roots as string[]];c.rootRevision++;return this.project(c);});
  }
  if(path==='/google/disconnect')return this.disconnect(owner,session,id);
  if(path==='/google/output/picker'||path==='/google/output/parent'){
   if(!validId(data.rootId))fail(400,'INVALID_GOOGLE_SOURCE');
   const b=await this.preparationBinding(owner,session,id,data.rootId as string),picker=this.pickerConfiguration();
   // Authenticate/root-fence first, then configuration BEFORE grant/token access. Status uses the same validation.
   if(path==='/google/output/picker'&&!picker)fail(503,'GOOGLE_PICKER_CONFIGURATION_REQUIRED');
   // Connector reads can race a genuine readonly refresh/CAS reducing drive.file without changing epoch.
   // Normalize only at connector awaits, from one protected context+grant read, never the racy predicate again.
   const protectedAccess=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    try{return await operation();}catch(error){
     if(error instanceof GoogleOAuthFailure){await b.assertCurrent();throw error;}
     await this.assertOutputGrant(owner,session,id,b);throw error;
    }
   };
   await this.assertOutputGrant(owner,session,id,b);
   const access=await protectedAccess(()=>b.oauth.connectorAccess(id,outputGrant));
   const current=async()=>{await b.assertCurrent();await this.assertOutputGrant(owner,session,id,b);await protectedAccess(()=>access.assertCurrent());};
   await current();
   const accessToken=await protectedAccess(()=>access.token());await current();
   if(path==='/google/output/picker'){
    // Deliberate ephemeral capability, only this CSRF-protected RPC after explicit Picker action.
    // Never included in ordinary connection status, task records, telemetry or model tools.
    return {appId:picker!.appId,developerKey:picker!.developerKey,accessToken,rootId:b.rootId,origin:this.origin()};
   }
   const response=await b.http(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(b.rootId)}?fields=id,mimeType,trashed,isAppAuthorized,capabilities(canAddChildren)`,{headers:{Authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(15000)});
   const metadata=await boundedJson(response,65536);await current();
   if(!response.ok||metadata.id!==b.rootId||metadata.mimeType!=='application/vnd.google-apps.folder'||metadata.trashed!==false||metadata.isAppAuthorized!==true||metadata.capabilities?.canAddChildren!==true)fail(403,'GOOGLE_OUTPUT_PARENT_AUTHORIZATION_REQUIRED');
   return {rootId:b.rootId,creationAuthorized:true};
  }
  if(!validId(data.rootId)||!(path==='/google/drive/check'||(path.endsWith('/list')?validId(data.folder):validId(data.fileId)))||(data.page!==undefined&&(typeof data.page!=='string'||data.page.length>4096)))fail(400,'INVALID_GOOGLE_SOURCE');
  const captured=await this.store.transaction(s=>{const c=this.current(s,owner,session,id);if(!c.credential)fail(409,'GOOGLE_RECONNECT_REQUIRED');if(!c.roots.includes(data.rootId as string))fail(403,'GOOGLE_ROOT_DENIED');return {...c};},false);
  const oauth=this.oauth(this.credentials(owner,session,id,captured.incarnation));
  const access=await oauth.connectorAccess(id,scopes.drive);
  const current=async()=>{await access.assertCurrent();await this.store.transaction(s=>{const c=this.current(s,owner,session,id,captured.incarnation);if(c.rootRevision!==captured.rootRevision||!c.roots.includes(data.rootId as string))fail(409,'GOOGLE_ROOT_CHANGED');},false);};
  await current();
  const token=await access.token();await current();
  const scopedHttp:typeof fetch=async(input,init)=>{await current();const response=await this.http(input,init);try{await current();return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}};
  const reader=new DriveReader(token,access.accountId,new Set([data.rootId as string]),scopedHttp,512000);
  const provenance={ownerId:owner,connectionId:id,accountId:access.accountId,connectionEpoch:access.connectionEpoch,rootId:data.rootId,rootRevision:captured.rootRevision};
  if(path==='/google/drive/check'){const metadata=await reader.checkRoot(data.rootId as string);await current();return {...metadata,provenance};}
  const result=path.endsWith('/list')?await reader.list(data.folder as string,data.page as string|undefined):await reader.read(data.fileId as string);
  await current();
  if('bytes' in result){const {bytes,...source}=result;return {...source,bytesBase64:bytes.toString('base64'),provenance};}
  // Explicit projection; provider bodies/errors are never returned wholesale.
  return {files:result.files.map((f:{id:string;name:string;mimeType:string;version:string})=>({id:f.id,name:f.name,mimeType:f.mimeType,version:f.version})),...(result.nextPageToken?{nextPageToken:result.nextPageToken}:{}),provenance};
 }
 private async begin(owner:string,session:string,existing:unknown,upgrade?:'output'|'mail'){
  if(existing!==undefined&&!validId(existing))fail(400,'INVALID_CONNECTION_ID');
  this.prune();
  const correlation=randomUUID();
  const selected=await this.store.transaction(s=>{
   this.session(s,owner,session);const a=s.accounts.find(a=>a.id===owner)!;
   // Repeated new-connect requests resume the unfinished row, not a new identity per click.
   let c=existing!==undefined?this.row(s,owner,existing as string):a.google?.findLast(c=>!c.identity&&!c.credential&&!c.revocation);
   if(upgrade&&(!c?.identity||!c.credential))fail(409,'GOOGLE_RECONNECT_REQUIRED');
   if(c){const lease=[...this.pending.values()].find(l=>l.owner===owner&&l.connection===c!.id&&l.incarnation===c!.incarnation);
    if(lease&&s.sessions[lease.session]?.account===owner&&s.sessions[lease.session].expires>Date.now()){
     if(lease.used||lease.session!==session||lease.upgrade!==upgrade)fail(409,'GOOGLE_ATTEMPT_IN_PROGRESS');return {row:{...c},resume:lease};
    }}
   if(this.pending.size>=128)fail(503,'GOOGLE_PENDING_BOUND');
   if(!c){if((a.google?.length??0)>=64)fail(507,'GOOGLE_CONNECTION_BOUND');c={id:randomUUID(),incarnation:randomUUID(),roots:[],rootRevision:0};(a.google??=[]).push(c);}
   c.incarnation=randomUUID();c.lastAttempt={status:'pending',correlation,at:Date.now(),expiresAt:Date.now()+300000};return {row:{...c}};
  });
  const row=selected.row;
  if(selected.resume)return {connectionId:row.id,authorizationUrl:selected.resume.flow.url,expiresAt:selected.resume.flow.expiresAt};
  for(const [state,l] of this.pending)if(l.owner===owner&&l.connection===row.id)this.pending.delete(state);
  const previous=parseGoogleConnection(row.credential);
  // One consent: read the inbox and folder, draft/send replies, and save prepared files back to the folder.
  const requested=[...new Set([scopes.mail,scopes.drive,composeGrant,fullDriveGrant,...(previous?.grants??[]).filter(g=>g!==outputGrant)])];
  const flow=this.oauth(this.credentials(owner,session,row.id,row.incarnation)).beginRedirect(this.origin()+'/oauth/callback',requested);
  if(upgrade){const url=new URL(flow.url);url.searchParams.set('include_granted_scopes','true');flow.url=url.href;}
  // A queued disconnect/logout can run during the transaction await. Recheck before issuing a lease.
  await this.store.transaction(s=>{this.current(s,owner,session,row.id,row.incarnation);this.pending.set(flow.state,{owner,session,connection:row.id,incarnation:row.incarnation,flow,used:false,expectedIdentity:row.identity,correlation,upgrade,...(upgrade==='mail'?{rootRevision:row.rootRevision,expectedEpoch:previous!.connectionEpoch}:{})});},false);
  return {connectionId:row.id,authorizationUrl:flow.url,expiresAt:flow.expiresAt};
 }
 private async disconnect(owner:string,session:string,id:string){
  const captured=await this.store.transaction(s=>{
   const c=this.current(s,owner,session,id),credential=c.credential;
   // Stop local use durably BEFORE provider I/O, regardless of revocation certainty.
   delete c.credential;c.incarnation=randomUUID();c.revocation='uncertain';c.lastAttempt={status:'disconnected',correlation:randomUUID(),at:Date.now()};return {credential,incarnation:c.incarnation};
  });
  for(const [state,l] of this.pending)if(l.owner===owner&&l.connection===id)this.pending.delete(state);
  // Without a captured credential there is no provider revocation proof (for example,
  // consent may have occurred before an incomplete exchange). Local access is still stopped.
  let revocation:'confirmed'|'uncertain'=captured.credential?'confirmed':'uncertain';
  if(captured.credential){
   let value:string|undefined=captured.credential;
   // Reuse revocation protocol with a private captured-epoch store. It cannot touch a newer connection.
   const snapshot:CredentialStore={get:async()=>value,set:async()=>{throw Error('READ_ONLY');},delete:async()=>{throw Error('CAS_REQUIRED');},compareAndSet:async()=>false,compareAndDelete:async(_id,expected)=>{if(value!==expected)return false;value=undefined;return true;}};
   try{await this.oauth(snapshot).disconnect(id);}catch{revocation='uncertain';}
  }
  await this.store.transaction(s=>{const c=this.row(s,owner,id);if(c.incarnation===captured.incarnation)c.revocation=revocation;});
  return {status:'disconnected',revocation};
 }
 /** Mounted callback has no cookie dependency. Host/path/method checked by the host first. */
 async callback(url:URL){
  this.prune();const state=url.searchParams.get('state'),lease=state?this.pending.get(state):undefined;
  if(!lease||lease.used){this.emit({operation:'google_oauth',stage:'callback',code:'GOOGLE_FLOW_EXPIRED_OR_USED',status:409,correlation:randomUUID()});return fail(409,'GOOGLE_FLOW_EXPIRED_OR_USED');}
  lease.used=true;
  try{
   await this.store.transaction(s=>this.checkLease(s,lease),false);
   // Check each external I/O boundary, not only credential get/final CAS. Never keep a
   // transaction open over provider I/O: logout must be able to durably revoke the lease.
   const current=()=>this.store.transaction(s=>{this.checkLease(s,lease);},false);
   const oauth=this.oauth(this.credentials(lease.owner,lease.session,lease.connection,lease.incarnation,lease));
   await oauth.exchange(url.href,lease.flow,lease.connection,lease.expectedIdentity,{requiredGrants:lease.upgrade?lease.flow.requested:undefined,requiredGrantCode:lease.upgrade==='mail'?'GOOGLE_MAIL_GRANT_REQUIRED':undefined,checkCurrent:current,observe:event=>this.emit({operation:'google_oauth',...event,correlation:lease.correlation})});
   this.emit({operation:'google_oauth',stage:'callback',code:'GOOGLE_CONNECTED',status:200,correlation:lease.correlation});
   // Never serialize exchange() (contains an internal access token).
   return {status:'connected'};
  }catch(error){
   let failure=error;
   if(error instanceof GoogleOAuthFailure){
    // A failed reconnect never discards the previous verified credential. A stale
    // callback cannot overwrite a newer attempt, disconnect or revoked session.
    try{await this.store.transaction(s=>{const c=this.checkLease(s,lease);c.lastAttempt={status:'failed',correlation:lease.correlation,at:Date.now(),code:error.code,stage:error.stage,...(error.reason?{reason:error.reason}:{}),httpStatus:error.status};});}catch(commitError){failure=commitError;}
   }
   this.emit({operation:'google_oauth',stage:failure instanceof GoogleOAuthFailure?failure.stage:'callback',code:failure instanceof GoogleOAuthFailure?failure.code:failure instanceof GoogleAccountFailure?'GOOGLE_CONTEXT_CHANGED':'STORE_OR_REQUEST_UNAVAILABLE',status:failure instanceof GoogleOAuthFailure||failure instanceof GoogleAccountFailure?failure.status:503,correlation:lease.correlation,...(failure instanceof GoogleOAuthFailure&&failure.reason?{reason:failure.reason}:{})});throw failure;
  }finally{if(this.pending.get(lease.flow.state)===lease)this.pending.delete(lease.flow.state);}
 }
 /** Backend-only background capability from explicit standing host authorization.
  * Browser sessions are not its lifetime or restart credential. The host must
  * restore/recheck real standing permission, not infer it from OAuth possession.
  * Construction never starts a watch or model and is not mounted as an HTTP RPC. */
 async triggerAuthority(authorization:BackgroundGoogleAuthorization):Promise<GoogleTriggerAuthority>{
  const {ownerId:owner,connectionId:id,isCurrent:authorized}=authorization;
  if(!validId(owner)||!validId(id)||typeof authorized!=='function')fail(400,'INVALID_GOOGLE_TRIGGER_AUTHORITY');
  const standing=()=>{if(this.closing||!authorized())fail(403,'GOOGLE_BACKGROUND_AUTHORIZATION_REQUIRED');};
  const captured=await this.store.transaction(s=>{standing();const c=this.row(s,owner,id),p=parseGoogleConnection(c.credential);if(!p)fail(409,'GOOGLE_RECONNECT_REQUIRED');if(!p!.grants.includes(scopes.mail))fail(403,'GOOGLE_MAIL_GRANT_REQUIRED');return {incarnation:c.incarnation,rootRevision:c.rootRevision,accountId:p!.accountId,connectionEpoch:p!.connectionEpoch};},false);
  const row=(s:S)=>{standing();const c=this.row(s,owner,id),p=parseGoogleConnection(c.credential);if(c.incarnation!==captured.incarnation||c.rootRevision!==captured.rootRevision||p?.accountId!==captured.accountId||p?.connectionEpoch!==captured.connectionEpoch)fail(409,'GOOGLE_CONNECTION_CHANGED');if(!p!.grants.includes(scopes.mail))fail(403,'GOOGLE_MAIL_GRANT_REQUIRED');return c;};
  const assertCurrent=async(signal:AbortSignal)=>{signal.throwIfAborted();await this.store.transaction(s=>{signal.throwIfAborted();row(s);},false);signal.throwIfAborted();};
  const http:typeof fetch=(input,init)=>this.track((async()=>{const signal=init?.signal??new AbortController().signal;await assertCurrent(signal);const response=await this.http(input,init);try{await assertCurrent(signal);return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}})());
  const oauth=this.oauth(this.credentialAdapter(id,row),http);
  await assertCurrent(new AbortController().signal);
  // Provider account remains Google's identity; deterministic owner-scoped workspace
  // prevents two Spindle owners with that identity from sharing task/evidence rows.
  return {ownerId:owner,connectionId:id,workspaceId:`account-private:${owner}`,accountId:captured.accountId,connectionEpoch:captured.connectionEpoch,oauth,assertCurrent};
 }
 /** Backend-only capability. Never serialized or passed to model/UI. No source download at admission. */
 async preparationBinding(owner:string,session:string,id:string,rootId:string){
  if(!validId(id)||!validId(rootId))fail(400,'INVALID_GOOGLE_SOURCE');
  const captured=await this.store.transaction(s=>{const c=this.current(s,owner,session,id);if(!c.credential)fail(409,'GOOGLE_RECONNECT_REQUIRED');if(!c.roots.includes(rootId))fail(403,'GOOGLE_ROOT_DENIED');const parsed=parseGoogleConnection(c.credential)!;if(!parsed.grants.includes(scopes.drive))fail(403,'GOOGLE_READ_GRANT_REQUIRED');return {incarnation:c.incarnation,rootRevision:c.rootRevision,googleAccountId:parsed.accountId,connectionEpoch:parsed.connectionEpoch};},false);
  const check=(s:S)=>{const c=this.current(s,owner,session,id,captured.incarnation),parsed=parseGoogleConnection(c.credential);if(c.rootRevision!==captured.rootRevision||!c.roots.includes(rootId)||parsed?.connectionEpoch!==captured.connectionEpoch)fail(409,'GOOGLE_ROOT_CHANGED');if(parsed?.accountId!==captured.googleAccountId||!parsed.grants.includes(scopes.drive))fail(403,'GOOGLE_READ_GRANT_REQUIRED');};
  const assertCurrent=async(options?:GoogleOperation)=>{options?.signal?.throwIfAborted();await this.store.transaction(s=>{options?.signal?.throwIfAborted();check(s);},false);};
  // Invoke the synchronous dispatch thunk under the authoritative auth transaction.
  // Box its result: a pending network response must NOT hold this FIFO store lock.
  // Neither callback may re-enter the store/OAuth; obtain credentials beforehand.
  const guardedDispatch=<T>(guard:()=>boolean,dispatch:()=>T,options?:GoogleOperation)=>this.track(this.store.transaction(s=>{options?.signal?.throwIfAborted();check(s);if(guard()!==true)fail(409,'GOOGLE_DISPATCH_NOT_CURRENT');return {started:dispatch()};},false));
  // Synchronous revocation signal: the SAME check runs on every committed auth-store write
  // (signout, session/root/grant/epoch change). Pure; never re-enters the store or OAuth.
  const observe=(revoked:()=>void)=>{let done=false;const stop=this.store.observe(s=>{if(done)return;try{check(s);}catch{done=true;stop();revoked();}});return ()=>{done=true;stop();};};
  const http:typeof fetch=async(input,init)=>{await assertCurrent({signal:init?.signal??undefined});const response=await this.http(input,init);try{await assertCurrent({signal:init?.signal??undefined});return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}};
  const oauth=this.oauth(this.credentials(owner,session,id,captured.incarnation),http);
  await assertCurrent();
  const assertSources=async(sources:readonly import('../evidence/types.js').SourceRef[],options?:GoogleOperation)=>{
   await assertCurrent(options);const files=sources.filter(s=>s.provider==='drive'&&s.providerId&&s.providerVersion&&s.providerVersion!=='observed-listing');if(!files.length)return;
   const access=await oauth.connectorAccess(id,scopes.drive),token=await access.token(options);await assertCurrent(options);
   const reader=new DriveReader(token,access.accountId,new Set([rootId]),http);
   for(const source of files){await reader.checkVersion(source.providerId!,source.providerVersion!,options?.signal);await assertCurrent(options);}
  };
  return {...captured,rootId,connectionId:id,oauth,http,assertCurrent,assertSources,guardedDispatch,observe};
 }
 /** Backend-only selected sender/session capability; no Drive root or token projection. */
 async mailBinding(owner:string,session:string,id:string){
  if(!validId(id))fail(400,'INVALID_CONNECTION_ID');
  const captured=await this.store.transaction(s=>{const c=this.current(s,owner,session,id),p=parseGoogleConnection(c.credential);if(!p)fail(409,'GOOGLE_RECONNECT_REQUIRED');if(!p!.grants.includes(scopes.mail))fail(403,'GOOGLE_MAIL_GRANT_REQUIRED');return {incarnation:c.incarnation,googleAccountId:p!.accountId,connectionEpoch:p!.connectionEpoch};},false);
  const assertCurrent=async(options?:GoogleOperation)=>{options?.signal?.throwIfAborted();await this.store.transaction(s=>{options?.signal?.throwIfAborted();const c=this.current(s,owner,session,id,captured.incarnation),p=parseGoogleConnection(c.credential);if(p?.connectionEpoch!==captured.connectionEpoch||p?.accountId!==captured.googleAccountId)fail(409,'GOOGLE_CONNECTION_CHANGED');},false);};
  // Required backend capability: the task guard runs after the final encrypted
  // auth wait, synchronously adjacent to raw HTTP. Never defer dispatch after it.
  const guardedHttp=(input:RequestInfo|URL,init:RequestInit|undefined,guard:()=>void)=>this.track((async()=>{await assertCurrent({signal:init?.signal??undefined});guard();const response=await this.http(input,init);try{await assertCurrent({signal:init?.signal??undefined});return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}})());
  // OAuth's private token transport carries no mail/source payload; it retains
  // the same captured auth and cancellation checks, not an exposed Gmail fallback.
  const oauthHttp:typeof fetch=(input,init)=>guardedHttp(input,init,()=>init?.signal?.throwIfAborted());
  const oauth=this.oauth(this.credentials(owner,session,id,captured.incarnation),oauthHttp);
  await assertCurrent();return {...captured,connectionId:id,oauth,guardedHttp,assertCurrent};
 }
 /** Read-only inbox access for the owner's open session (watching for request emails). */
 async gmailToken(owner:string,session:string,id:string){
  const b=await this.mailBinding(owner,session,id),access=await b.oauth.connectorAccess(id,scopes.mail),token=await access.token();
  const http:typeof fetch=(input,init)=>b.guardedHttp(input,init,()=>init?.signal?.throwIfAborted());
  return {token,http};
 }
 /** Host tracks all operations so its lock is not released while a provider operation can still commit. */
 track<T>(promise:Promise<T>):Promise<T>{this.jobs.add(promise);void promise.finally(()=>this.jobs.delete(promise)).catch(()=>{});return promise;}
 async close(){this.closing=true;this.pending.clear();await Promise.allSettled([...this.jobs]);}
}
