import { createPublicKey, verify } from 'node:crypto';
import { boundedJson } from './bounded.js';
import { abortRace } from './abort.js';
import type { GoogleWakeJournal, GoogleWakeRoute } from './wake-journal.js';

const KEYS='https://www.googleapis.com/oauth2/v3/certs';
export interface GooglePushRoute extends GoogleWakeRoute {subscription:string;audience:string;serviceAccountEmail:string}
function object(value:unknown):Record<string,any> {if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid push object');return value as Record<string,any>;}
function decode(value:string,url=false):Buffer {
 if(!value||!(url?/^[A-Za-z0-9_-]+$/:/^[A-Za-z0-9+/]*={0,2}$/).test(value))throw Error('Invalid base64');
 const bytes=Buffer.from(value,url?'base64url':'base64');
 if(bytes.toString(url?'base64url':'base64').replace(/=+$/,'')!==value.replace(/=+$/,''))throw Error('Noncanonical base64');return bytes;
}
/** Host calls this after selecting a configured route. No public listener is started.
 * Only durable wake hints are accepted; notification history IDs never set cursors. */
export class GooglePushIntake {
 private routes:Map<string,GooglePushRoute>;
 private active=0;
 private cached?:{keys:any;until:number};
 private fetching?:Promise<any>;
 private keys(signal:AbortSignal):Promise<any> {
  if(this.cached&&this.cached.until>Date.now())return Promise.resolve(this.cached.keys);
  if(!this.fetching){const deadline=AbortSignal.timeout(10000);this.fetching=(async()=>{const response=await abortRace(this.http(KEYS,{signal:deadline,redirect:'error'}),deadline);if(!response.ok)throw Error('Google keys unavailable');const keys=await abortRace(boundedJson(response,65536,deadline),deadline);deadline.throwIfAborted();if(!Array.isArray(keys.keys)||keys.keys.length>32)throw Error('Invalid keys');this.cached={keys,until:Date.now()+300000};return keys;})().finally(()=>{this.fetching=undefined;});}
  return abortRace(this.fetching,signal);
 }
 constructor(routes:readonly GooglePushRoute[],private journal:Pick<GoogleWakeJournal,'enqueue'>,private http:typeof fetch=fetch,private assertCurrent?:(route:GooglePushRoute)=>Promise<void>) {
  this.routes=new Map();for(const route of routes){if(Object.values(route).some(v=>typeof v!=='string'||!v||v.length>2048)||this.routes.has(route.route))throw Error('Invalid push route');this.routes.set(route.route,{...route});}
 }
 async handle(routeId:string,request:Request,receiptAt=Date.now()):Promise<Response> {
  if(this.active>=8)return new Response(null,{status:503});this.active++;
  try{return await this.accept(routeId,request,receiptAt);}finally{this.active--;}
 }
 private async accept(routeId:string,request:Request,receiptAt:number):Promise<Response> {
  const route=this.routes.get(routeId);if(!route)return new Response(null,{status:404});
  if(request.method!=='POST')return new Response(null,{status:405});
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]);
  let messageId:string,publishAt:number|undefined;
  try {
   const auth=request.headers.get('authorization')??'';
   if(auth.length>16384||!/^Bearer [A-Za-z0-9_.-]+$/.test(auth))throw Error('Invalid bearer');
   const parts=auth.slice(7).split('.');if(parts.length!==3)throw Error('Invalid JWT');
   const header=object(JSON.parse(decode(parts[0],true).toString('utf8')));
   const claims=object(JSON.parse(decode(parts[1],true).toString('utf8')));
   if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256||header.crit!==undefined)throw Error('Invalid JWT algorithm');
   const keys=await this.keys(signal);signal.throwIfAborted();
   if(!Array.isArray(keys.keys)||keys.keys.length>32)throw Error('Invalid keys');
   const matches=keys.keys.filter((k:any)=>k?.kid===header.kid&&k.kty==='RSA'&&(k.alg===undefined||k.alg==='RS256')&&(k.use===undefined||k.use==='sig'));
   if(matches.length!==1)throw Error('Unknown key');
   const key=createPublicKey({key:matches[0],format:'jwk'});
   if((key.asymmetricKeyDetails?.modulusLength??0)<2048||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,decode(parts[2],true)))throw Error('Bad signature');
   const now=Math.floor(Date.now()/1000);
   if(!['accounts.google.com','https://accounts.google.com'].includes(claims.iss)||claims.aud!==route.audience||claims.email!==route.serviceAccountEmail||claims.email_verified!==true||!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||claims.exp<=now||claims.iat>now+30||claims.iat<now-3600||claims.exp<=claims.iat||claims.exp-claims.iat>3600)throw Error('Invalid claims');
   const reader=request.body?.getReader();if(!reader)throw Error('Missing body');
   const chunks:Uint8Array[]=[];let size=0;
   let abort:()=>void=()=>{};
   const aborted=new Promise<never>((_,reject)=>{abort=()=>{void reader.cancel().catch(()=>{});reject(Error('Push cancelled'));};signal.addEventListener('abort',abort,{once:true});});
   try {signal.throwIfAborted();while(true){const item=await Promise.race([reader.read(),aborted]);if(item.done)break;size+=item.value.byteLength;if(size>65536)throw Error('Push body too large');chunks.push(item.value);}}
   finally {signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
   const body=object(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));signal.throwIfAborted();
   if(body.subscription!==route.subscription)throw Error('Wrong subscription');
   const message=object(body.message);
   if(typeof message.messageId!=='string'||!message.messageId||message.messageId.length>1024||typeof message.data!=='string'||message.data.length>8192)throw Error('Invalid message');
   const notification=object(JSON.parse(decode(message.data).toString('utf8')));
   if(notification.emailAddress!==route.account||typeof notification.historyId!=='string'||!/^\d{1,128}$/.test(notification.historyId))throw Error('Wrong account or history');
   messageId=message.messageId;
   // Optional provider-clock metadata is never intake authority. Future, malformed
   // or absent values stay unknown rather than manufacturing negative latency.
   if(typeof message.publishTime==='string'&&message.publishTime.length<=64&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(message.publishTime)) {
    const parsed=Date.parse(message.publishTime);if(Number.isSafeInteger(parsed)&&parsed>=0&&parsed<=receiptAt&&new Date(parsed).toISOString().slice(0,19)===message.publishTime.slice(0,19))publishAt=parsed;
   }
  }catch{return new Response(null,{status:400});}
  try {signal.throwIfAborted();await abortRace(Promise.resolve(this.assertCurrent?.(route)),signal);signal.throwIfAborted();this.journal.enqueue(route,messageId,{receiptAt,publishAt});return new Response(null,{status:204});}
  catch{return new Response(null,{status:503});}
 }
}
