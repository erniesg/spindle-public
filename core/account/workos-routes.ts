import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {WorkOSIdentity} from './workos-provider.js';

export interface SpindleWorkOSSession {
  account: {id:string;name:string};
  cookie:string;
  csrf:string;
}
export interface WorkOSRouteProvider {
  authorizationUrl(redirectUri:string,state:string,codeChallenge:string):string;
  exchange(code:string,codeVerifier:string):Promise<WorkOSIdentity>;
}
export interface WorkOSRouteConfig {clientId:string;webRedirectUri:string}
type Issue = (identity:WorkOSIdentity,count:1|2,previousCookie?:string)=>Promise<SpindleWorkOSSession[]>;
type Attempt = {binding:string;verifier:string;expires:number};
const CALLBACK='/auth/workos/callback';
const BINDING='spindle_workos_binding';
const MAX_ATTEMPTS=64;
const TTL=5*60_000;
const token=()=>randomBytes(32).toString('base64url');
function equal(a:string,b:string):boolean {
 const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
function cookieBinding(req:IncomingMessage):string|undefined {
 const entries=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(BINDING+'='));
 if(entries.length!==1)return; const value=entries[0].slice(BINDING.length+1);
 return /^[A-Za-z0-9_-]{43}$/.test(value)?value:undefined;
}
/** Adapter for the existing server; Host/Origin/body limits remain enforced there. */
export class WorkOSRoutes {
 private readonly attempts=new Map<string,Attempt>();
 private closed=false;
 private readonly config:WorkOSRouteConfig;
 private readonly origin:string;
 private readonly secure:string;
 constructor(private readonly provider:WorkOSRouteProvider,private readonly issue:Issue,config:WorkOSRouteConfig){
  const callback=new URL(config.webRedirectUri);
  if(callback.pathname!==CALLBACK||callback.search||callback.hash||callback.username||callback.password||
    callback.href!==config.webRedirectUri||!/^client_[A-Za-z0-9]+$/.test(config.clientId)||
    !(callback.protocol==='https:'||(callback.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(callback.hostname))))
    throw new Error('INVALID_WORKOS_ROUTE_CONFIG');
  this.config={...config};this.origin=callback.origin;this.secure=callback.protocol==='https:'?'; Secure':'';
 }
 close():void {this.closed=true;this.attempts.clear();}
 async handle(req:IncomingMessage,res:ServerResponse,url:URL,data?:Record<string,unknown>):Promise<boolean>{
  const path=url.pathname;
  if(!['/auth/workos/config','/auth/workos/begin',CALLBACK,'/auth/workos/native'].includes(path))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  for(const [state,attempt]of this.attempts)if(attempt.expires<=Date.now())this.attempts.delete(state);
  const reject=(status=400)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Authentication failed'}));return true;};
  if(this.closed)return reject();
  if((req.url??'').split('?')[0]!==path||url.origin!==this.origin)return reject();
  if(path!==CALLBACK&&(req.headers.origin!==undefined&&req.headers.origin!==this.origin||
     req.headers['sec-fetch-site']==='cross-site'))return reject(403);
  if(path!==CALLBACK&&url.search)return reject();
  if(path==='/auth/workos/config'){
   if(req.method!=='GET')return reject(405);
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({configured:true,clientId:this.config.clientId,backendOrigin:this.origin}));return true;
  }
  if(path==='/auth/workos/begin'){
   if(req.method!=='GET')return reject(405);
   if((req.headers['sec-fetch-mode']!==undefined&&req.headers['sec-fetch-mode']!=='navigate')||
      (req.headers['sec-fetch-dest']!==undefined&&req.headers['sec-fetch-dest']!=='document'))return reject(403);
   if(this.attempts.size>=MAX_ATTEMPTS)return reject(503);
   const state=token(),binding=token(),verifier=token();
   try{
    const location=this.provider.authorizationUrl(this.config.webRedirectUri,state,createHash('sha256').update(verifier).digest('base64url'));
    this.attempts.set(state,{binding,verifier,expires:Date.now()+TTL});
    res.setHeader('Set-Cookie',BINDING+'='+binding+'; Path='+CALLBACK+'; HttpOnly; SameSite=Lax; Max-Age=300'+this.secure);
    res.writeHead(303,{Location:location});res.end();return true;
   }catch{return reject();}
  }
  if(path===CALLBACK){
   if(req.method!=='GET')return reject(405);
   const keys=[...url.searchParams.keys()];
   const state=url.searchParams.get('state');
   if(keys.length!==2||new Set(keys).size!==2||!keys.includes('state')||
     !(keys.includes('code')||keys.includes('error'))||!state||!/^[A-Za-z0-9_-]{43}$/.test(state))return reject();
   const attempt=this.attempts.get(state),binding=cookieBinding(req);
   if(!attempt||!binding||!equal(binding,attempt.binding))return reject();
   this.attempts.delete(state);
   res.setHeader('Set-Cookie',BINDING+'=; Path='+CALLBACK+'; HttpOnly; SameSite=Lax; Max-Age=0'+this.secure);
   const code=url.searchParams.get('code');
   if(!code||code.length>4096||url.searchParams.has('error'))return reject();
   try{
    const identity=await this.provider.exchange(code,attempt.verifier);
    if(this.closed)return reject();
    const sessions=await this.issue(identity,1,req.headers.cookie);
    if(sessions.length!==1||!/^spindle_session=[a-f0-9]{64}$/.test(sessions[0].cookie))throw new Error('INVALID_SESSION');
    res.setHeader('Set-Cookie',[BINDING+'=; Path='+CALLBACK+'; HttpOnly; SameSite=Lax; Max-Age=0'+this.secure,
      sessions[0].cookie+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200'+this.secure]);
    res.writeHead(303,{Location:'/portal'});res.end();return true;
   }catch{return reject();}
  }
  if(req.method!=='POST')return reject(405);
  if(!data||Object.keys(data).length!==2||typeof data.code!=='string'||!data.code||data.code.length>4096||
    typeof data.codeVerifier!=='string'||! /^[A-Za-z0-9._~-]{43,128}$/.test(data.codeVerifier))return reject();
  try{
   const identity=await this.provider.exchange(data.code,data.codeVerifier);
   if(this.closed)return reject();
   const sessions=await this.issue(identity,2);
   if(sessions.length!==2||sessions.some(s=>!/^spindle_session=[a-f0-9]{64}$/.test(s.cookie)||!s.csrf)||
     sessions[0].cookie===sessions[1].cookie||sessions[0].csrf===sessions[1].csrf||sessions[0].account.id!==sessions[1].account.id)
     throw new Error('INVALID_SESSIONS');
   res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({account:sessions[0].account,tracking:sessions[0],timer:sessions[1]}));return true;
  }catch{return reject();}
 }
}
