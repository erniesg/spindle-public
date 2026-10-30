import type {AccountIdentity} from '../memory/user-protocol.js';
import type {PreparationBrowserSelection,PreparationBrowserSnapshot} from '../preparation/browser-review.js';
import type {PreparationRequest,PreparationReceipt,PreparationField,PreparationSave,PreparationExecution,PreparationStep,PreparationStepStatus,PreparationAction} from '../preparation/types.js';
export interface PreparationStatus extends PreparationReceipt {connectionId?:string;rootId?:string;googleAccountId?:string;generation?:number;execution?:PreparationExecution;steps?:Partial<Record<PreparationStep,PreparationStepStatus>>;canResume?:boolean;actions?:PreparationAction[];processingConsent?:boolean;processingPaused?:boolean;processingPauseReason?:string;saveOutputs:boolean;mode:'local_draft'|'drive_outputs';request:string;checklist:{revision:number;reason:string;items:{id:string;title:string;state:string;dependsOn:string[]}[]};session:unknown;sources:unknown[];fields:PreparationField[];artifacts:{id:string;mimeType:string;sha256:string;bytes:number;revision?:number;current?:boolean}[];outputs:{artifactId:string;revision:number;state:string;url?:string}[];saves?:Omit<PreparationSave,'events'>[];recovery:string;blocker?:string;nextAction:string;result?:string;}
import type {GoogleConnections,GoogleConnectionStart,GoogleConnectionStatus} from './google-client.js';
/** Only fixed protocol categories cross the Google error seam; never provider bodies. */
const googleFailureCodes=new Set(['GOOGLE_OUTPUT_GRANT_REQUIRED','GOOGLE_PICKER_CONFIGURATION_REQUIRED','GOOGLE_OUTPUT_PARENT_AUTHORIZATION_REQUIRED','GOOGLE_CONSENT_DENIED','GOOGLE_PROVIDER_UNAVAILABLE','GOOGLE_CALLBACK_INVALID','GOOGLE_FLOW_EXPIRED_OR_USED','GOOGLE_REFRESH_CREDENTIAL_REQUIRED','GOOGLE_IDENTITY_GRANT_REQUIRED','GOOGLE_PROFILE_DENIED','GOOGLE_PROFILE_INVALID','GOOGLE_IDENTITY_MISMATCH','GOOGLE_TOKEN_REJECTED','GOOGLE_CLIENT_CONFIGURATION','GOOGLE_TOKEN_INVALID','GOOGLE_RESPONSE_TOO_LARGE','GOOGLE_NETWORK_UNAVAILABLE','GOOGLE_CREDENTIAL_CHANGED','GOOGLE_AUTH_CONTEXT_CHANGED','GOOGLE_CONNECTION_CHANGED','GOOGLE_ATTEMPT_IN_PROGRESS','GOOGLE_CONNECTION_NOT_FOUND','GOOGLE_NOT_CONFIGURED','GOOGLE_RECONNECT_REQUIRED','GOOGLE_ROOT_DENIED','GOOGLE_ROOT_CHANGED','GOOGLE_PENDING_BOUND','GOOGLE_CONNECTION_BOUND','STORE_OR_REQUEST_UNAVAILABLE','SIGNIN_REQUIRED','CSRF_DENIED','BUSY']);
export type WorkOSSessionCredentials={account:AccountIdentity;cookie:string;csrf:string};
/** Trusted host envelope only. Raw session credentials must never cross browser routes. */
export function validateWorkOSSessionCredentials(value:unknown):asserts value is WorkOSSessionCredentials{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='account,cookie,csrf')throw Error('INVALID_ACCOUNT_SESSION');
 const v=value as WorkOSSessionCredentials,a=v.account;
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='id,name'||typeof a.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a.id)||typeof a.name!=='string'||!/^[a-z0-9._-]{3,64}$/.test(a.name)||typeof v.cookie!=='string'||!/^spindle_session=[a-f0-9]{64}$/.test(v.cookie)||typeof v.csrf!=='string'||!/^[a-f0-9]{64}$/.test(v.csrf))throw Error('INVALID_ACCOUNT_SESSION');
}
export class AccountRequestFailure extends Error {constructor(readonly status:number,readonly code:string){super(`ACCOUNT_HTTP_${status}: ${code}`);}}
/** Device-free client for the existing account service. Credentials stay in memory, never memory/artifact databases. */
export class AccountClient {
 private cookie='';private csrf='';private current:AccountIdentity|undefined;private generation=0;private signingIn=false;
 private authTail:Promise<unknown>=Promise.resolve();private uncertainSession=false;
 private serializeAuth<T>(operation:()=>Promise<T>):Promise<T>{const task=this.authTail.catch(()=>{}).then(operation);this.authTail=task;return task;}
 readonly origin:string;
 constructor(origin:string,private readonly transport:typeof fetch=fetch,private readonly browserCookies=false){
  const url=new URL(origin);
  if(url.origin!==origin||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw Error('TLS_REQUIRED');
  this.origin=origin;
 }
 get account():AccountIdentity|undefined{return this.current&&{...this.current};}
 private async exchange(path:string,data:unknown,cookie:string,csrf:string,signal?:AbortSignal){
  if(!path.startsWith('/')||path.startsWith('//')||new URL(path,this.origin).origin!==this.origin)throw Error('INVALID_ACCOUNT_PATH');
  const body=data===undefined?undefined:JSON.stringify(data);if(body&&new TextEncoder().encode(body).length>(path==='/mail/edit'?3_000_000:512000))throw Error('REQUEST_BOUND');
  // Browser fetch requires the global receiver, not this AccountClient instance.
  const transport=this.transport;
  const issuing=path==='/signin'||path==='/register';if(issuing)this.uncertainSession=true;
  const response=await transport(this.origin+path,{method:data===undefined?'GET':'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),credentials:this.browserCookies?'same-origin':'omit',headers:{...(!this.browserCookies?{Origin:this.origin}:{}),...(body?{'Content-Type':'application/json'}:{}),...(!this.browserCookies&&cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body});
  // Only definite protocol rejection establishes that no session was issued. A
  // server/gateway failure may have lost an already-committed auth response.
  if(!response.ok){
   if(issuing&&[400,401,403,409,429].includes(response.status))this.uncertainSession=false;
   if((path.startsWith('/google/')||path.startsWith('/preparation/')||path.startsWith('/mail/'))&&response.body){
    const reader=response.body.getReader();let text='',size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4096)break;text+=new TextDecoder().decode(part.value);}if(size<=4096){const code=JSON.parse(text)?.code;if(code==='PAID_TASK_QUOTA'||googleFailureCodes.has(code)||typeof code==='string'&&/^(?:PREPARATION_|INVALID_PREPARATION_|STALE_PREPARATION_|REQUEST_ID_CONFLICT|OUTPUTS_NOT_VERIFIED|GOOGLE_|MAIL_)[A-Z_]*$/.test(code))throw new AccountRequestFailure(response.status,code);}}
    catch(error){if(error instanceof AccountRequestFailure)throw error;}finally{void reader.cancel().catch(()=>{});}
   }
   await response.body?.cancel().catch(()=>{});throw Error(`ACCOUNT_HTTP_${response.status}`);
  }
  if(!response.body)throw Error('EMPTY_ACCOUNT_RESPONSE');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>(path==='/preparation/artifact'?32*1024*1024:path==='/mail/draft'?3_000_000:path==='/mail/status'?4_000_000:1100000))throw Error('RESPONSE_BOUND');chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {value:path==='/preparation/artifact'?{bytes,mimeType:response.headers.get('content-type')??'application/octet-stream'}:JSON.parse(new TextDecoder().decode(bytes)) as unknown,cookie:response.headers.get('set-cookie')?.split(';')[0]??''};
 }
 async signin(name:string,password:string,register=false):Promise<AccountIdentity>{
  if(this.signingIn)throw Error('ACCOUNT_BUSY');this.signingIn=true;
  const generation=++this.generation;this.current=undefined;
  try{return await this.serializeAuth(async()=>{
   // Private logout avoids signin -> public signout recursion. Never reset a later cancellation.
   await this.logoutSession();
   if(generation!==this.generation)throw Error('ACCOUNT_IDENTITY_MISMATCH');
   try{
    const auth=await this.exchange(register?'/register':'/signin',{name,password},'','');
    const csrf=(auth.value as {csrf?:unknown})?.csrf;
    if(typeof csrf!=='string'||!/^[a-f0-9]{64}$/.test(csrf)||!this.browserCookies&&!/^spindle_session=[a-f0-9]{64}$/.test(auth.cookie))throw Error('INVALID_ACCOUNT_SESSION');
    // Retain revocation authority before any more awaits, even if signin has been cancelled.
    this.cookie=auth.cookie;this.csrf=csrf;this.uncertainSession=false;
    if(generation!==this.generation)throw Error('ACCOUNT_IDENTITY_MISMATCH');
    const session=await this.exchange('/session',this.browserCookies?{}:undefined,auth.cookie,csrf);
    const account=(session.value as {account?:AccountIdentity})?.account;
    if((session.value as {csrf?:unknown})?.csrf!==csrf)throw Error('INVALID_ACCOUNT_SESSION');
    if(!account||typeof account.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(account.id)||typeof account.name!=='string'||account.name!==name||generation!==this.generation)throw Error('ACCOUNT_IDENTITY_MISMATCH');
    this.current={id:account.id,name:account.name};return {...this.current};
   }catch(error){await this.logoutSession();throw error;}
  });}finally{this.signingIn=false;}
 }
 /** Trusted native-host handoff after backend WorkOS code exchange; never expose via a raw-cookie HTTP route. */
 async signinWorkOSSession(value:WorkOSSessionCredentials):Promise<AccountIdentity>{
  if(this.browserCookies)throw Error('BROWSER_SESSION_REQUIRED');
  validateWorkOSSessionCredentials(value);const incoming={account:{...value.account},cookie:value.cookie,csrf:value.csrf};
  if(this.signingIn)throw Error('ACCOUNT_BUSY');this.signingIn=true;
  const generation=++this.generation;this.current=undefined;
  try{return await this.serializeAuth(async()=>{
   await this.logoutSession();
   // Retain supplied revocation authority even when cancellation raced the previous logout.
   this.cookie=incoming.cookie;this.csrf=incoming.csrf;this.uncertainSession=false;
   try{
    if(generation!==this.generation)throw Error('ACCOUNT_IDENTITY_MISMATCH');
    const result=await this.exchange('/session',undefined,this.cookie,this.csrf);
    const session=result.value as {account?:AccountIdentity;csrf?:unknown},account=session.account;
    if(session.csrf!==incoming.csrf)throw Error('INVALID_ACCOUNT_SESSION');
    if(!account||account.id!==incoming.account.id||account.name!==incoming.account.name||generation!==this.generation)throw Error('ACCOUNT_IDENTITY_MISMATCH');
    this.current={id:account.id,name:account.name};return {...this.current};
   }catch(error){await this.logoutSession();throw error;}
  });}finally{this.signingIn=false;}
 }
 /** Trusted host rollback; caller retains credentials until revocation is confirmed. */
 async revokeWorkOSSession(session:WorkOSSessionCredentials,signal?:AbortSignal):Promise<void>{
  if(this.browserCookies)throw Error('BROWSER_SESSION_REQUIRED');validateWorkOSSessionCredentials(session);
  try{await this.exchange('/logout',{},session.cookie,session.csrf,signal);}
  catch(error){if(!(error instanceof Error)||error.message!=='ACCOUNT_HTTP_401')throw error;}
 }
 async request(path:string,data?:unknown,signal?:AbortSignal):Promise<unknown>{
  if(!this.current)throw Error('SIGNIN_REQUIRED');const generation=this.generation;
  const result=await this.exchange(path,data,this.cookie,this.csrf,signal);
  if(generation!==this.generation||!this.current)throw Error('ACCOUNT_CHANGED');return result.value;
 }
 /** Browser session restoration uses only that browser's HttpOnly cookie, never a VM-global client. */
 async restore():Promise<AccountIdentity>{
  if(!this.browserCookies)throw Error('BROWSER_SESSION_REQUIRED');if(this.signingIn)throw Error('ACCOUNT_BUSY');this.signingIn=true;
  const generation=++this.generation;this.current=undefined;
  try{return await this.serializeAuth(async()=>{
   if(generation!==this.generation)throw Error('INVALID_ACCOUNT_SESSION');
   const result=await this.exchange('/session',{},'','');
   const session=result.value as {account?:AccountIdentity;csrf?:string};
   if(!session.account||! /^[a-f0-9-]{36}$/.test(session.account.id)||typeof session.account.name!=='string'||typeof session.csrf!=='string'||! /^[a-f0-9]{64}$/.test(session.csrf))throw Error('INVALID_ACCOUNT_SESSION');
   this.csrf=session.csrf;
   if(generation!==this.generation)throw Error('INVALID_ACCOUNT_SESSION');
   this.current={...session.account};return {...this.current};
  });}finally{this.signingIn=false;}
 }
 preparationConfiguration(){return this.request('/preparation/config',{}) as Promise<{configured:false;processingPaused:true;processingPauseReason?:string;access?:'connection-only'|'owned-pilot'|'owner';code?:string}|{configured:true;processingPaused?:boolean;processingPauseReason?:string;models:unknown;limits:{limitUsd:number;maximumDecisionCalls:number;maximumVisionCalls:number};modes:string[];requiresProcessingConsent:true}>;}
 prepareApplication(input:PreparationRequest){return this.request('/preparation/request',input) as Promise<PreparationReceipt>;}
 preparationList(){return this.request('/preparation/list',{}) as Promise<{tasks:(PreparationReceipt & {request:string;connectionId:string;rootId:string;execution:PreparationExecution})[];limit:number}>;}
 preparationTask(taskId:string){return this.request('/preparation/status',{taskId}) as Promise<PreparationStatus>;}
 correctPreparation(input:{taskId:string;expectedRevision:number;fieldId:string;value:string}){return this.request('/preparation/correct',input) as Promise<PreparationReceipt>;}
 /** Read-only current fields/files/destination; this never approves or starts a browser. */
 reviewPreparationBrowser(taskId:string,selection:PreparationBrowserSelection){return this.request('/preparation/browser-review',{...selection,taskId}) as Promise<PreparationBrowserSnapshot>;}
 savePreparation(input:{taskId:string;expectedRevision:number;kind:'draft'|'session';requestId:string;saveOutputs:boolean}){return this.request('/preparation/save',input) as Promise<Omit<PreparationSave,'events'>>;}
 async resumePreparation(taskId:string,expectedGeneration?:number,requestId=crypto.randomUUID()){const generation=expectedGeneration??(await this.preparationTask(taskId)).generation;return this.request('/preparation/resume',{taskId,expectedGeneration:generation,requestId}) as Promise<PreparationReceipt>;}
 preparationSource(taskId:string,operation:'list'|'read',fileId?:string){return this.request('/preparation/source',{taskId,operation,...(fileId?{fileId}:{})}) as Promise<{origin:'manual_probe';result:{status:string;data:unknown;error?:{code:string;message:string}}}>;}
 cancelPreparation(taskId:string){return this.request('/preparation/cancel',{taskId}) as Promise<PreparationReceipt>;}
 preparationArtifact(taskId:string,artifactId:string){return this.request('/preparation/artifact',{taskId,artifactId}) as Promise<{bytes:Uint8Array;mimeType:string}>;}
 /** Explicit Google Picker action only. Never persist/log this ephemeral browser capability. */
 googleOutputPicker(connectionId:string,rootId:string){return this.request('/google/output/picker',{connectionId,rootId}) as Promise<{appId:string;developerKey:string;accessToken:string;rootId:string;origin:string}>;}
 checkGoogleOutputParent(connectionId:string,rootId:string){return this.request('/google/output/parent',{connectionId,rootId}) as Promise<{rootId:string;creationAuthorized:true}>;}
 mailAction(path:'config'|'request'|'list'|'status'|'draft'|'edit'|'publish'|'send'|'reconcile'|'cancel'|'sources',data:Record<string,unknown>={}){return this.request('/mail/'+path,data);}
 authorizeGoogleOutputs(connectionId:string){return this.request('/google/output/begin',{connectionId}) as Promise<GoogleConnectionStart>;}
 /** Explicit incremental consent only; never drafts/sends mail or schedules preparation. */
 authorizeGoogleMail(connectionId:string){return this.request('/google/mail/begin',{connectionId}) as Promise<GoogleConnectionStart>;}
 googleConnections(){return this.request('/google/list',{}) as Promise<GoogleConnections>;}
 connectGoogle(connectionId?:string){return this.request('/google/begin',connectionId?{connectionId}:{}) as Promise<GoogleConnectionStart>;}
 selectGoogleRoots(connectionId:string,roots:string[]){return this.request('/google/roots',{connectionId,roots}) as Promise<GoogleConnectionStatus>;}
 disconnectGoogle(connectionId:string){return this.request('/google/disconnect',{connectionId}) as Promise<{status:'disconnected';revocation:'confirmed'|'uncertain'}>;}
 checkGoogleDriveRoot(connectionId:string,rootId:string){return this.request('/google/drive/check',{connectionId,rootId});}
 listGoogleDrive(connectionId:string,rootId:string,folder:string,page?:string){return this.request('/google/drive/list',{connectionId,rootId,folder,...(page===undefined?{}:{page})});}
 readGoogleDrive(connectionId:string,rootId:string,fileId:string){return this.request('/google/drive/read',{connectionId,rootId,fileId});}
 private async logoutSession(signal?:AbortSignal):Promise<void>{
  // A lost/invalid auth reply may have issued authority we cannot identify/revoke. Fail closed.
  if(this.uncertainSession)throw Error('ACCOUNT_LOGOUT_UNCONFIRMED');
  if(this.browserCookies&&!this.csrf){
   try{const result=await this.exchange('/session',{},'','',signal);const csrf=(result.value as {csrf?:unknown})?.csrf;if(typeof csrf!=='string'||!/^[a-f0-9]{64}$/.test(csrf))throw Error('INVALID_ACCOUNT_SESSION');this.csrf=csrf;}
   catch(error){if(!(error instanceof Error)||error.message!=='ACCOUNT_HTTP_401')throw error;return;}
  }
  if(this.cookie||this.browserCookies&&this.csrf){
   try{await this.exchange('/logout',{},this.cookie,this.csrf,signal);}
   catch(error){if(!(error instanceof Error)||error.message!=='ACCOUNT_HTTP_401')throw error;}
  }
  // Keep credentials on uncertain/failed logout so a later call can retry revocation.
  this.cookie='';this.csrf='';
 }
 async signout(signal?:AbortSignal):Promise<void>{
  ++this.generation;this.current=undefined;
  // Wait for issued cookies and cancelled signin cleanup, not merely a local flag change.
  await this.serializeAuth(()=>this.logoutSession(signal));
 }
}
