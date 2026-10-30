import {isAbsolute} from 'node:path';
import {chromium,type Browser} from 'playwright-core';
import type {AgentProvider,Task} from '../agent/contracts.js';
import type {TaskBrowserOptions} from '../agent/browser-host.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import {NebiusAgentProvider,type AgentProviderOptions} from '../models/agent-provider.js';
import type {FileCallBudget} from '../models/file-budget.js';
import type {ModelDeclaration} from '../models/provider.js';
import {preparationBudget} from './budget.js';
import type {PortalContinuationTarget} from './portal-continuation.js';
import type {PreparationContext} from './service.js';
import {DEFAULT_FICTIONAL_MAPPING,fictionalPortalTarget,readFictionalReceipt,validFictionalMapping,type FictionalPortalMapping} from './fictional-portal.js';

/** One approved browser phase, as seen by its provider. Supplied by the service per run. */
export interface PreparationBrowserPhase {
 review:NonNullable<AgentProviderOptions['browserContinuation']>['review'];
 /** Synchronous run authority (session/root/grant/epoch/cancel), never task generation. */
 isCurrent():boolean;
 /** Final currentness: `start` runs synchronously inside the authoritative auth transaction. */
 dispatch<T>(guard:()=>boolean,start:()=>T,signal?:AbortSignal):Promise<{started:T}>;
}
/** Trusted operator browser-continuation wiring consumed by PreparationService. */
export interface PreparationBrowserContinuation {
 mode:'developer_fictional';destination:string;
 target(task:Readonly<Task>,store:EvidenceStore,ns:Namespace):PortalContinuationTarget;
 browser():Promise<Browser>;
 readReceipt:TaskBrowserOptions['readReceipt'];
 provider(context:PreparationContext,phase:PreparationBrowserPhase):AgentProvider;
 allowLoopback:boolean;browserTimeoutMs:number;timeoutMs:number;maxTurns:number;
 close():Promise<void>;
}
export interface FictionalPortalProductionOptions {
 /** Loopback origin of the OWNED fictional portal started by the operator host. */
 origin:string;mapping?:FictionalPortalMapping;
 /** Existing Chromium executable chosen by the operator; never discovered or downloaded. */
 chromiumExecutable:string;
 /** The SAME journal, decision model, credential and transport as preparation. */
 budget:FileCallBudget;decisionModel:ModelDeclaration;credential:()=>Promise<string|undefined>;modelTransport?:typeof fetch;
 processingPaused?:boolean;providerTimeoutMs?:number;timeoutMs?:number;maxTurns?:number;browserTimeoutMs?:number;
}

/** Ordinary production assembly for the developer-fictional destination: existing Nebius adapter and
 * budgets, existing Playwright Chromium, guarded dispatch and the destination's trusted receipt parser. */
export function fictionalPortalContinuation(o:FictionalPortalProductionOptions):PreparationBrowserContinuation{
 let origin:URL;try{origin=new URL(o.origin);}catch{throw Error('FICTIONAL_PORTAL_ORIGIN_INVALID');}
 if(origin.origin!==o.origin||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw Error('FICTIONAL_PORTAL_ORIGIN_INVALID');
 if(!isAbsolute(o.chromiumExecutable))throw Error('FICTIONAL_PORTAL_CHROMIUM_REQUIRED');
 if(o.decisionModel.provider!=='nebius')throw Error('NEBIUS_PREPARATION_MODELS_REQUIRED');
 const mapping=validFictionalMapping(o.mapping??DEFAULT_FICTIONAL_MAPPING);
 const timeoutMs=o.timeoutMs??180000,maxTurns=o.maxTurns??12,browserTimeoutMs=o.browserTimeoutMs??10000,providerTimeoutMs=o.providerTimeoutMs??60000;
 for(const [v,max] of [[timeoutMs,3600000],[maxTurns,64],[browserTimeoutMs,60000],[providerTimeoutMs,3600000]] as const)if(!Number.isSafeInteger(v)||v<1||v>max)throw Error('INVALID_FICTIONAL_PORTAL_BOUND');
 let launched:Promise<Browser>|undefined,closed=false;
 return {mode:'developer_fictional',destination:o.origin+'/',allowLoopback:true,browserTimeoutMs,timeoutMs,maxTurns,readReceipt:readFictionalReceipt,
  target:(task,store,ns)=>fictionalPortalTarget(o.origin,mapping,task,store,ns),
  // Lazily launched once and owned until service close; each run gets its own clean context.
  browser(){if(closed)return Promise.reject(Error('PREPARATION_STOPPING'));launched??=chromium.launch({executablePath:o.chromiumExecutable,headless:true,chromiumSandbox:true});return launched;},
  async close(){closed=true;const browser=await launched?.catch(()=>undefined);await browser?.close();},
  provider(c,phase){
   if(o.processingPaused)throw Error('PREPARATION_PROCESSING_PAUSED');
   const revision=c.tasks.get(c.taskId).preparation!.revision;
   const check=()=>{if(o.processingPaused)throw Error('PREPARATION_PROCESSING_PAUSED');const t=c.tasks.get(c.taskId);if(t.status!=='working'||!t.preparation!.processingConsent||t.preparation!.revision!==revision||!phase.isCurrent())throw Error('PREPARATION_BROWSER_AUTHORITY_NOT_CURRENT');};
   const credential=()=>c.track((async()=>{check();await c.binding.assertCurrent();check();const key=await o.credential();check();return key;})());
   // The model packet starts only inside the final auth transaction, like browser packets.
   const transport:typeof fetch=(input,init)=>c.track((async()=>{
    check();const {started}=await phase.dispatch(()=>{try{check();return !init?.signal?.aborted;}catch{return false;}},()=>(o.modelTransport??fetch)(input,init),init?.signal??undefined);
    const response=await started;try{check();await c.binding.assertCurrent({signal:init?.signal??undefined});return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
   })());
   return new NebiusAgentProvider({model:o.decisionModel,budget:preparationBudget(c.tasks,c.taskId,o.budget,'decision'),credential,transport,timeoutMs:providerTimeoutMs,persist:c.sessions.persist,browserContinuation:{review:phase.review}});
  }};
}
