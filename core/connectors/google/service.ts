import { abortRace } from './abort.js';
import type { AdmissionObservation } from '../../storage/agent-store.js';
import { GoogleOAuth, scopes } from './oauth.js';
import { GmailSync } from './gmail.js';
import { GmailWatch } from './watch.js';
import { GooglePushIntake, type GooglePushRoute } from './push.js';
import { GoogleWakeJournal } from './wake-journal.js';

export interface GoogleServiceConfig {
 connectionId:string; route:GooglePushRoute; mode:'push'|'local'; topicName?:string;
 /** Explicit trusted initial/expired-history eligibility; never recomputed at restart. */
 bootstrapSince:number; intervalMs?:number;
 relevant:(message:unknown,signal:AbortSignal)=>Promise<string|undefined>;
 onSynchronized?:()=>void;
 /** Backend-owned owner/connection/workspace fence, in addition to the OAuth epoch fence. */
 assertCurrent?:(signal:AbortSignal)=>Promise<void>;
 /** Synchronous signal only, after AgentStore commit; not an execution/admission pipeline. */
 onAdmission?:(observation:AdmissionObservation)=>void;
}
export function validateGoogleServiceConfig(config:GoogleServiceConfig):void {
 if(!config||typeof config!=='object'||!['push','local'].includes(config.mode))throw Error('Invalid Google mode');
 const text=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\u0000-\u001f\u007f]/.test(value);
 if(!text(config.connectionId)||!config.route||typeof config.route!=='object')throw Error('Invalid Google connection');
 for(const key of ['route','workspace','account','epoch','subscription','audience','serviceAccountEmail'] as const)if(!text(config.route[key]))throw Error(`Invalid Google route ${key}`);
 if(config.mode==='push'&&(!text(config.topicName)||!/^projects\/[^/]+\/topics\/[^/]+$/.test(config.topicName!)))throw Error('Push requires topic');
 if(config.topicName!==undefined&&!text(config.topicName))throw Error('Invalid Google topic');
 if(!Number.isSafeInteger(config.bootstrapSince)||config.bootstrapSince<0||config.bootstrapSince>8640000000000000)throw Error('Invalid Google bootstrap');
 if(!Number.isSafeInteger(config.intervalMs??30000)||(config.intervalMs??30000)<10||(config.intervalMs??30000)>2147483647)throw Error('Invalid Google interval');
 if(typeof config.relevant!=='function'||['onSynchronized','assertCurrent','onAdmission'].some(key=>{const value=config[key as keyof GoogleServiceConfig];return value!==undefined&&typeof value!=='function';}))throw Error('Invalid Google callbacks');
}
/** Explicit opt-in Google host. No application startup registration or public listener.
 * The embedding host routes Requests here and must await stop before closing stores. */
export class GoogleService {
 private controller?:AbortController;
 private timer?:ReturnType<typeof setTimeout>;
 private jobs=new Set<Promise<unknown>>();
 private busy=false;
 private wakePending=false;
 private bootstrapSince=0;
 private lastSync?:number;
 private lastIntake?:{receiptAt:number;durableObservedAt:number};
 private failure?:string;
 private watchFailure?:string;
 private intake:GooglePushIntake;
 constructor(private config:GoogleServiceConfig,private oauth:GoogleOAuth,private sync:GmailSync,private journal:GoogleWakeJournal,private watch:GmailWatch,http:typeof fetch=fetch) {
  validateGoogleServiceConfig(config);
  this.config=Object.freeze({...config,route:Object.freeze({...config.route})});
  this.intake=new GooglePushIntake([this.config.route],journal,http,async()=>{await this.current();});
 }
 private async current() {
  const signal=this.controller?.signal;if(!signal)throw Error('Google service stopped');signal.throwIfAborted();
  await abortRace(Promise.resolve(this.config.assertCurrent?.(signal)),signal);signal.throwIfAborted();
  const state=await abortRace(this.oauth.connectionState(this.config.connectionId,{signal}),signal);signal.throwIfAborted();
  await abortRace(Promise.resolve(this.config.assertCurrent?.(signal)),signal);signal.throwIfAborted();
  const r=this.config.route;
  if(!state||state.accountId!==r.account||state.connectionEpoch!==r.epoch||!state.grants.includes(scopes.mail))throw Error('Google connection changed');
 }
 private track<T>(job:Promise<T>):Promise<T>{this.jobs.add(job);void job.finally(()=>this.jobs.delete(job)).catch(()=>{});return job;}
 start():void {
  if(this.controller)throw Error('Google service already started');
  this.bootstrapSince=this.journal.bootstrap(this.config.route,this.config.bootstrapSince);
  this.controller=new AbortController();this.schedule(0);
 }
 private schedule(delay:number){clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.track(this.tick()).finally(()=>{if(this.controller&&!this.controller.signal.aborted){const status=this.journal.status(this.config.route) as {backlog:number;retryAt:number}|undefined;const immediate=this.wakePending&&status&&status.backlog>0&&status.retryAt<=Date.now();this.wakePending=false;this.schedule(immediate?0:this.config.intervalMs??30000);}}).catch(()=>{});},delay);}
 async stop():Promise<void>{if(!this.controller)return;this.controller.abort();clearTimeout(this.timer);await Promise.allSettled([...this.jobs]);this.controller=undefined;}
 handle(routeId:string,request:Request,receiptAt=Date.now()):Promise<Response> {
  if(!this.controller||this.controller.signal.aborted||this.config.mode!=='push')return Promise.resolve(new Response(null,{status:503}));
  const signal=AbortSignal.any([request.signal,this.controller.signal]);
  return this.track(this.intake.handle(routeId,new Request(request,{signal}),receiptAt).then(response=>{if(response.status===204&&!signal.aborted){this.lastIntake={receiptAt,durableObservedAt:Date.now()};this.wakePending=true;if(!this.busy)this.schedule(0);}return response;}));
 }
 status(){return {running:!!this.controller&&!this.controller.signal.aborted,mode:this.config.mode,lastSync:this.lastSync,lastIntake:this.lastIntake,failure:this.failure,watchFailure:this.watchFailure,journal:this.journal.status(this.config.route),latency:{label:'Route-wake correlation only; not Gmail message causality or a provider guarantee',mode:this.config.mode,receipt:this.config.mode==='push'?this.journal.receiptStatus(this.config.route):undefined,admissions:this.journal.admissionPage(this.config.route),unknown:'Missing original journal observations cannot recover admission timing'}};}
 private async tick() {
  if(this.busy)return;this.busy=true;
  const signal=this.controller!.signal,r=this.config.route;
  try {
   await this.current();
   const access=await abortRace(this.oauth.connectorAccess(this.config.connectionId,scopes.mail,{signal}),signal);await this.current();
   const token=await abortRace(access.token(),signal);await this.current();
   const lifecycle={signal,assertCurrent:async()=>{await this.current();await abortRace(Promise.resolve(access.assertCurrent()),signal);signal.throwIfAborted();}};
   if(this.config.mode==='push') {
    const watch=this.journal.watch(r);
    if(!watch||watch.expiresAt<Date.now()+86400000||this.journal.lastWatchRenewal(r)<Date.now()-86400000) {
     try {await this.watch.start(r,token,this.config.topicName!,lifecycle);this.watchFailure=undefined;}
     catch(error){signal.throwIfAborted();this.watchFailure=String(error);}
    }
   }
   await lifecycle.assertCurrent();
   const interval=this.config.intervalMs??30000;
   this.journal.enqueue(r,`recovery:${Math.floor(Date.now()/interval)}`);
   const claim=this.journal.claim(r);if(!claim)return;
   try {
    let complete=true;
    await this.sync.poll(r.account,r.workspace,token,m=>this.config.relevant(m,signal),{...lifecycle,connectionEpoch:r.epoch,onAdmission:observation=>{try{this.journal.recordAdmission(claim,observation,this.config.mode==='push');}finally{this.config.onAdmission?.(observation);}},onProgress:value=>{complete=value;},assertCurrent:async()=>{await lifecycle.assertCurrent();this.journal.renew(claim);},eligibleDuringReconciliation:m=>{const date=Number((m as {internalDate?:string})?.internalDate);return Number.isSafeInteger(date)&&date>=this.bootstrapSince;}});
    await lifecycle.assertCurrent();
    if(!complete){this.journal.retry(claim,Date.now());this.wakePending=true;return;}
    this.journal.complete(claim);const remaining=this.journal.status(r) as {backlog:number}|undefined;if(remaining&&remaining.backlog>0)this.wakePending=true;this.lastSync=Date.now();this.failure=undefined;
    this.config.onSynchronized?.();
   }catch(error){if(!signal.aborted)this.journal.retry(claim,Date.now()+interval);throw error;}
  }catch(error){if(!signal.aborted)this.failure=String(error);}finally{this.busy=false;}
 }
}
