import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

export interface DesktopWorkOSCallback {code:string;codeVerifier:string;redirectUri:string}
export interface DesktopWorkOSAttempt {
 authorizationUrl:string;
 callback:Promise<DesktopWorkOSCallback>;
 cancel():Promise<void>;
}
const durationMs=5*60*1000;
const safePage='<!doctype html><html><head><meta charset="utf-8"><title>Spindle sign-in</title></head><body>You can close this window and return to Spindle.</body></html>';

/** A short-lived, isolated callback listener for system-browser authorization. */
export async function startDesktopWorkOSLogin(clientId:string,options:{attemptDurationMs?:number;callbackPort?:number}={}):Promise<DesktopWorkOSAttempt>{
 const lifetime=options.attemptDurationMs??durationMs,callbackPort=options.callbackPort??0;
 if(!/^client_[A-Za-z0-9]{1,200}$/.test(clientId)||!Number.isInteger(callbackPort)||callbackPort<0||callbackPort>65535||!Number.isFinite(lifetime)||lifetime<=0||lifetime>durationMs)throw new Error('WORKOS_DESKTOP_CONFIG_INVALID');
 const state=randomBytes(32).toString('base64url'),codeVerifier=randomBytes(32).toString('base64url');
 let active=true,redirectUri='',expectedHost='',timer:ReturnType<typeof setTimeout>|undefined;
 let resolveCallback!:(result:DesktopWorkOSCallback)=>void,rejectCallback!:(error:Error)=>void;
 const callback=new Promise<DesktopWorkOSCallback>((resolve,reject)=>{resolveCallback=resolve;rejectCallback=reject;});
 // The browser may outlive its caller; cancellation must not produce an unhandled rejection.
 void callback.catch(()=>{});
 const server=createServer({maxHeaderSize:16384},(req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Connection','close');
  const invalid=()=>{res.statusCode=400;res.end(safePage);};
  const target=req.url??'';
  if(!active||req.method!=='GET'||req.headers.host!==expectedHost||req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='host').length!==1||req.headers.origin!==undefined||target.length>8192||target.includes('#')||!target.startsWith('/auth/callback?'))return invalid();
  // Parse only an origin-form target with its exact unescaped callback path.
  const params=new URLSearchParams(target.slice('/auth/callback?'.length));
  const allowed=new Set(['state','code','error','error_description','error_uri']);
  if([...params.keys()].some(key=>!allowed.has(key)||params.getAll(key).length!==1))return invalid();
  const receivedState=params.get('state')??'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(receivedState)||!timingSafeEqual(Buffer.from(receivedState),Buffer.from(state)))return invalid();
  const code=params.get('code'),error=params.get('error');
  const bounded=(value:string,max:number)=>value.length>0&&value.length<=max&&!/[\u0000-\u0020\u007f]/.test(value);
  if(code!==null ? !bounded(code,4096)||error!==null||params.has('error_description')||params.has('error_uri') : error===null||!bounded(error,128))return invalid();
  if((params.get('error_description')?.length??0)>1024||(params.get('error_uri')?.length??0)>2048)return invalid();
  active=false;
  res.statusCode=200;
  res.once('finish',()=>{void stop(code===null?'WORKOS_DESKTOP_AUTH_FAILED':undefined,code===null?undefined:{code,codeVerifier,redirectUri});});
  res.once('close',()=>{void stop('WORKOS_DESKTOP_CALLBACK_FAILED');});
  res.once('error',()=>{void stop('WORKOS_DESKTOP_CALLBACK_FAILED');});
  res.end(safePage);
 });
 server.maxConnections=16;server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1;
 server.setTimeout(5000,socket=>socket.destroy());
 const close=():Promise<void>=>new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
 let stopping:Promise<void>|undefined;
 const stop=(reason?:string,result?:DesktopWorkOSCallback):Promise<void>=>{
  if(stopping)return stopping;
  active=false;if(timer)clearTimeout(timer);
  stopping=Promise.resolve().then(close).then(()=>{if(result)resolveCallback(result);else rejectCallback(new Error(reason??'WORKOS_DESKTOP_CALLBACK_FAILED'));});return stopping;
 };
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(callbackPort,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 }).catch(()=>{active=false;server.closeAllConnections();throw new Error('WORKOS_DESKTOP_LISTENER_FAILED');});
 server.on('error',()=>{void stop('WORKOS_DESKTOP_LISTENER_FAILED');});
 const address=server.address();
 if(!address||typeof address==='string'){await stop('WORKOS_DESKTOP_LISTENER_FAILED');throw new Error('WORKOS_DESKTOP_LISTENER_FAILED');}
 expectedHost=`127.0.0.1:${address.port}`;redirectUri=`http://${expectedHost}/auth/callback`;
 timer=setTimeout(()=>{void stop('WORKOS_DESKTOP_EXPIRED');},lifetime);
 const authorizationUrl=new URL('https://api.workos.com/user_management/authorize');
 authorizationUrl.search=new URLSearchParams({client_id:clientId,provider:'authkit',response_type:'code',redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(codeVerifier).digest('base64url'),code_challenge_method:'S256'}).toString();
 return {authorizationUrl:authorizationUrl.toString(),callback,cancel:()=>stop('WORKOS_DESKTOP_CANCELLED')};
}
