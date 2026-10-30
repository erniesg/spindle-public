import {startGoogleApplication,type GoogleApplicationConfig} from './main.js';
import {scopes,type GoogleOAuth} from './oauth.js';
import {abortRace} from './abort.js';
import {validateGoogleServiceConfig} from './service.js';
import type {GooglePushRoute} from './push.js';
import type {AgentStore,AdmissionObservation} from '../../storage/agent-store.js';

/** Constructed only by the owning backend; never from a session/model/email payload.
 * OAuth must use that backend's existing owner-scoped credential adapter and Web client. */
export interface GoogleTriggerAuthority {
 ownerId:string; connectionId:string; workspaceId:string; accountId:string; connectionEpoch:string;
 oauth:GoogleOAuth;
 /** Recheck owner, connection incarnation, epoch and workspace authority without browser-session dependence. */
 assertCurrent:(signal:AbortSignal)=>Promise<void>;
}
export interface GoogleTriggerReceiver {
 /** Mount in an already approved receiver. Resolve only when mounted; no provisioning here. */
 attach:(handle:(request:Request,receiptAt?:number)=>Promise<Response>)=>Promise<{stop:()=>Promise<void>;isRunning:()=>boolean}>;
}
export interface GoogleTriggerScheduler {
 isRunning:()=>boolean;
 /** Immediate coalesced signal to the EXISTING scheduler, not inline model execution.
  * It must re-read the durable AgentStore and preserve namespace/budget/recovery fences. */
 wake:()=>void;
}
export type GoogleTriggerConfig=Omit<GoogleApplicationConfig,'clientId'|'connectionId'|'route'|'listen'|'assertCurrent'|'onAdmission'|'onSynchronized'> & {
 route:Omit<GooglePushRoute,'workspace'|'account'|'epoch'>;
};

/** Explicit trusted assembly, not automatic mailbox enrollment. Push is primary;
 * intervalMs remains watch renewal/recovery (polling only in selected local mode).
 * Missing push receiver/config rejects before watch or history I/O. No StreamingPull implementation. */
export async function startGoogleTriggerRuntime(config:GoogleTriggerConfig,dependencies:{authority:GoogleTriggerAuthority;tasks:AgentStore;scheduler:GoogleTriggerScheduler;receiver?:GoogleTriggerReceiver;http?:typeof fetch}) {
 config={...config,route:{...config.route}};
 const authority={...dependencies.authority},scheduler={...dependencies.scheduler};
 for(const value of [authority.ownerId,authority.connectionId,authority.workspaceId,authority.accountId,authority.connectionEpoch])if(typeof value!=='string'||!value||value.length>1024||/[\u0000-\u001f\u007f]/.test(value))throw Error('Google trigger authority required');
 if(!authority.oauth||typeof authority.assertCurrent!=='function'||!dependencies.tasks||typeof scheduler.isRunning!=='function'||typeof scheduler.wake!=='function')throw Error('Google trigger capabilities required');
 if(config.mode==='push'&&typeof dependencies.receiver?.attach!=='function')throw Error('Google push receiver configuration required (StreamingPull not implemented)');
 const route={...config.route,workspace:authority.workspaceId,account:authority.accountId,epoch:authority.connectionEpoch};
 let app:Awaited<ReturnType<typeof startGoogleApplication>>|undefined,receiver:Awaited<ReturnType<GoogleTriggerReceiver['attach']>>|undefined;
 let stopped=false,stopping:Promise<void>|undefined,schedulerFailure:string|undefined;
 const lifecycle=new AbortController();
 const assertAuthorityCurrent=async(signal:AbortSignal)=>{
  signal.throwIfAborted();
  await abortRace(Promise.resolve().then(()=>authority.assertCurrent(signal)),signal);
  const state=await abortRace(authority.oauth.connectionState(authority.connectionId,{signal}),signal);
  await abortRace(Promise.resolve().then(()=>authority.assertCurrent(signal)),signal);signal.throwIfAborted();
  if(!state||state.accountId!==authority.accountId||state.connectionEpoch!==authority.connectionEpoch||!state.grants.includes(scopes.mail))throw Error('Google trigger connection changed');
 };
 let lastAdmission:{taskId:string;disposition:AdmissionObservation['disposition'];observedAt:number}|undefined;
 let lastDispatch:{taskId:string;observedAt:number}|undefined;
 let lastSchedulerNotification:{at:number;reason:'startup'|'admission'|'recovery';taskId?:string}|undefined;
 const notify=(reason:'startup'|'admission'|'recovery',observation?:AdmissionObservation)=>{
  if(stopped)return;
  try {
   if(!scheduler.isRunning())return;
   scheduler.wake();schedulerFailure=undefined;
   lastSchedulerNotification={at:Date.now(),reason,...(observation?{taskId:observation.task.id}:{})};
  }catch{schedulerFailure='Host scheduler notification failed; durable tasks retained';}
 };
 const stop=()=>stopping??=(async()=>{
  stopped=true;lifecycle.abort();
  // Keep the handler mounted but rejecting during drain; always close both resources.
  const results=await Promise.allSettled([Promise.resolve().then(()=>receiver?.stop()),Promise.resolve().then(()=>app?.stop())]);
  if(results.some(result=>result.status==='rejected'))throw Error('Google trigger shutdown failed');
 })();
 try {
  // Validate all service/directory configuration and owner capability before receiver effects.
  const applicationConfig:GoogleApplicationConfig={...config,route,connectionId:authority.connectionId,listen:undefined,
   assertCurrent:async signal=>{if(config.mode==='push'&&!receiver?.isRunning())throw Error('Google push receiver not running');await authority.assertCurrent(signal);},
   onAdmission:observation=>{lastAdmission={taskId:observation.task.id,disposition:observation.disposition,observedAt:observation.observedAt};notify('admission',observation);},
   onSynchronized:()=>notify('recovery')};
  // Reuse the launcher validation before attaching a receiver; no stores/listener yet.
  validateGoogleServiceConfig(applicationConfig);
  if(typeof config.dataDirectory!=='string'||!config.dataDirectory.trim()||config.dataDirectory.length>4096||config.dataDirectory.includes('\0'))throw Error('Google trigger data directory required');
  await assertAuthorityCurrent(AbortSignal.timeout(15000));
  if(config.mode==='push') {
   receiver=await dependencies.receiver!.attach((request,receiptAt)=>stopped||!app?Promise.resolve(new Response(null,{status:503})):app.handle(request,receiptAt));
   if(!receiver.isRunning())throw Error('Google push receiver not running');
  }
  app=await startGoogleApplication(applicationConfig,{oauth:authority.oauth,tasks:dependencies.tasks,http:dependencies.http});
  notify('startup'); // Existing committed work is discoverable even if its admission hook was lost.
  return {stop,
   /** Recheck standing owner/connection permission after queued/async setup and before
    * runtime handoff. Admission is not ongoing execution authority. No Google API call,
    * model dispatch or external-write permission is supplied by this check. */
   assertDispatchCurrent:async(taskId:string,signal:AbortSignal)=>{
    if(stopped)throw Error('Google trigger stopped');
    if(!dependencies.tasks.taskInNamespace({workspaceId:authority.workspaceId,accountId:authority.accountId},taskId))throw Error('Google trigger task unavailable');
    await assertAuthorityCurrent(AbortSignal.any([signal,lifecycle.signal,AbortSignal.timeout(15000)]));
   },
   /** Trusted host calls immediately before handing this durable task to its runtime.
    * Observation only: does not dispatch, grant authority or certify provider/model I/O. */
   observeDispatch:(taskId:string)=>{
    if(stopped)throw Error('Google trigger stopped');
    if(!dependencies.tasks.taskInNamespace({workspaceId:authority.workspaceId,accountId:authority.accountId},taskId))throw Error('Google trigger task unavailable');
    lastDispatch={taskId,observedAt:Date.now()};
   },
   status:()=>{
   const service=app!.status();
   let schedulerRunning=false,receiverRunning=config.mode==='local';
   try{schedulerRunning=!stopped&&scheduler.isRunning();receiverRunning=!stopped&&(config.mode==='local'||!!receiver?.isRunning());}catch{/* Capability failure is not running. */}
   const watchExpires=(service.journal as {watchExpires?:number}|undefined)?.watchExpires;
   const watching=config.mode==='push'&&service.running&&receiverRunning&&!!watchExpires&&watchExpires>Date.now()&&!service.watchFailure;
   const running=!stopped&&service.running&&receiverRunning&&schedulerRunning&&!schedulerFailure&&!service.failure&&(config.mode==='local'||watching)&&service.lastSync!==undefined;
   return {state:stopped?'stopped':!receiverRunning?'needs_configuration':service.failure||service.watchFailure||schedulerFailure||!schedulerRunning?'blocked':running?'running':'configured',
    configured:true,running,ownerId:authority.ownerId,connectionId:authority.connectionId,workspaceId:authority.workspaceId,accountId:authority.accountId,connectionEpoch:authority.connectionEpoch,
    receiverRunning,watching,schedulerRunning,schedulerFailure,lastAdmission,lastSchedulerNotification,lastDispatch,
    timingLabel:'Local wall clock: post-enqueue intake (including duplicate ACKs), post-commit admission, scheduler notification, and optional host-reported runtime handoff. Not model dispatch, message causality or provider latency guarantee; volatile fields reset on restart, durable receipt/admission records remain in service.latency',service};
  }};
 }catch(error){await stop();throw error;}
}
