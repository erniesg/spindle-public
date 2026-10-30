import { createServer } from 'node:http';
import {paidTaskAdmission,PaidTaskQuotaFailure,validatePublicPaidAccess,type PaidTaskQuota,type PublicPaidAccess} from '../account/paid-task-quota.js';
export type {PublicPaidAccess} from '../account/paid-task-quota.js';
import {WorkOSProvider,type WorkOSConfig} from '../account/workos-provider.js';
import {WorkOSRoutes} from '../account/workos-routes.js';
import {issueWorkOSAccountSessions,type WorkOSAccountBinding} from '../account/workos-accounts.js';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { open, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EncryptedStore } from './store.js';
import {PreparationService,PreparationFailure,type PreparationConfig} from '../preparation/service.js';
import {SharedGoogle,GoogleAccountFailure,type PrivateGoogleConnection,type SharedGoogleConfig} from './google.js';
import {GoogleOAuthFailure,type GoogleCallbackReason} from '../connectors/google/oauth.js';
import {connectionsHtml,connectionsScript} from '../account/google-page.js';
import {portalAsset} from '../account/portal/assets.js';
import {newPomodoro,readPomodoro,commandPomodoro,PomodoroFailure,type PomodoroState} from '../pomodoro/service.js';
import {pomodoroAsset} from '../pomodoro/assets.js';
import {mailHtml,mailScript} from '../account/mail-page.js';
import {MailService,MailServiceFailure,type MailServiceConfig} from '../mail/service.js';
import {InboxService,InboxFailure,type EmailTriage} from '../inbox/service.js';
import { syncUserMemory, forgetUserMemorySource, userMemoryChanges, reconcileUserMemory, UserMemoryFailure, type UserMemoryState } from './user-memory.js';
import { assignment, labelEngine, projectSession, pruneInferences, range, type LabelState } from './session.js';
import { ClassificationHost, ClassificationFailure, revokeClassification, type ClassificationConfig, type ClassificationState } from '../account/classification-host.js';
import {handleEarnedLeisure,EarnedLeisureFailure} from '../account/earned-leisure-host.js';
import type {EarnedLeisureState} from '../blocking/earned-time.js';
import type { Labels } from '../classification/types.js';
import { validatePublicProxy, proxyClient, ClientWindows, type PublicProxyConfig } from './public-proxy.js';
import { evidenceRevision, evidenceFingerprint, preserveEvictedImage, expireContext, identifier, recordKey, validateOperation, type Entry, type Operation } from './types.js';
const passwordHash=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scryptCallback(password,salt,64,{N:131072,r:8,p:1,maxmem:160*1024*1024},(error,key)=>error?reject(error):resolve(key)));
const token=()=>randomBytes(32).toString('hex');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
interface Account { paidTasks?:PaidTaskQuota; workos?:WorkOSAccountBinding; id:string; name:string; salt:string; password:string; devices:{id:string;name:string;secret:string;lastUploadAt?:number}[]; entries:Entry[]; seq:number; labels?:LabelState; memory?:UserMemoryState; google?:PrivateGoogleConnection[]; pomodoro?:PomodoroState; classification?:ClassificationState; earnedLeisure?:EarnedLeisureState; documentNames?:string[] }
interface Session { workosSessionId?:string; account:string; csrf:string; expires:number; device?:string }
interface State { schema:1; accounts:Account[]; sessions:Record<string,Session> }
class Failure extends Error {constructor(readonly status:number,code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new Failure(status,code);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const BROWSER_ROUTES=new Set(['/preparation/browser-review','/preparation/browser-approve','/preparation/browser-reconcile']);
const sessionCookie=(cookie:string|undefined)=>{const values=(cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('spindle_session='));return values.length===1?/^spindle_session=([a-f0-9]{64})$/.exec(values[0]):null;};
export async function startTrackingServer(directory:string,key:Buffer,port=0,publicOrigin?:string,googleConfig?:SharedGoogleConfig,preparationConfig?:PreparationConfig,mailConfig?:MailServiceConfig,workosConfig?:WorkOSConfig,classificationConfig?:ClassificationConfig,publicProxy?:PublicProxyConfig,publicPaidAccess?:PublicPaidAccess,inboxConfig?:{triage(email:{from:string;subject:string;body:string}):Promise<EmailTriage>;log?:(record:Record<string,unknown>)=>void}){
  // Explicit trusted TLS-proxy configuration, never inferred from forwarding
  // headers. This does not expose a socket: binding remains loopback-only.
  if(publicOrigin!==undefined){try{const u=new URL(publicOrigin);if(u.origin!==publicOrigin||u.protocol!=='https:'||u.username||u.password||u.hostname.includes('*'))throw Error();}catch{throw Error('PUBLIC_HTTPS_ORIGIN_REQUIRED');}}
  validatePublicProxy(publicProxy,publicOrigin);
  const paidAccess=validatePublicPaidAccess(publicPaidAccess)??(publicOrigin?{mode:'connection-only'} as const:undefined);
  if(paidAccess?.mode==='connection-only'&&mailConfig)throw Error('PUBLIC_PILOT_MAIL_DISABLED');
  if(paidAccess?.mode==='connection-only')preparationConfig=undefined;
  const paidOwner=(owner:string,kind:'PREPARATION'|'MAIL'='PREPARATION')=>{if(paidAccess&&(paidAccess.mode==='connection-only'||paidAccess.accountId!==owner))fail(paidAccess.mode==='connection-only'?503:403,paidAccess.mode==='connection-only'?kind+'_NOT_CONFIGURED':kind+'_PUBLIC_PAID_ACCESS_DENIED');};
  const store=new EncryptedStore<State>(directory,key,()=>({schema:1,accounts:[],sessions:{}}));
  const classification=classificationConfig?new ClassificationHost(classificationConfig):undefined;
  // Committed session/consent/evidence writes fence live classification work.
  const observed=<R>(fn:(state:State)=>R)=>{let seen:State|undefined;return store.transaction(s=>{seen=s;return fn(s);}).then(r=>{classification?.observe(seen!);return r;});};
  // Validate confidential Web configuration before acquiring the runtime lock.
  let origin=publicOrigin??'',inflight=0;let authBusy=false,closing=false;
  const listenHost=workosConfig&&!publicOrigin&&new URL(workosConfig.webRedirectUri).hostname==='[::1]'?'::1':'127.0.0.1';
  const loopbackHost=listenHost==='::1'?'[::1]':'127.0.0.1';
  if(workosConfig){const expected=publicOrigin??(port>0?`http://${loopbackHost}:${port}`:undefined);if(!expected||workosConfig.webRedirectUri!==expected+'/auth/workos/callback')throw Error('WORKOS_EXACT_CALLBACK_REQUIRED');}
  const workos=workosConfig?new WorkOSRoutes(new WorkOSProvider(workosConfig),async(identity,count,previousCookie?:string)=>observed(state=>{
    if(closing)throw Error('WORKOS_CLOSED');
    const sessions=issueWorkOSAccountSessions(state,identity,workosConfig.issuer,count);
    const previous=sessionCookie(previousCookie);if(previous)delete state.sessions[hash(previous[1]!)];
    return sessions;
  }),workosConfig):undefined;
  const google=googleConfig?new SharedGoogle(store,googleConfig,()=>origin):undefined;
  if(preparationConfig&&!google)throw Error('PREPARATION_GOOGLE_REQUIRED');
  if(mailConfig&&!google)throw Error('MAIL_GOOGLE_REQUIRED');
  let preparation:PreparationService|undefined,mail:MailService|undefined;
  const admitPaidTask=publicProxy||paidAccess?paidTaskAdmission(store,Date.now,paidAccess):undefined;
  // Verify key/store before accepting connections. No external HTTP binding option.
  await store.transaction(s=>{if(s.schema!==1)throw Error('STORE_VERSION');},false);
  const lockPath=join(directory,'server.lock'),lock=await open(lockPath,'wx',0o600);
  try{await lock.writeFile(String(process.pid));preparation=preparationConfig?new PreparationService(preparationConfig,(owner,session,connection,root)=>{paidOwner(owner);return google!.preparationBinding(owner,session,connection,root);},admitPaidTask,owner=>store.transaction(s=>[...(s.accounts.find(x=>x.id===owner)?.documentNames??[])],false)):undefined;mail=mailConfig?new MailService(mailConfig,(owner,session,connection)=>{paidOwner(owner,'MAIL');return google!.mailBinding(owner,session,connection);},admitPaidTask):undefined;}
  catch(error){await Promise.allSettled([mail?.close(),preparation?.close()]);await lock.close();await rm(lockPath,{force:true});throw error;}
  // Inbox automation exists only when preparation, mail and Google are all configured for this owner.
  const inbox=preparation&&mail&&google&&inboxConfig?new InboxService({directory,triage:inboxConfig.triage,log:inboxConfig.log,
   google:{handle:(o,sn,p,d)=>google!.handle(o,sn,p,d),gmailToken:(o,sn,c)=>google!.gmailToken(o,sn,c)},
   preparation:{handle:(o,sn,p,d,x)=>preparation!.track(preparation!.handle(o,sn,p,d,x))},mail:{handle:(o,sn,p,d)=>mail!.handle(o,sn,p,d)}}):undefined;
  // Without a proxy contract every request is one legacy client: the unchanged global 20/min.
  // With it, each verified edge client tag has its own window; AuthBusy still serializes scrypt.
  const authAttempts=new ClientWindows(20,60000),beginAttempts=new ClientWindows(4,5*60000);
  const server=createServer(async(req,res)=>{
    const reply=(status:number,data:unknown,cookie?:string)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})});res.end(JSON.stringify(data));};
    if(inflight>=8){reply(503,{code:'BUSY'});req.resume();return;}inflight++;
    let callbackNavigation=false,callbackRequest=false;
    const completion=(status:number,code:string,reason?:GoogleCallbackReason)=>{
      // Only fixed local categories. No callback/provider input is interpolated.
      const success=code==='GOOGLE_CONNECTED';
      // Straight back into the app; the Connections view reads the fixed outcome from the fragment.
      void status;void reason;
      res.writeHead(303,{'Location':'/portal#connections/'+(success?'connected':'failed'),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end();
    };
    try{
      const client=publicProxy?proxyClient(req,publicProxy.token):'';
      if(client===undefined)fail(403,'PROXY_DENIED');
      if(req.headers.host!==new URL(origin).host)fail(403,'ORIGIN_DENIED');
      // Public, data-free top navigation and OAuth callback only. No global Origin exception.
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>16384)fail(400,'INVALID_PATH');
      const url=new URL(req.url!,origin);
      if(['/auth/workos/config','/auth/workos/begin','/auth/workos/callback'].includes(url.pathname)){
        if(!workos){reply(503,{configured:false,code:'WORKOS_NOT_CONFIGURED'});return;}
        // Only the exact, state-and-browser-bound GET callback admits provider navigation.
        // All other app Origin/CSRF rules remain in place below.
        if(req.method!=='GET'||req.url!.split('?')[0]!==url.pathname)fail(403,'WORKOS_CALLBACK_DENIED');
        // Each begin holds a pending-table slot for 5 minutes; callbacks remain state-bound only.
        if(publicProxy&&url.pathname==='/auth/workos/begin'&&!beginAttempts.admit(client!))fail(429,'AUTH_BUSY');
        await workos.handle(req,res,url);return;
      }
      if(url.pathname==='/portal'||url.pathname.startsWith('/portal/')){
        if(req.method!=='GET'||url.search||req.headers.origin&&req.headers.origin!==origin)fail(403,'ORIGIN_DENIED');
        const asset=await portalAsset(url.pathname);if(!asset)fail(404,'NOT_FOUND');
        res.writeHead(200,{'Content-Type':asset!.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src blob:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(asset!.body);return;
      }
      if(url.pathname==='/oauth/callback'){
        if(req.method!=='GET'||req.headers.origin||req.url!.split('?')[0]!=='/oauth/callback')fail(403,'CALLBACK_DENIED');
        callbackRequest=true;callbackNavigation=req.headers.accept?.includes('text/html')??false;
        if(!google)fail(503,'GOOGLE_NOT_CONFIGURED');
        await google!.track(google!.callback(url));
        if(callbackNavigation)completion(200,'GOOGLE_CONNECTED');
        else {res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end('Connected. Return to Spindle connections.');}return;
      }
      if(['/mail','/mail.js'].includes(url.pathname)){
        if(req.method!=='GET'||url.search||req.headers.origin&&req.headers.origin!==origin)fail(403,'ORIGIN_DENIED');
        res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(url.pathname.endsWith('.js')?mailScript:mailHtml);return;
      }
      if(['/connections','/connections.js','/connections-client.js'].includes(url.pathname)){
        if(req.method!=='GET'||url.search||req.headers.origin&&req.headers.origin!==origin)fail(403,'ORIGIN_DENIED');
        res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https://www.googleapis.com https://content.googleapis.com; img-src blob:; frame-src https://docs.google.com https://drive.google.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(url.pathname==='/connections-client.js'?await readFile(new URL('../account/client.js',import.meta.url),'utf8'):url.pathname.endsWith('.js')?connectionsScript:connectionsHtml);return;
      }
      // Same-origin browser GETs omit Origin; writes still require it and CSRF.
      // OAuth callback navigation above is the narrow state-bound exception.
      if(req.headers.origin!==undefined&&req.headers.origin!==origin||req.method==='POST'&&req.headers.origin!==origin||req.headers.origin===undefined&&req.headers['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(String(req.headers['sec-fetch-site'])))fail(403,'ORIGIN_DENIED');
      // A download navigation cannot carry a CSRF header. Admit only same-origin
      // browser requests, then bind the stored artifact to the current session owner.
      if(url.pathname==='/preparation/download'){
        if(req.method!=='GET'||req.headers['sec-fetch-site']!=='same-origin'||req.headers.origin&&req.headers.origin!==origin)fail(403,'ORIGIN_DENIED');
        if([...url.searchParams.keys()].length!==2||url.searchParams.getAll('taskId').length!==1||url.searchParams.getAll('artifactId').length!==1)fail(400,'INVALID_DOWNLOAD');
        const match=sessionCookie(req.headers.cookie);if(!match)fail(401,'SIGNIN_REQUIRED');
        const owner=await store.transaction(s=>{const session=s.sessions[hash(match![1]!)];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');return session.account;},false);
        paidOwner(owner);
        if(!preparation)fail(503,'PREPARATION_NOT_CONFIGURED');
        const artifact=await preparation!.track(preparation!.handle(owner,hash(match![1]!),'/preparation/artifact',{taskId:url.searchParams.get('taskId'),artifactId:url.searchParams.get('artifactId')})) as {binary:Buffer;mimeType:string};
        const extension:Record<string,string>={'application/pdf':'.pdf','image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','application/json':'.json','text/plain':'.txt'};
        const filename='spindle-artifact'+(extension[artifact.mimeType]??'.bin');
        res.writeHead(200,{'Content-Type':artifact.mimeType,'Content-Length':artifact.binary.length,'Content-Disposition':'attachment; filename='+filename,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(artifact.binary);return;
      }
      if(!['POST','GET'].includes(req.method??''))fail(405,'METHOD_DENIED');
      if(req.method==='GET'&&!url.search){
        const asset=await pomodoroAsset(url.pathname);
        if(asset){res.writeHead(200,{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(asset.body);return;}
      }
      let data:Record<string,unknown>={};
      if(req.method==='POST'){
        if(req.headers['content-type']!=='application/json')fail(415,'JSON_REQUIRED');
        const chunks:Buffer[]=[];let size=0;
        // Owner browser review/approval bodies are a few hundred bytes; bound them like other control requests.
        const bound=['/user-memory/sync','/user-memory/forget-source'].includes(url.pathname)?512000:BROWSER_ROUTES.has(url.pathname)?65536:3_000_000;
        for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>bound)fail(413,'BODY_BOUND');chunks.push(Buffer.from(chunk));}
        try{const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString());if(!object(parsed))throw Error();data=parsed;}catch{fail(400,'INVALID_JSON');}
      }
      if(url.pathname==='/auth/workos/native'){
        if(!workos){reply(503,{configured:false,code:'WORKOS_NOT_CONFIGURED'});return;}
        if(!authAttempts.admit(client!))fail(429,'AUTH_BUSY');
        await workos.handle(req,res,url,data);return;
      }
      if(req.method==='POST'&&['/register','/signin'].includes(url.pathname)){
        if(authBusy||!authAttempts.admit(client!))fail(429,'AUTH_BUSY');
        if(typeof data.name!=='string'||!/^[a-z0-9._-]{3,64}$/.test(data.name)||typeof data.password!=='string'||data.password.length<12||data.password.length>256||Object.keys(data).length!==2)fail(400,'INVALID_CREDENTIALS');
        // The exact WorkOS-derived name form (workos-accounts.ts) is reserved; existing password signin is unchanged.
        if(url.pathname==='/register'&&/^workos\.[a-f0-9]{32}$/.test(data.name as string))fail(400,'ACCOUNT_NAME_RESERVED');
        authBusy=true;
        try{
          const name=data.name as string,password=data.password as string;
          // One expensive authentication at a time, bounded scrypt memory. A dummy
          // derivation prevents missing-name signin from skipping password work.
          const existing=await store.transaction(s=>s.accounts.find(a=>a.name===name),false);
          const salt=existing?.salt??token();
          const derived=(await passwordHash(password,salt)).toString('hex');
          const sid=token(),csrf=token();
          await observed(s=>{
            let account=s.accounts.find(a=>a.name===name);
            if(url.pathname==='/register'){
              if(account)fail(409,'ACCOUNT_EXISTS');if(s.accounts.length>=100)fail(507,'ACCOUNT_BOUND');
              account={id:randomUUID(),name,salt,password:derived,devices:[],entries:[],seq:0};s.accounts.push(account);
            }else if(!account||!equal(derived,account.password))fail(401,'WRONG_CREDENTIALS');
            for(const [id,v] of Object.entries(s.sessions))if(v.expires<=Date.now())delete s.sessions[id];
            if(Object.keys(s.sessions).length>=500)fail(503,'SESSION_BOUND');
            const previous=sessionCookie(req.headers.cookie);if(previous)delete s.sessions[hash(previous[1]!)];
            s.sessions[hash(sid)]={account:account!.id,csrf,expires:Date.now()+12*3600000};
          });
          reply(200,{csrf},`spindle_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin?'; Secure':''}`);return;
        }finally{authBusy=false;}
      }
      const match=sessionCookie(req.headers.cookie);
      if(!match)fail(401,'SIGNIN_REQUIRED');
      if(url.pathname.startsWith('/mail/')){
        if(req.method!=='POST'||url.search)fail(400,'MAIL_POST_REQUIRED');
        const owner=await store.transaction(s=>{const session=s.sessions[hash(match![1]!)];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');if(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session.csrf))fail(403,'CSRF_DENIED');return session.account;},false);
        paidOwner(owner,'MAIL');
        if(!mail)fail(503,'MAIL_NOT_CONFIGURED');
        reply(url.pathname==='/mail/request'?202:200,await google!.track(mail!.handle(owner,hash(match![1]!),url.pathname,data)));return;
      }
      if(url.pathname.startsWith('/preparation/')){
        if(req.method!=='POST'||url.search)fail(400,'PREPARATION_POST_REQUIRED');
        const owner=await store.transaction(s=>{const session=s.sessions[hash(match![1]!)];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');if(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session.csrf))fail(403,'CSRF_DENIED');return session.account;},false);
        if(paidAccess&&url.pathname==='/preparation/config'){
          if(Object.keys(data).length)fail(400,'INVALID_PREPARATION_FIELDS');
          if(paidAccess.mode==='connection-only'||paidAccess.accountId!==owner||!preparation){reply(200,{configured:false,access:paidAccess.mode,processingPaused:true,code:'PREPARATION_NOT_CONFIGURED'});return;}
          const configuration=await preparation.track(preparation.handle(owner,hash(match![1]!),url.pathname,data));
          reply(200,{...configuration as object,access:paidAccess.mode});return;
        }
        paidOwner(owner);
        if(!preparation)fail(503,'PREPARATION_NOT_CONFIGURED');
        // A client disconnect is a closed response that never finished; normal completion is not one.
        const disconnect=new AbortController(),gone=()=>{if(!res.writableEnded)disconnect.abort();};if(res.closed)gone();else res.once('close',gone);
        const result=await preparation!.track(preparation!.handle(owner,hash(match![1]!),url.pathname,data,{signal:disconnect.signal}));
        if(url.pathname==='/preparation/artifact'){
          const artifact=result as {binary:Buffer;mimeType:string};
          res.writeHead(200,{'Content-Type':artifact.mimeType,'Content-Length':artifact.binary.length,'Content-Disposition':'attachment; filename="spindle-artifact"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(artifact.binary);
        }else reply(['/preparation/request','/preparation/browser-approve','/preparation/browser-reconcile'].includes(url.pathname)?202:200,result);return;
      }
      if(url.pathname.startsWith('/inbox/')){
        if(req.method!=='POST'||url.search)fail(400,'INBOX_POST_REQUIRED');
        const owner=await store.transaction(s=>{const session=s.sessions[hash(match![1]!)];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');if(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session.csrf))fail(403,'CSRF_DENIED');return session.account;},false);
        if(!inbox){reply(200,{watching:false,available:false,items:[]});return;}
        paidOwner(owner);
        reply(200,await inbox.handle(owner,hash(match![1]!),url.pathname,data));return;
      }
      if(url.pathname.startsWith('/google/')){
        if(req.method!=='POST'||url.search)fail(400,'GOOGLE_POST_REQUIRED');
        if(!google)fail(503,'GOOGLE_NOT_CONFIGURED');
        const owner=await store.transaction(s=>{const session=s.sessions[hash(match![1]!)];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');if(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session.csrf))fail(403,'CSRF_DENIED');return session.account;},false);
        reply(200,await google!.track(google!.handle(owner,hash(match![1]!),url.pathname,data)));return;
      }
      if(url.pathname.startsWith('/classification/')){
        if(req.method!=='POST'||url.search)fail(400,'CLASSIFICATION_POST_REQUIRED');
        // Authentication, CSRF and owned-record admission precede provider creation or cost.
        const sid=hash(match![1]!);let job:Parameters<ClassificationHost['run']>[0]|undefined;
        try{
          const step=await observed(s=>{
            const session=s.sessions[sid];if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');
            if(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session!.csrf))fail(403,'CSRF_DENIED');
            const a=s.accounts.find(v=>v.id===session!.account)!;
            if(!classification){if(url.pathname==='/classification/config'&&!Object.keys(data).length)return {value:{configured:false}};return fail(503,'CLASSIFICATION_NOT_CONFIGURED');}
            const out=classification.handle(s,a,sid,url.pathname,data);job=out.job;return out;
          });
          if(!step.job){reply(200,step.value);return;}
          const result=await classification!.run(step.job);
          reply(200,await observed(s=>classification!.persist(s,step.job!,result)));return;
        }finally{if(job)classification!.release(job);}
      }
      const result=await observed(s=>{
        const session=s.sessions[hash(match![1]!)];
        if(!session||session.expires<=Date.now())fail(401,'SIGNIN_REQUIRED');
        if(req.method==='POST'&&!['/session','/pomodoro/session'].includes(url.pathname)&&(typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session!.csrf)))fail(403,'CSRF_DENIED');
        const a=s.accounts.find(v=>v.id===session!.account)!;
        // Expiry is a durable tombstone too, so offline delivery cannot revive it.
        for(const entry of a.entries)if(!entry.deleted&&entry.record!.expiresAt<=Date.now()){delete entry.record;entry.deleted=true;entry.seq=++a.seq;}
        for(const entry of a.entries)if(entry.record&&expireContext(entry.record))entry.seq=++a.seq;
        if(a.labels)for(const [key] of Object.entries(a.labels.corrections)){
          const r=a.entries.find(e=>e.key===key)?.record;
          if(!r||r.visit.expiresAt<=Date.now())delete a.labels.corrections[key];
        }
        if(a.memory)reconcileUserMemory(a.memory,a.id,a.entries);
        if(req.method==='POST'&&url.pathname==='/logout'){delete s.sessions[hash(match![1]!)];return {ok:true};}
        if(req.method==='POST'&&url.pathname==='/devices'){
          if(typeof data.name!=='string'||data.name.length<1||data.name.length>80)fail(400,'INVALID_DEVICE');
          if(data.deviceId!==undefined){const d=a.devices.find(v=>v.id===data.deviceId);if(!d||typeof data.secret!=='string'||!equal(hash(data.secret),d.secret))fail(403,'DEVICE_DENIED');session!.device=d!.id;return {deviceId:d!.id,name:d!.name};}
          if(a.devices.length>=16)fail(507,'DEVICE_BOUND');const secret=token(),id=randomUUID();a.devices.push({id,name:data.name as string,secret:hash(secret)});session!.device=id;return {deviceId:id,secret,name:data.name};
        }
        if(['GET','POST'].includes(req.method??'')&&url.pathname==='/session'){
          // Both existing bootstrap clients read the same authenticated session.
          if(url.search||Object.keys(data).length)fail(400,'INVALID_SESSION_QUERY');
          return {account:{id:a.id,name:a.name},csrf:session!.csrf,deviceId:session!.device??null};
        }
        if(url.pathname==='/user-memory/sync'&&req.method==='POST'){
          if(url.search)fail(400,'INVALID_MEMORY_QUERY');
          return syncUserMemory(a.memory??={entries:[],sequence:0,operationReceipts:[]},a.id,data,a.entries);
        }
        if(url.pathname==='/user-memory/forget-source'&&req.method==='POST'){
          if(url.search)fail(400,'INVALID_MEMORY_QUERY');
          return forgetUserMemorySource(a.memory??={entries:[],sequence:0,operationReceipts:[]},a.id,data,a.entries);
        }
        if(url.pathname==='/user-memory/changes'&&req.method==='GET')return userMemoryChanges(a.memory??={entries:[],sequence:0,operationReceipts:[]},url.searchParams);
        if(req.method==='GET'&&url.pathname==='/user-memory/activity'){
          if([...url.searchParams.keys()].some(k=>!['cursor','limit'].includes(k)||url.searchParams.getAll(k).length!==1))fail(400,'INVALID_CURSOR');
          const raw=url.searchParams.get('cursor')??'0',limitRaw=url.searchParams.get('limit')??'16';
          if(!/^(0|[1-9]\d{0,15})$/.test(raw)||! /^[1-9]\d?$/.test(limitRaw))fail(400,'INVALID_CURSOR');
          const cursor=Number(raw),limit=Number(limitRaw);
          if(!Number.isSafeInteger(cursor)||cursor>a.seq||limit>16)fail(400,'INVALID_CURSOR');
          const selected=a.entries.filter(e=>e.seq>cursor).sort((x,y)=>x.seq-y.seq);
          const entries=[];let bytes=0;
          for(const e of selected){
            const r=e.record;
            // Explicit allowlist: no pixels, URLs, capture metadata or second clock.
            const projected={key:e.key,deviceId:e.deviceId,recordingId:e.recordingId,visitId:e.visitId,seq:e.seq,deleted:e.deleted,...(r?{record:{schema:r.schema,deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,revision:r.revision,consentRevision:r.consentRevision,policyRevision:r.policyRevision,wallAnchor:r.wallAnchor,monotonicAnchor:r.monotonicAnchor,observedAt:r.observedAt,expiresAt:r.expiresAt,scopes:{recording:r.scopes.recording,retention:r.scopes.retention,upload:r.scopes.upload},visit:{id:r.visit.id,title:r.visit.title,text:r.visit.text,expiresAt:r.visit.expiresAt}}}:{})};
            const size=Buffer.byteLength(JSON.stringify(projected));if(entries.length>=limit||bytes+size>990000)break;entries.push(projected);bytes+=size;
          }
          return {entries,cursor:entries.at(-1)?.seq??cursor,hasMore:selected.length>entries.length};
        }
        // Read-only bootstrap uses authenticated cookie + exact Origin/Host;
        // CSRF cannot be supplied until this response. Existing routes are unchanged.
        if(req.method==='POST'&&url.pathname==='/pomodoro/session'){
          if(url.search||Object.keys(data).length)fail(400,'INVALID_POMODORO_QUERY');
          return {account:{id:a.id,name:a.name},csrf:session!.csrf};
        }
        if(req.method==='GET'&&url.pathname==='/pomodoro'||req.method==='POST'&&url.pathname==='/pomodoro/read'){
          if(url.search||Object.keys(data).length)fail(400,'INVALID_POMODORO_QUERY');
          return {...readPomodoro(a.pomodoro??=newPomodoro()),accountId:a.id};
        }
        if(req.method==='POST'&&url.pathname==='/pomodoro/command'){
          if(url.search)fail(400,'INVALID_POMODORO_QUERY');
          return {...commandPomodoro(a.pomodoro??=newPomodoro(),data),accountId:a.id};
        }
        // Owner-entered names as printed on their documents; OCR values a letter or two away stay unresolved for review.
        if(url.pathname==='/profile/document-names'||url.pathname==='/profile/document-names/save'){
          if(req.method!=='POST'||url.search)fail(400,'INVALID_PROFILE_QUERY');
          if(url.pathname==='/profile/document-names'){if(Object.keys(data).length)fail(400,'INVALID_PROFILE_QUERY');return {names:a.documentNames??[]};}
          const names=data.names;
          if(Object.keys(data).join()!=='names'||!Array.isArray(names)||names.length>8||names.some(n=>typeof n!=='string'||!/^\p{L}[\p{L}\p{M} .'-]{0,79}$/u.test(n.trim())))fail(400,'INVALID_DOCUMENT_NAMES');
          a.documentNames=[...new Set((names as string[]).map(n=>n.trim().replace(/\s+/g,' ')))];return {names:a.documentNames};
        }
        if(url.pathname.startsWith('/earned-leisure/')){
          if(req.method!=='POST'||url.search)fail(400,'INVALID_EARNED_QUERY');
          return handleEarnedLeisure(a,session!.device,url.pathname,data);
        }
        const selectedDevice=url.searchParams.get('deviceId');
        if(selectedDevice!==null&&(!identifier(selectedDevice)||!a.devices.some(d=>d.id===selectedDevice)))fail(404,'DEVICE_NOT_FOUND');
        const selectedEntries=selectedDevice===null?a.entries:a.entries.filter(e=>e.deviceId===selectedDevice);
        const labels=a.labels??={local:false,corrections:{}};
        for(const [key,c] of Object.entries(labels.corrections)){const entry=a.entries.find(e=>e.key===key);if(!entry?.record||entry.deleted||evidenceRevision(entry.record)!==c.evidenceRevision)delete labels.corrections[key];}
        pruneInferences(a.entries,labels);
        if(req.method==='POST'&&url.pathname==='/processing'){
          if(Object.keys(data).length!==1||typeof data.local!=='boolean')fail(400,'INVALID_PROCESSING');
          labels.local=data.local as boolean;if(!labels.local)revokeClassification(a);return {local:labels.local};
        }
        if(req.method==='GET'&&url.pathname==='/sessions'){
          let bounds;try{bounds=range(url.searchParams.get('from'),url.searchParams.get('to'));}catch{fail(400,'INVALID_RANGE');}
          let result;
          try{result=projectSession(a.id,selectedEntries,labels,bounds!.from,bounds!.to);}catch(e){if(e instanceof Error&&e.message==='RANGE_BOUND')fail(413,'RANGE_BOUND');throw e;}
          if(Buffer.byteLength(JSON.stringify(result))>3_000_000)fail(413,'RANGE_BOUND');return result;
        }
        if(req.method==='POST'&&url.pathname==='/corrections'){
          if(Object.keys(data).some(k=>!['key','evidenceRevision','expectedRevision','labels','undo'].includes(k))||typeof data.key!=='string'||!Number.isSafeInteger(data.evidenceRevision)||!Number.isSafeInteger(data.expectedRevision)||!(data.undo===true&&data.labels===undefined||data.undo===undefined&&object(data.labels)))fail(400,'INVALID_CORRECTION');
          const entry=a.entries.find(e=>e.key===data.key&&!e.deleted&&e.record);
          if(!entry)fail(404,'EVIDENCE_NOT_FOUND');
          const r=entry!.record!,previous=labels.corrections[entry!.key];
          if(r.visit.expiresAt<=Date.now())fail(410,'CONTEXT_EXPIRED');
          if(data.evidenceRevision!==evidenceRevision(r)||data.expectedRevision!==(previous?.revision??0))fail(409,'STALE_CORRECTION');
          if(!labels.local)fail(403,'PROCESSING_OFF');
          const engine=labelEngine(a.id,r),history=previous?.history??[];
          try{
            for(const value of history)engine.correct(r.recordingId,r.visitId,value);
            if(data.undo===true)engine.undo(r.recordingId,r.visitId);
            else {if(!object(data.labels)||Object.keys(data.labels).sort().join(',')!=='activityId,categoryId,relatedIds')throw Error();engine.correct(r.recordingId,r.visitId,data.labels as unknown as Labels);}
          }catch{fail(400,'INVALID_LABELS');}
          labels.corrections[entry!.key]={evidenceRevision:evidenceRevision(r),revision:(previous?.revision??0)+1,history:data.undo===true?history.slice(0,-1):[...history,engine.inspect(r.recordingId,r.visitId).labels]};
          return {key:entry!.key,label:assignment(a.id,r,labels,entry!.key)};
        }
        if(req.method==='GET'&&url.pathname==='/devices')return {devices:a.devices.map(d=>({id:d.id,name:d.name,lastUploadAt:d.lastUploadAt??null,pending:'unknown',uploadError:'unknown'}))};
        if(req.method==='POST'&&url.pathname==='/sync'){
          if(!Array.isArray(data.operations)||data.operations.length<1||data.operations.length>16||Object.keys(data).length!==1)fail(400,'BATCH_BOUND');
          const operations=data.operations as unknown[];for(const op of operations){try{validateOperation(op);}catch{fail(400,'INVALID_OPERATION');}}
          if(!session!.device&&(operations as Operation[]).some(op=>!op.delete))fail(403,'DEVICE_REQUIRED');
          for(const op of operations as Operation[])if(op.record)expireContext(op.record);
          const acknowledged:string[]=[];
          for(const op of operations as Operation[]){
            const k=recordKey(op),entry=a.entries.find(e=>e.key===k);
            if(op.record){
              preserveEvictedImage(op.record,entry?.deleted?undefined:entry?.record);
              op.record.evidenceRevision=entry?.record&&evidenceFingerprint(op.record)===evidenceFingerprint(entry.record)?evidenceRevision(entry.record):op.record.revision;
            }
            if(!a.devices.some(d=>d.id===op.deviceId)||!op.delete&&op.deviceId!==session!.device)fail(403,'DEVICE_DENIED');
            if(!entry&&a.entries.length>=10000)fail(507,'HISTORY_BOUND');
            if(op.delete){if(entry){if(!entry.deleted){delete entry.record;entry.deleted=true;entry.seq=++a.seq;}}else a.entries.push({key:k,deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,seq:++a.seq,deleted:true});}
            else if(!entry)a.entries.push({key:k,deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,seq:++a.seq,deleted:false,record:op.record});
            else if(!entry.deleted){
              if(op.record!.revision===entry.record!.revision&&JSON.stringify({...op.record,evidenceRevision:undefined})!==JSON.stringify({...entry.record,evidenceRevision:undefined}))fail(409,'REVISION_CONFLICT');
              if(op.record!.revision>entry.record!.revision){
                if(op.record!.correctionRevision<entry.record!.correctionRevision||op.record!.labelRevision<entry.record!.labelRevision)fail(409,'STALE_LABEL_REVISION');
                entry.record=op.record;entry.seq=++a.seq;
              }
            }
            acknowledged.push(op.id);
          }
          for(const [key,c] of Object.entries(labels.corrections)){const e=a.entries.find(e=>e.key===key);if(!e?.record||e.deleted||evidenceRevision(e.record)!==c.evidenceRevision)delete labels.corrections[key];}
          pruneInferences(a.entries,labels);
          if(a.memory)reconcileUserMemory(a.memory,a.id,a.entries);
          if((operations as Operation[]).some(op=>op.record))a.devices.find(d=>d.id===session!.device)!.lastUploadAt=Date.now();
          return {acknowledged};
        }
        if(req.method==='GET'&&url.pathname==='/history'){
          const raw=url.searchParams.get('cursor')??'0',limit=Number(url.searchParams.get('limit')??'16');
          if(!/^\d{1,15}$/.test(raw)||!Number.isSafeInteger(limit)||limit<1||limit>16||Number(raw)>a.seq)fail(400,'INVALID_CURSOR');
          const entries=selectedEntries.filter(e=>e.seq>Number(raw)).sort((x,y)=>x.seq-y.seq);const page:Entry[]=[];let bytes=0;
          for(const e of entries){const n=Buffer.byteLength(JSON.stringify(e));if(page.length>=limit||bytes+n>3_000_000)break;page.push(e);bytes+=n;}
          return {entries:page,cursor:page.at(-1)?.seq??Number(raw),hasMore:entries.length>page.length};
        }
        fail(404,'NOT_FOUND');
      });reply(200,result);
    }catch(e){
      const typed=e instanceof PaidTaskQuotaFailure||e instanceof Failure||e instanceof UserMemoryFailure||e instanceof GoogleAccountFailure||e instanceof GoogleOAuthFailure||e instanceof PreparationFailure||e instanceof PomodoroFailure||e instanceof MailServiceFailure||e instanceof ClassificationFailure||e instanceof EarnedLeisureFailure||e instanceof InboxFailure;
      const status=typed?e.status:503,code=e instanceof GoogleOAuthFailure?e.code:typed?e.message:'STORE_OR_REQUEST_UNAVAILABLE';
      if(callbackNavigation)completion(status,code,e instanceof GoogleOAuthFailure?e.reason:undefined);
      else reply(status,{code,...(e instanceof GoogleOAuthFailure?{stage:e.stage,...(e.reason?{reason:e.reason}:{})}:{}),...(callbackRequest?{action:'RETURN_TO_CONNECTIONS'}:{})});
    }
    finally{inflight--;}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxHeadersCount=32;server.maxConnections=16;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,listenHost,resolve);});}catch(e){await Promise.allSettled([mail?.close(),preparation?.close()]);await lock.close();await rm(lockPath,{force:true});throw e;}const listenOrigin=`http://${loopbackHost}:${(server.address() as AddressInfo).port}`;origin=publicOrigin??listenOrigin;
  return {origin,listenOrigin,close:async()=>{closing=true;workos?.close();classification?.close();const results=await Promise.allSettled([inbox?.close(),mail?.close(),preparation?.close()]);try{await google?.close();}finally{server.closeAllConnections();try{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await store.settle();}finally{await lock.close();await rm(lockPath,{force:true});}}if(results.some(r=>r.status==='rejected'))throw Error('APPLICATION_SHUTDOWN_FAILED');}};
}
