import type { Browser, BrowserContext, Page, Route, APIResponse } from 'playwright-core';
import type { ApplicationRevisionRef, ToolContext } from '../agent/contracts.js';
import { digest, type EvidenceStore } from '../evidence/store.js';
import { resolveInput } from '../evidence/inputs.js';
import { boundedOperation } from './web.js';
import type { BrowserFormOptions, BrowserSubmissionIntent, BrowserWriteLease, BrowserWriteRequest } from './browser-forms.js';

/** Trusted reviewed body, never derived solely from model arguments or current page values. */
export interface ApprovedBrowserPost {
 url:string;
 encoding:'multipart'|'urlencoded';
 fields:readonly {name:string;value:string}[];
 files:readonly {field:string;artifactId:string;filename:string}[];
}
export interface BrowserHostGrant {
 lease:BrowserWriteLease;
 /** Must abort on actual capability/revision/account/session revocation and expiry. */
 signal:AbortSignal;
 /** At most one exact POST during this operation. Absent means no network write at all. */
 post?:ApprovedBrowserPost;
}
/** Invoke start synchronously inside the authoritative account/source check.
 * Box the already-started operation; never keep an auth lock for its response. */
export interface BrowserPacketDispatch {
 <T>(guard:()=>boolean,start:()=>T,signal:AbortSignal):Promise<{started:T}>;
}
export interface BrowserFormHostConfig {
 browser:Browser; store:EvidenceStore;
 accountId:string; workspaceId:string; taskId:string; sessionId:string;
 destination:string; submissionUrl:string; readUrls:readonly string[]; allowLoopback?:boolean;
 revision(context:ToolContext):ApplicationRevisionRef|undefined;
 authorize(request:BrowserWriteRequest,context:ToolContext):Promise<BrowserHostGrant|undefined>;
 dispatch?:BrowserPacketDispatch;
 uploadName:BrowserFormOptions['uploadName'];
 submissions:BrowserFormOptions['submissions']; readReceipt:BrowserFormOptions['readReceipt'];
 timeoutMs?:number; maxBodyBytes?:number; maxReadRequests?:number;
}
export interface BrowserFormHost {
 options:BrowserFormOptions;
 /** Trusted navigation only. Existing intent => receipt recovery, never a new form POST. */
 open(context:ToolContext):Promise<void>;
 close():Promise<void>;
 status():Readonly<{state:'ready'|'quarantined'|'closed';reason:string;dispatchedPosts:number;blockedRequests:number;inFlight:number;lastPost:'none'|'response_received'|'unknown'}>;
}
interface PreparedPost {url:string;contentType:string;bytes:Buffer;identity:string}
interface Active {
 request:BrowserWriteRequest;ctx:ToolContext;grant:BrowserHostGrant;post?:PreparedPost;
 accepting:boolean;used:boolean;claimed:boolean;removeAbort:()=>void;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const formValue=(value:string)=>value.replace(/\r\n|\r|\n/g,'\r\n');
const canonical=(fields:{name:string;value:string}[],files:{field:string;filename:string;mimeType:string;bytes:number;sha256:string}[])=>JSON.stringify({fields:fields.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),files:files.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
const safeName=(s:string)=>typeof s==='string'&&s.length>0&&s.length<=128&&s!=='.'&&s!=='..'&&!/[\\/\x00-\x1f\x7f]/.test(s);

/** Cookie-free native-form HTTP adapter. Owns its clean context, NOT the operator's Browser. */
export async function createBrowserFormHost(config:BrowserFormHostConfig):Promise<BrowserFormHost> {
 if(config.browser.browserType().name()!=='chromium')throw Error('UNSUPPORTED_BROWSER_HOST');
 const timeout=config.timeoutMs??10000,maxBytes=config.maxBodyBytes??16*1024*1024,maxReads=config.maxReadRequests??64;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||!Number.isSafeInteger(maxReads)||maxReads<1||maxReads>512)throw Error('INVALID_BROWSER_HOST_LIMIT');
 const {accountId,workspaceId,taskId,sessionId,store}=config;
 const destination=config.destination,origin=new URL(destination).origin;
 function admitted(raw:string):string {
  const u=new URL(raw);
  if(raw.length>8192||u.href!==raw||u.origin!==origin||u.username||u.password||u.hash||!(u.protocol==='https:'||config.allowLoopback&&u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))throw Error('INVALID_BROWSER_HOST_DESTINATION');
  return raw;
 }
 admitted(destination);const submissionUrl=admitted(config.submissionUrl);
 const reads=new Set([destination,...config.readUrls.map(admitted)]);
 let state:'ready'|'quarantined'|'closed'='ready',reason='',page:Page,latest:ToolContext|undefined,removeContextAbort=()=>{};
 let active:Active|undefined,closePromise:Promise<void>|undefined,readCount=0,posts=0,submitPosts=0,blocked=0,lastPost:'none'|'response_received'|'unknown'='none';
 const pending=new Set<Promise<APIResponse>>(),handlers=new Set<Promise<void>>(),navigations=new Set<string>();
 const context:BrowserContext=await config.browser.newContext({serviceWorkers:'block',acceptDownloads:false});
 function current(ctx:ToolContext):boolean {
  return state==='ready'&&!ctx.signal.aborted&&ctx.isCurrent()&&ctx.accountId===accountId&&ctx.workspaceId===workspaceId&&ctx.taskId===taskId&&ctx.scope.destinations.includes(destination)&&same(ctx.applicationRevision,config.revision(ctx));
 }
 function bind(ctx:ToolContext):boolean {
  if(!current(ctx)||active&&ctx.signal!==active.ctx.signal)return false;
  if(latest&&latest.runId!==ctx.runId&&(active||pending.size)){void quarantine('run_changed');return false;}
  if(latest?.signal!==ctx.signal){removeContextAbort();const stop=()=>{void quarantine('cancelled');};ctx.signal.addEventListener('abort',stop,{once:true});removeContextAbort=()=>ctx.signal.removeEventListener('abort',stop);}
  latest=ctx;return true;
 }
 function live(a:Active):boolean {return current(a.ctx)&&!a.grant.signal.aborted&&a.grant.lease.isCurrent();}
 function validateIntent(intent:BrowserSubmissionIntent,ctx:ToolContext):string {
  if(!intent.id||intent.sessionId!==sessionId||intent.destination!==destination||!same(intent.revision,config.revision(ctx))||!same(intent.revision,ctx.applicationRevision))throw Error('BROWSER_HOST_INTENT_CHANGED');
  const url=admitted(intent.receiptUrl);if(url===destination)throw Error('BROWSER_HOST_RECEIPT_DENIED');return url;
 }
 function shutdown(next:'quarantined'|'closed',why:string):Promise<void> {
  if(closePromise)return closePromise;
  state=next;reason=why;if(pending.size&&posts)lastPost='unknown';
  if(active){active.accepting=false;active.removeAbort();}removeContextAbort();
  // Disposing the API client interrupts route.fetch; drain actual client promises, not a timer claim.
  // A recipient may still commit an already-dispatched POST after this client has stopped.
  closePromise=(async()=>{
   try {await context.request.dispose({reason:'Owned browser transport closed'});}finally{
    try {await context.close();}finally{await Promise.allSettled([...pending]);}
   }
  })();
  // Event listeners cannot leak unhandled rejections. close()/lease.close still observe failure.
  void closePromise.catch(()=>{});return closePromise;
 }
 function quarantine(why:string){return shutdown('quarantined',why);}
 async function deny(route:Route){blocked++;await route.abort('blockedbyclient').catch(()=>{});}
 async function prepare(post:ApprovedBrowserPost,ctx:ToolContext):Promise<PreparedPost> {
  const url=admitted(post.url);
  if(!['multipart','urlencoded'].includes(post.encoding)||post.fields.length>500||post.files.length>16||post.encoding==='urlencoded'&&post.files.length)throw Error('INVALID_APPROVED_FORM_BODY');
  const fields=post.fields.map(f=>{if(typeof f.name!=='string'||!f.name||f.name.length>2048||typeof f.value!=='string'||f.value.length>8192)throw Error('INVALID_APPROVED_FORM_FIELD');return {name:f.name,value:formValue(f.value)};});
  const files=[];const form=new FormData();let total=0;
  for(const field of fields)form.append(field.name,field.value);
  for(const file of post.files){
   if(!safeName(file.filename)||!file.field||file.field.length>2048)throw Error('INVALID_APPROVED_FORM_FILE');
   const resolved=resolveInput(store,ctx,file.artifactId),a=resolved.artifact;
   if((total+=a.bytes)>maxBytes)throw Error('APPROVED_BODY_TOO_LARGE');
   files.push({field:file.field,filename:file.filename,mimeType:a.mimeType.toLowerCase(),bytes:a.bytes,sha256:a.sha256});
   form.append(file.field,new Blob([new Uint8Array(resolved.bytes)],{type:a.mimeType}),file.filename);
  }
  // Host-generated framing prevents exfil in ignored multipart preambles, boundaries or part headers.
  const body=post.encoding==='multipart'?form:new URLSearchParams(fields.map(f=>[f.name,f.value]));
  const request=new Request(url,{method:'POST',body});const bytes=Buffer.from(await request.arrayBuffer());
  if(bytes.length>maxBytes)throw Error('APPROVED_BODY_TOO_LARGE');
  return {url,bytes,contentType:request.headers.get('content-type')!,identity:canonical(fields,files)};
 }
 async function bodyMatches(route:Route,post:PreparedPost):Promise<boolean> {
  const request=route.request(),headers=await request.allHeaders();
  const length=headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes))return false;
  const bytes=request.postDataBuffer();if(!bytes||bytes.length>maxBytes||length!==undefined&&Number(length)!==bytes.length)return false;
  const type=headers['content-type']??'';
  const multipart=post.contentType.startsWith('multipart/form-data');
  if(type.length>512||!(multipart?/^multipart\/form-data\s*;/i.test(type):/^application\/x-www-form-urlencoded(?:;|$)/i.test(type)))return false;
  // Bound parser materialization before Undici constructs FormData, including empty parts.
  let marker:Buffer;
  if(multipart){const boundary=/\bboundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(type);const value=boundary?.[1]??boundary?.[2];if(!value||value.length>70)return false;marker=Buffer.from('--'+value);}
  else marker=Buffer.from('&');
  let offset=0,count=0;
  for(;;){const next=bytes.indexOf(marker,offset);if(next<0)break;if(++count>518)return false;offset=next+marker.length;}
  const form=await new Request(post.url,{method:'POST',headers:{'content-type':type},body:new Uint8Array(bytes)}).formData();
  const fields:{name:string;value:string}[]=[],files:{field:string;filename:string;mimeType:string;bytes:number;sha256:string}[]=[];
  let parts=0;
  for(const [name,value] of form){
   if(++parts>516||name.length>2048)return false;
   if(typeof value==='string'){if(value.length>16384)return false;fields.push({name,value:formValue(value)});}
   else {if(value.size===0&&value.name==='')continue; // Native untouched file input; omitted from approved outbound body.
    if(value.size>maxBytes||!safeName(value.name))return false;files.push({field:name,filename:value.name,mimeType:value.type,bytes:value.size,sha256:digest(new Uint8Array(await value.arrayBuffer()))});}
  }
  return canonical(fields,files)===post.identity;
 }
 function responseHeaders(response:APIResponse):Record<string,string> {
  const headers={...response.headers()};
  for(const key of ['set-cookie','set-cookie2','refresh','link','alt-svc','nel','report-to','reporting-endpoints','content-encoding','content-length'])delete headers[key];
  const original=(headers['content-security-policy']??'').split(';').filter(d=>!/^\s*report-(?:uri|to)\b/i.test(d)).join(';');
  headers['content-security-policy']=(original?original+', ':'')+"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";
  headers['x-dns-prefetch-control']='off';return headers;
 }
 async function handle(route:Route):Promise<void> {
  const request=route.request(),ctx=latest;
  try {
   if(!ctx||!current(ctx))return await deny(route);
   // Workers, child frames and other tabs never inherit this owned page's authority.
   if(request.frame()!==page.mainFrame())return await deny(route);
   const url=request.url(),method=request.method();let a:Active|undefined,post:PreparedPost|undefined;
   if(method==='GET'){
    if(request.postDataBuffer())return await deny(route);
    if(!reads.has(url)){
     const intent=await config.submissions.current(ctx);
     if(!current(ctx)||!intent||validateIntent(intent,ctx)!==url)return await deny(route);
    }
    if(readCount>=maxReads)return await deny(route);
   }else if(method==='POST'){
    a=active;post=a?.post;
    if(!a||!post||!a.accepting||a.used||!live(a)||post.url!==url||a.request.operation==='submit'&&(!a.claimed||submitPosts!==0))return await deny(route);
    if(!await bodyMatches(route,post))return await deny(route);
    if(active!==a||!a.accepting||a.used||!live(a))return await deny(route);
   }else return await deny(route);
   if(!current(ctx))return await deny(route);
   // Never forward page-controlled headers/cookies/referrers or opaque body framing.
   const headers:Record<string,string>={accept:'*/*',cookie:'','cache-control':'no-store'};
   if(post){headers['content-type']=post.contentType;headers.origin=origin;}
   const canStart=()=>current(ctx)&&(!a||active===a&&a.accepting&&!a.used&&live(a));
   const start=()=>{
    if(!canStart())throw Error('BROWSER_DISPATCH_RETIRED');
    if(a){a.used=true;posts++;if(a.request.operation==='submit')submitPosts++;lastPost='unknown';}else readCount++;
    if(request.isNavigationRequest())navigations.add(url);
    const operation=route.fetch({method,headers,postData:post?.bytes,maxRetries:0,maxRedirects:0,timeout});pending.add(operation);void operation.catch(()=>{});return operation;
   };
   const {started:fetch}=config.dispatch?await config.dispatch(canStart,start,AbortSignal.any([ctx.signal,...(a?[a.grant.signal]:[])])):{started:start()};
   let response:APIResponse;
   try {response=await fetch;}catch{if(a)lastPost='unknown';await quarantine(a?'post_response_unknown':'read_failed');return;}
   finally{pending.delete(fetch);}
   try {
    if(!current(ctx)||a&&!live(a))return await deny(route);
    const responseUrl=response.url();if(responseUrl!==url)throw Error('UNEXPECTED_TRANSPORT_REDIRECT');
    const responseHeadersRaw=response.headers();
    if(/attachment/i.test(responseHeadersRaw['content-disposition']??''))throw Error('DOWNLOAD_DENIED');
    if(response.status()>=300&&response.status()<400){
     const intent=a?.claimed?await config.submissions.current(ctx):undefined;
     if(!intent||response.status()!==303||new URL(responseHeadersRaw.location??'',url).href!==validateIntent(intent,ctx))throw Error('REDIRECT_DENIED');
     // Playwright routes only the first URL in a browser HTTP redirect chain. Never
     // forward Location: turn this ONE validated receipt redirect into a fresh routed GET.
     const receipt=validateIntent(intent,ctx).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
     if(!current(ctx)||!a||!live(a))return await deny(route);
     lastPost='response_received';
     await route.fulfill({status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; frame-src 'none'; base-uri 'none'",'x-dns-prefetch-control':'off'},body:`<!doctype html><meta http-equiv="refresh" content="0;url=${receipt}">`});return;
    }
    const responseBody=await response.body();if(responseBody.length>maxBytes)throw Error('RESPONSE_TOO_LARGE');
    if(!current(ctx)||a&&!live(a))return await deny(route);
    if(a)lastPost='response_received';
    await route.fulfill({response,headers:responseHeaders(response),body:responseBody});
   }finally{await response.dispose();}
  }catch {await deny(route);if(request.method()==='POST')await quarantine('post_transport_uncertain');}
 }
 try {
  // No extra realms/network APIs outside the HTTP route and WebSocket boundary.
  await context.addInitScript(()=>{
   for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport','Worker','SharedWorker','fetchLater'])Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});
  });
  await context.routeWebSocket('**/*',socket=>{blocked++;socket.close();});
  await context.route('**/*',route=>{
   const handling=handle(route);handlers.add(handling);
   void handling.then(()=>handlers.delete(handling),()=>handlers.delete(handling));return handling;
  });
  let opening=true;
  context.on('page',other=>{if(!opening&&other!==page)void quarantine('unowned_page');});
  context.on('serviceworker',()=>{void quarantine('service_worker');});
  page=await context.newPage();opening=false;
  page.on('frameattached',()=>{void quarantine('child_frame');});
  page.on('worker',()=>{void quarantine('worker');});
  page.on('download',download=>{void download.cancel();void quarantine('download');});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&!navigations.has(frame.url()))void quarantine('unadmitted_navigation');});
 }catch {await shutdown('closed','initialization_failed');throw Error('BROWSER_HOST_INITIALIZATION_FAILED');}
 const options:BrowserFormOptions={
  store,timeoutMs:timeout,
  session(ctx){return bind(ctx)?{id:sessionId,page,destination,revision:config.revision(ctx)}:undefined;},
  constrained(session,ctx){return current(ctx)&&session.page===page&&session.id===sessionId&&session.destination===destination;},
  uploadName:config.uploadName,readReceipt:config.readReceipt,
  async authorize(request,ctx){
   if(!bind(ctx)||active||request.sessionId!==sessionId||request.destination!==destination||!same(request.revision,config.revision(ctx)))return undefined;
   const grant=await config.authorize(request,ctx);if(!grant)return undefined;
   if(!current(ctx)||grant.signal.aborted||!grant.lease.isCurrent()){await grant.lease.close('not_dispatched');return undefined;}
   let post:PreparedPost|undefined;
   try {
    if(grant.post)post=await prepare(grant.post,ctx);
    if(request.operation==='submit'?post?.url!==submissionUrl:post?.url===submissionUrl)throw Error('SUBMISSION_ENDPOINT_REQUIRES_CLAIM');
   }
   catch {await grant.lease.close('not_dispatched');return undefined;}
   if(!current(ctx)||active||grant.signal.aborted||!grant.lease.isCurrent()){await grant.lease.close('not_dispatched');return undefined;}
   const a:Active={request,ctx,grant,post,accepting:true,used:false,claimed:false,removeAbort:()=>{}};
   const stop=()=>{void quarantine('authority_revoked');};grant.signal.addEventListener('abort',stop,{once:true});a.removeAbort=()=>grant.signal.removeEventListener('abort',stop);active=a;
   return {id:grant.lease.id,isCurrent(){const valid=live(a);if(!valid)void quarantine('authority_changed');return valid;},async close(outcome){
    a.accepting=false;let uncertain=outcome==='uncertain'||!live(a);
    try {
     if(uncertain)await quarantine('operation_uncertain_or_revoked');
     else {
      await boundedOperation(()=>Promise.allSettled([...handlers]),ctx.signal,timeout);
      if(!live(a)||a.used&&lastPost==='unknown'){uncertain=true;await quarantine('operation_became_uncertain');}
     }
    }catch{uncertain=true;await quarantine('operation_became_uncertain');}
    finally{a.removeAbort();if(active===a)active=undefined;try{await grant.lease.close(uncertain?'uncertain':outcome);}catch{await quarantine('lease_close_failed');throw Error('BROWSER_HOST_LEASE_CLOSE_FAILED');}}
    if(uncertain&&outcome!=='uncertain')throw Error('BROWSER_HOST_RESPONSE_UNKNOWN');
   }};
  },
  submissions:{
   async current(ctx){if(!bind(ctx))throw Error('BROWSER_HOST_STALE');return config.submissions.current(ctx);},
   async record(intent,next,ctx){validateIntent(intent,ctx);return config.submissions.record(intent,next,ctx);},
   async claim(request,ctx){
    const a=active;if(!a||a.request!==request||!live(a)||!a.post||request.operation!=='submit'||submitPosts)throw Error('BROWSER_HOST_CLAIM_DENIED');
    const claim=await config.submissions.claim(request,ctx);validateIntent(claim.intent,ctx);
    if(claim.intent.inputHash!==request.inputHash)throw Error('BROWSER_HOST_INTENT_CHANGED');
    if(claim.dispatch&&active===a&&live(a))a.claimed=true;else a.accepting=false;
    return claim;
   }
  }
 };
 return {options,async open(ctx){
  if(!bind(ctx))throw Error('BROWSER_HOST_SCOPE_DENIED');
  try {const intent=await config.submissions.current(ctx);if(!current(ctx))throw Error('STALE');const url=intent?validateIntent(intent,ctx):destination;await page.goto(url,{timeout,waitUntil:'domcontentloaded'});if(!current(ctx)||page.url()!==url)throw Error('STALE');}
  catch {await quarantine('open_failed');throw Error('BROWSER_HOST_OPEN_FAILED');}
 },close:()=>shutdown('closed','owner_closed'),status:()=>({state,reason,dispatchedPosts:posts,blockedRequests:blocked,inFlight:pending.size,lastPost})};
}
