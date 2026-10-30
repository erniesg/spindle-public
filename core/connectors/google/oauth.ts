import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { boundedJson } from './bounded.js';
import { abortRace } from './abort.js';
export interface GoogleOperation {signal?:AbortSignal}
export type GoogleOAuthStage='callback'|'token'|'profile'|'credential';
export type GoogleOAuthCode='GOOGLE_OUTPUT_GRANT_REQUIRED'|'GOOGLE_MAIL_GRANT_REQUIRED'|'GOOGLE_CONSENT_DENIED'|'GOOGLE_PROVIDER_UNAVAILABLE'|'GOOGLE_CALLBACK_INVALID'|'GOOGLE_FLOW_EXPIRED_OR_USED'|'GOOGLE_REFRESH_CREDENTIAL_REQUIRED'|'GOOGLE_IDENTITY_GRANT_REQUIRED'|'GOOGLE_PROFILE_DENIED'|'GOOGLE_PROFILE_INVALID'|'GOOGLE_IDENTITY_MISMATCH'|'GOOGLE_TOKEN_REJECTED'|'GOOGLE_CLIENT_CONFIGURATION'|'GOOGLE_TOKEN_INVALID'|'GOOGLE_RESPONSE_TOO_LARGE'|'GOOGLE_NETWORK_UNAVAILABLE'|'GOOGLE_CREDENTIAL_CHANGED';
export type GoogleCallbackReason='malformed_url'|'origin_mismatch'|'path_mismatch'|'state_length'|'state_mismatch'|'duplicate_parameter'|'unsupported_parameter'|'fragment_present'|'missing_code'|'invalid_code'|'issuer_mismatch'|'invalid_extension'|'provider_error';
/** Fixed categories only: never provider text, parameter names, URLs, credentials or identity. */
export class GoogleOAuthFailure extends Error {constructor(readonly status:number,readonly code:GoogleOAuthCode,readonly stage:GoogleOAuthStage,readonly reason?:GoogleCallbackReason){super(code==='GOOGLE_IDENTITY_MISMATCH'?'Reconnect required: account mismatch':code==='GOOGLE_FLOW_EXPIRED_OR_USED'?'OAuth flow expired or consumed':code==='GOOGLE_RESPONSE_TOO_LARGE'?'Google response byte limit exceeded':code);}}
function invalidResponse(error:unknown,stage:'token'|'profile'){return new GoogleOAuthFailure(502,error instanceof Error&&error.message==='Google response byte limit exceeded'?'GOOGLE_RESPONSE_TOO_LARGE':stage==='token'?'GOOGLE_TOKEN_INVALID':'GOOGLE_PROFILE_INVALID',stage);}
export interface GoogleOAuthBoundary {stage:GoogleOAuthStage;code:GoogleOAuthCode|'GOOGLE_PROVIDER_OK'|'GOOGLE_PROVIDER_REJECTED';status:number}
interface ExchangeOperation extends GoogleOperation {requiredGrants?:readonly string[];requiredGrantCode?:'GOOGLE_OUTPUT_GRANT_REQUIRED'|'GOOGLE_MAIL_GRANT_REQUIRED';checkCurrent?:()=>Promise<void>;observe?:(event:GoogleOAuthBoundary)=>void}
function operationSignal(options?:GoogleOperation){return options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);}
export interface CredentialStore { get(id:string):Promise<string|undefined>; set(id:string,value:string):Promise<void>; delete(id:string):Promise<void>; compareAndSet(id:string,expected:string|undefined,value:string,options?:GoogleOperation):Promise<boolean>; compareAndDelete?(id:string,expected:string):Promise<boolean>; deleteConnectionEpoch?(id:string,epoch:string,accountId:string):Promise<boolean> }
export const scopes = {mail:'https://www.googleapis.com/auth/gmail.readonly',drive:'https://www.googleapis.com/auth/drive.readonly'};
export interface GoogleConnection {refreshToken:string;accountId:string;grants:string[];connectionEpoch:string}
function text(value:unknown,max=8192):value is string {return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);}
function account(value:unknown):string {if(!text(value,254)||! /^[^@]+@[^@]+\.[^@]+$/.test(value))throw Error('Invalid account identity');return value.toLowerCase();}
/** Broader Google scopes imply the narrower ones the connectors check by exact string. */
const implied:Record<string,string[]>={'https://www.googleapis.com/auth/drive':['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/drive.file'],'https://mail.google.com/':['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose'],'https://www.googleapis.com/auth/gmail.modify':['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose']};
function grants(value:unknown):string[] {if(typeof value!=='string'||value.length>16384)throw Error('Invalid grants');const listed=value.split(' ').filter(Boolean),result=[...listed,...listed.flatMap(s=>implied[s]??[])];if(result.some(s=>!text(s,2048)))throw Error('Invalid grants');return [...new Set(result)];}
export function parseGoogleConnection(raw:string|undefined):GoogleConnection|undefined {if(raw===undefined)return undefined;try {const c=JSON.parse(raw);if(!text(c.refreshToken)||!Array.isArray(c.grants)||c.grants.some((s:unknown)=>!text(s,2048)))throw Error();if(c.connectionEpoch!==undefined&&!text(c.connectionEpoch,128))throw Error();return {refreshToken:c.refreshToken,accountId:account(c.accountId),grants:c.grants,connectionEpoch:c.connectionEpoch??createHash('sha256').update(`legacy:${c.refreshToken}`).digest('hex')};}catch{throw Error('Reconnect required: invalid protected connection');}}
/** Process-wide: bindings, the account page and mail each build their own GoogleOAuth instance. */
const refreshing=new Map<string,Promise<unknown>>();
export class GoogleOAuth {
 private async connection(id:string,signal?:AbortSignal):Promise<GoogleConnection|undefined> {const bounded=signal??operationSignal();bounded.throwIfAborted();const raw=await abortRace(this.store.get(id),bounded);bounded.throwIfAborted();return this.parseConnection(raw);}
 private parseConnection(raw:string|undefined){return parseGoogleConnection(raw);}
 async status(id:string) {const c=await this.connection(id);return c?{accountId:c.accountId,grants:[...c.grants]}:undefined;}
 /** Non-secret durable identity for the Google trigger owner. */
 async connectionState(id:string,options?:GoogleOperation) {const c=await this.connection(id,operationSignal(options));return c?{accountId:c.accountId,grants:[...c.grants],connectionEpoch:c.connectionEpoch}:undefined;}
 constructor(private clientId:string, private store:CredentialStore, private http:typeof fetch=fetch, private web?:{clientSecret:string}) {}
 begin(port:number, requested:string[]) {
  if(!Number.isInteger(port)||port<1||port>65535) throw Error('Invalid loopback port');
  return this.beginRedirect(`http://127.0.0.1:${port}/oauth/callback`,requested);
 }
 /** Trusted host configuration only; never a request/model-selected redirect. */
 beginRedirect(redirect:string,requested:string[]) {
  const target=new URL(redirect);
  if(target.href!==redirect||target.username||target.password||target.search||target.hash||target.pathname!=='/oauth/callback'||!(target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','[::1]'].includes(target.hostname)))throw Error('Invalid OAuth redirect');
  const state=randomBytes(32).toString('base64url'), verifier=randomBytes(32).toString('base64url');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:this.clientId,redirect_uri:redirect,response_type:'code',scope:requested.join(' '),state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent'}).toString();
  return {url:url.href,redirect,state,verifier,requested:[...requested],expiresAt:Date.now()+300000,consumed:false};
 }
 async listen(requested:string[], connectionId:string, expectedAccountId?:string, options?:{timeoutMs:number}) {
  const timeoutMs=options?.timeoutMs??300000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw Error('Invalid OAuth listener timeout');
  let flow:ReturnType<GoogleOAuth['begin']>;
  let resolve!:(value:Awaited<ReturnType<GoogleOAuth['exchange']>>)=>void;
  let reject!:(reason:unknown)=>void;
  const result=new Promise<Awaited<ReturnType<GoogleOAuth['exchange']>>>((yes,no)=>{resolve=yes;reject=no;});
  // Attach a handler immediately; the caller still receives the original rejection.
  void result.catch(()=>{});
  const controller=new AbortController();
  const cancel=(message:string)=>{controller.abort(Error(message));reject(controller.signal.reason);server.close();server.closeAllConnections();};
  const server=createServer(async(req,res)=>{
   if(req.headers.host!==new URL(flow.redirect).host || req.headers.origin || req.method!=='GET') {res.writeHead(403).end('Untrusted callback');return;}
   if(flow.consumed){res.writeHead(409).end('Callback already consumed');return;}
   try {const value=await this.exchange(new URL(req.url??'/',flow.redirect).href,flow,connectionId,expectedAccountId,{signal:controller.signal});resolve(value);res.end('Connected. You may close this window.');}
   catch(error){res.writeHead(400).end('Connection failed');if(flow.consumed)reject(error);}
  });
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address=server.address();if(!address||typeof address==='string')throw Error('Loopback unavailable');
  flow=this.begin(address.port,requested);
  const timer=setTimeout(()=>cancel('OAuth flow expired'),timeoutMs);timer.unref();
  return {flow,result,close:async()=>{clearTimeout(timer);cancel('OAuth listener closed');server.closeAllConnections();}};
 }
 async exchange(callback:string, flow:ReturnType<GoogleOAuth['begin']>, connectionId:string, expectedAccountId?:string,options?:ExchangeOperation) {
  const signal=operationSignal(options);signal.throwIfAborted();
  if(flow.consumed||Date.now()>=flow.expiresAt)throw new GoogleOAuthFailure(409,'GOOGLE_FLOW_EXPIRED_OR_USED','callback');
  const invalid=(reason:GoogleCallbackReason):never=>{throw new GoogleOAuthFailure(400,'GOOGLE_CALLBACK_INVALID','callback',reason);};
  let u:URL;try{u=new URL(callback);}catch{return invalid('malformed_url');}
  const expected=new URL(flow.redirect),state=u.searchParams.get('state')??'';
  if(u.origin!==expected.origin||u.username||u.password)invalid('origin_mismatch');
  // URL normalizes dot segments; require the original path too, not just its normalized form.
  if(u.pathname!==expected.pathname||callback.match(/^https?:\/\/[^/?#]+([^?#]*)/)?.[1]!==expected.pathname)invalid('path_mismatch');
  if(Buffer.byteLength(state)!==Buffer.byteLength(flow.state))invalid('state_length');
  if(!timingSafeEqual(Buffer.from(state),Buffer.from(flow.state)))invalid('state_mismatch');
  flow.consumed=true;
  if(u.hash)invalid('fragment_present');
  const parameters=[...u.searchParams.keys()];
  if(parameters.some(k=>u.searchParams.getAll(k).length!==1))invalid('duplicate_parameter');
  if(parameters.some(k=>!['state','code','error','error_description','error_uri','scope','authuser','prompt','iss','hd'].includes(k)))invalid('unsupported_parameter');
  // RFC9207 §2.4: form-decoded exact comparison to Google's configured issuer, never query authority.
  // Absent iss remains supported for legacy Google responses; present empty/wrong iss fails closed.
  if(u.searchParams.has('iss')&&u.searchParams.get('iss')!=='https://accounts.google.com')invalid('issuer_mismatch');
  // RFC6749 §4.1.2 permits response extensions. Recognize only bounded hosted-domain metadata;
  // it is ignored, never an identity/domain/grant/root assertion (verified Gmail profile owns identity).
  if(u.searchParams.has('hd')&&!text(u.searchParams.get('hd'),253))invalid('invalid_extension');
  if(u.searchParams.has('error')){
   const error=u.searchParams.get('error');
   throw error==='access_denied'?new GoogleOAuthFailure(400,'GOOGLE_CONSENT_DENIED','callback'):['server_error','temporarily_unavailable'].includes(error??'')?new GoogleOAuthFailure(502,'GOOGLE_PROVIDER_UNAVAILABLE','callback'):['invalid_client','unauthorized_client'].includes(error??'')?new GoogleOAuthFailure(502,'GOOGLE_CLIENT_CONFIGURATION','callback'):new GoogleOAuthFailure(400,'GOOGLE_CALLBACK_INVALID','callback','provider_error');
  }
  const code=u.searchParams.get('code');if(code===null||code==='')return invalid('missing_code');if(!text(code,8192))return invalid('invalid_code');
  const priorRaw=await abortRace(this.store.get(connectionId),signal);signal.throwIfAborted();
  const previous=this.parseConnection(priorRaw);
  const expectedAccount=expectedAccountId===undefined?previous?.accountId:account(expectedAccountId);
  if(previous&&expectedAccount!==previous.accountId)throw new GoogleOAuthFailure(409,'GOOGLE_IDENTITY_MISMATCH','credential');
  const token=await this.token({grant_type:'authorization_code',code,redirect_uri:flow.redirect,code_verifier:flow.verifier},signal,options);
  if(!token.refresh_token)throw new GoogleOAuthFailure(400,'GOOGLE_REFRESH_CREDENTIAL_REQUIRED','token');
  const granted=grants(token.scope??'');
  if(!granted.includes(scopes.mail))throw new GoogleOAuthFailure(403,'GOOGLE_IDENTITY_GRANT_REQUIRED','profile');
  if(options?.requiredGrants?.some(scope=>!granted.includes(scope)))throw new GoogleOAuthFailure(403,options.requiredGrantCode??'GOOGLE_OUTPUT_GRANT_REQUIRED','credential');
  const response=await this.provider('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token.access_token}`},signal},'profile',signal,options);
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new GoogleOAuthFailure(response.status===403?403:502,'GOOGLE_PROFILE_DENIED','profile');}
  let accountId:string;
  try{const profile=await abortRace(boundedJson(response,65536,signal),signal);signal.throwIfAborted();accountId=account(profile?.emailAddress);}catch(error){options?.signal?.throwIfAborted();if(signal.aborted)throw new GoogleOAuthFailure(502,'GOOGLE_NETWORK_UNAVAILABLE','profile');throw invalidResponse(error,'profile');}
  if(expectedAccount&&accountId!==expectedAccount)throw new GoogleOAuthFailure(409,'GOOGLE_IDENTITY_MISMATCH','profile');
  signal.throwIfAborted();
  if(!await abortRace(this.store.compareAndSet(connectionId,priorRaw,JSON.stringify({refreshToken:token.refresh_token,accountId,grants:granted,connectionEpoch:randomBytes(32).toString('hex'),generation:randomBytes(32).toString('hex')}),{signal}),signal))throw new GoogleOAuthFailure(409,'GOOGLE_CREDENTIAL_CHANGED','credential');
  return {accessToken:token.access_token,accountId,grants:granted,missingGrants:flow.requested.filter(scope=>!granted.includes(scope))};
 }
 private async provider(url:string,init:RequestInit,stage:'token'|'profile',signal:AbortSignal,options?:ExchangeOperation){
  // Fences remain outside the transport catch: storage/session/CAS faults are not provider denial.
  await options?.checkCurrent?.();signal.throwIfAborted();let response:Response;
  try{response=await abortRace(this.http(url,init),signal);}catch{options?.signal?.throwIfAborted();options?.observe?.({stage,code:'GOOGLE_NETWORK_UNAVAILABLE',status:502});throw new GoogleOAuthFailure(502,'GOOGLE_NETWORK_UNAVAILABLE',stage);}
  try{if(signal.aborted){options?.signal?.throwIfAborted();throw new GoogleOAuthFailure(502,'GOOGLE_NETWORK_UNAVAILABLE',stage);}await options?.checkCurrent?.();}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
  options?.observe?.({stage,code:response.ok?'GOOGLE_PROVIDER_OK':'GOOGLE_PROVIDER_REJECTED',status:response.status});return response;
 }
 private async token(fields:Record<string,string>,signal:AbortSignal=operationSignal(),options?:ExchangeOperation):Promise<{access_token:string;refresh_token?:string;scope?:string}> {
  signal.throwIfAborted();
  const r=await this.provider('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...fields,client_id:this.clientId,...(this.web?{client_secret:this.web.clientSecret}:{})}),signal},'token',signal,options);
  if(!r.ok){
   // Inspect only fixed provider error identifiers; never retain/return the body or description.
   let configuration=r.status===401;
   try{const body=await boundedJson(r,4096,signal);configuration||=body.error==='invalid_client'||body.error==='unauthorized_client';}catch{options?.signal?.throwIfAborted();}
   throw new GoogleOAuthFailure(configuration||r.status>=500?502:400,configuration?'GOOGLE_CLIENT_CONFIGURATION':'GOOGLE_TOKEN_REJECTED','token');
  }
  try{const t=await abortRace(boundedJson(r,65536,signal),signal) as {access_token:string;refresh_token?:string;scope?:string};if(!t||!text(t.access_token)||(t.refresh_token!==undefined&&!text(t.refresh_token))||(t.scope!==undefined&&typeof t.scope!=='string'))throw Error();if(t.scope!==undefined)grants(t.scope);return t;}
  catch(error){options?.signal?.throwIfAborted();if(signal.aborted)throw new GoogleOAuthFailure(502,'GOOGLE_NETWORK_UNAVAILABLE','token');throw invalidResponse(error,'token');}
 }
 /** Refreshes of one connection run one at a time in this process. Each refresh rewrites the stored
  * credential generation, so concurrent refreshers (parallel Drive reads, per-source checks) otherwise
  * lose the compare-and-set to each other. Every queued refresh still re-reads and re-checks the store. */
 refresh(id:string,requiredGrant:string,expectedAccountId?:string,expectedEpoch?:string,options?:GoogleOperation):Promise<string> {
  // Each caller runs its own refreshOnce with its own expectations and signal; nothing (token,
  // grants, account, epoch, cancellation) is shared between queued callers. A waiter cancelled
  // while queued rejects at once and never starts token HTTP.
  const signal=options?.signal,prior=(refreshing.get(id)??Promise.resolve()).catch(()=>{});
  const turn=signal?Promise.race([prior,new Promise<never>((_,reject)=>{const stop=()=>reject(signal.reason??Error('Aborted'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})]):prior;
  const run=turn.then(()=>this.refreshOnce(id,requiredGrant,expectedAccountId,expectedEpoch,options));
  // The queue advances only when the underlying refresh ends, not when a cancelled waiter gives up.
  const slot=prior.then(()=>run.catch(()=>{}));
  refreshing.set(id,slot);
  void slot.finally(()=>{if(refreshing.get(id)===slot)refreshing.delete(id);});
  return run;
 }
 private async refreshOnce(id:string,requiredGrant:string,expectedAccountId?:string,expectedEpoch?:string,options?:GoogleOperation):Promise<string> {const signal=operationSignal(options);signal.throwIfAborted();const priorRaw=await abortRace(this.store.get(id),signal);signal.throwIfAborted();const c=this.parseConnection(priorRaw);if(!c)throw Error('Reconnect required: credential absent');if(expectedAccountId!==undefined&&c.accountId!==expectedAccountId)throw Error('Reconnect required: account mismatch');if(expectedEpoch!==undefined&&c.connectionEpoch!==expectedEpoch)throw Error('Connection epoch changed');if(!c.grants.includes(requiredGrant))throw Error('Required grant absent');const t=await this.token({grant_type:'refresh_token',refresh_token:c.refreshToken},signal,options);signal.throwIfAborted();const updated={...c,refreshToken:t.refresh_token??c.refreshToken,grants:t.scope===undefined?c.grants:grants(t.scope)};signal.throwIfAborted();if(!await abortRace(this.store.compareAndSet(id,priorRaw,JSON.stringify({...updated,generation:randomBytes(32).toString('hex')}),{signal}),signal))throw Error('Connection changed: retry connection');if(!updated.grants.includes(requiredGrant))throw Error('Required grant absent');return t.access_token;}
 async accessToken(id:string,requiredGrant:string,expectedAccountId?:string) {return this.refresh(id,requiredGrant,expectedAccountId);}
 /** Bind a connector to the protected, verified identity; never accept caller account labels. */
 async connectorAccess(id:string,requiredGrant:string,options?:GoogleOperation) {
  const signal=options?.signal;
  const connection=await this.connection(id,signal);if(!connection)throw Error('Reconnect required: credential absent');
  const accountId=connection.accountId, connectionEpoch=connection.connectionEpoch;
  const assertCurrent=async(currentOptions?:GoogleOperation)=>{const current=await this.connection(id,currentOptions?.signal&&signal?AbortSignal.any([currentOptions.signal,signal]):currentOptions?.signal??signal);if(current?.accountId!==accountId||current.connectionEpoch!==connectionEpoch)throw Error('Connection epoch changed');if(!current.grants.includes(requiredGrant))throw Error('Required grant absent');};
  return {accountId,connectionEpoch,assertCurrent,token:async(currentOptions?:GoogleOperation)=>{const activeSignal=currentOptions?.signal&&signal?AbortSignal.any([currentOptions.signal,signal]):currentOptions?.signal??signal;await assertCurrent({signal:activeSignal});return this.refresh(id,requiredGrant,accountId,connectionEpoch,{signal:activeSignal});}};
 }
 async disconnect(id:string,revoke=true) {if(!this.store.compareAndDelete)throw Error('Atomic credential deletion unavailable');const captured=await this.store.get(id);if(captured===undefined)return;const token=this.parseConnection(captured)?.refreshToken;if(revoke&&token){const r=await this.http('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token}),signal:AbortSignal.timeout(15000)});if(!r.ok) throw Error(`Revocation failed: ${r.status}`);}const c=this.parseConnection(captured)!;const deleted=this.store.deleteConnectionEpoch?await this.store.deleteConnectionEpoch(id,c.connectionEpoch,c.accountId):await this.store.compareAndDelete(id,captured);if(!deleted)throw Error('Connection changed during disconnect; captured connection was not deleted');}
}
