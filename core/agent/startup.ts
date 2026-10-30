import {mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AgentStore} from '../storage/agent-store.js';
import {EvidenceStore,type Namespace} from '../evidence/store.js';
import {AgentSessionStore} from '../models/agent-session-store.js';
import {NebiusAgentProvider,type AgentProviderOptions} from '../models/agent-provider.js';
import {FileCallBudget} from '../models/file-budget.js';
import {startGoogleApplication,type GoogleApplicationConfig} from '../connectors/google/main.js';
import {startGoogleTriggerRuntime,type GoogleTriggerConfig,type GoogleTriggerAuthority,type GoogleTriggerReceiver} from '../connectors/google/trigger-runtime.js';
import {startTaskReview} from '../assistant/app.js';
import {AccountClient} from '../account/client.js';
import {createUserMemoryApplication,type UserMemoryApplication} from '../memory/application.js';
import {AgentRuntime} from './runtime.js';
import type {Task,ToolDefinition,TrustedScope,RunOptions} from './contracts.js';
import type {TaskMailReviewPage} from './mail-host.js';

export type AgentApplicationConfig=AgentApplicationOptions & (
 {google:GoogleApplicationConfig;trigger?:never} |
 {google?:never;trigger:{config:GoogleTriggerConfig;authority:GoogleTriggerAuthority;receiver?:GoogleTriggerReceiver}}
);
export interface TaskToolBinding {
 tools:ToolDefinition[];
 execution?:Pick<RunOptions,'approveExternalWrite'|'assertReady'>;
 /** Idempotent owned-resource close; never asserts remote rollback. */
 close():Promise<void>;
}
interface AgentApplicationOptions {
 namespace:Namespace;
 /** Trusted per-action policy only; absence still denies all external effects. */
 execution?:Pick<RunOptions,'approveExternalWrite'|'getScope'|'assertReady'>;
 /** Existing cumulative journal only. Creation/reset is deliberately not implemented. */
 budgetPath:string; model:AgentProviderOptions['model']; credential:AgentProviderOptions['credential'];
 modelTransport?:typeof fetch; googleDependencies?:Omit<NonNullable<Parameters<typeof startGoogleApplication>[1]>,'tasks'>;
 /** Trusted application owns roots, local editing registry and source/grant decisions. */
 tools:(evidence:EvidenceStore,host?:{tasks:AgentStore;namespace:Namespace;signal:AbortSignal})=>ToolDefinition[]|Promise<ToolDefinition[]>; scope:TrustedScope;
 /** Construct task-bound tools only after actual durable admission, using the SAME stores. */
 taskTools?:(task:Readonly<Task>,host:{tasks:AgentStore;evidence:EvidenceStore;namespace:Namespace;signal:AbortSignal})=>Promise<TaskToolBinding>;
 /** Close owned tool contexts only after actual invocations drain, before stores close. */
 stopTools?:()=>Promise<void>;
 maxTurns:number; timeoutMs:number; pollMs:number; review?:boolean;
 /** Optional owner-only retained email readback; no approval or model execution. */
 reviewMail?:(taskId:string,after:string)=>TaskMailReviewPage;
 /** Optional trusted account origin. No implicit signin, learning, processing or sync. */
 userMemory?:{accountOrigin:string};
}
/** Explicit preparation assembly. Single active task; no capture, enrollment or submission.
 * A crashed owner leaves an exclusive lock, requiring operator reconciliation, not auto-replay. */
export async function startAgentApplication(config:AgentApplicationConfig) {
 for(const [value,min,max] of [[config.maxTurns,1,100],[config.timeoutMs,1,3600000],[config.pollMs,10,60000]])if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid startup bound');
 const namespace=structuredClone(config.namespace),scope=structuredClone(config.scope);
 if(!!config.google===!!config.trigger)throw Error('Select exactly one Google ingestion configuration');
 const googleNamespace=config.trigger?{workspace:config.trigger.authority.workspaceId,account:config.trigger.authority.accountId}:config.google!.route;
 if(!namespace.workspaceId||!namespace.accountId||namespace.workspaceId!==googleNamespace.workspace||namespace.accountId!==googleNamespace.account)throw Error('Startup namespace must match Google route');
 const execution=config.execution&&{...config.execution};
 if(!isAbsolute(config.budgetPath))throw Error('Existing absolute budget path required');
 const budget=new FileCallBudget(config.budgetPath); // Fail before creating application state.
 const account=config.userMemory?new AccountClient(config.userMemory.accountOrigin):undefined;
 const directory=resolve(config.trigger?.config.dataDirectory??config.google!.dataDirectory);mkdirSync(directory,{recursive:true,mode:0o700});
 const lockPath=join(directory,'agent-startup.lock');const lock=openSync(lockPath,'wx',0o600);
 let tasks:AgentStore|undefined,evidence:EvidenceStore|undefined,google:Awaited<ReturnType<typeof startGoogleApplication>>|undefined,review:Awaited<ReturnType<typeof startTaskReview>>|undefined;
 let memory:UserMemoryApplication|undefined,trigger:Awaited<ReturnType<typeof startGoogleTriggerRuntime>>|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,stopping:Promise<void>|undefined,job:Promise<void>|undefined,failure:string|undefined;
 let queueReady=false,wakePending=false;
 // Signals coalesce, but remain pending through the actual invocation drain.
 const wake=()=>{if(stopped)return;wakePending=true;if(queueReady&&!job)schedule(0);};
 const schedule=(delay:number)=>{
  if(timer)clearTimeout(timer);
  if(!stopped&&queueReady)timer=setTimeout(()=>{
   timer=undefined;wakePending=false;
   job=Promise.resolve().then(tick).then(()=>{if(!stopped&&tasks!.working(namespace,1).length)wakePending=true;}).catch(()=>{failure='Preparation queue unavailable; stop and reconcile retained state';stopped=true;controller.abort();}).finally(()=>{job=undefined;schedule(wakePending?0:config.pollMs);});
  },delay);
 };
 let tick:()=>Promise<void>;
 const controller=new AbortController(),operations=new Set<Promise<unknown>>();
 // Runtime cancellation bounds observation waits, not arbitrary trusted tool side effects.
 // Keep actual invocations alive for resource draining before closing their stores.
 const track=<T>(operation:Promise<T>):Promise<T>=>{operations.add(operation);void operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation;};
 let taskTools:TaskToolBinding|undefined;
 const closeTaskTools=async()=>{const owned=taskTools;if(owned){await owned.close();if(taskTools===owned)taskTools=undefined;}};
 const stop=()=>stopping??=(async()=>{
  stopped=true;if(timer)clearTimeout(timer);controller.abort();
  // An ingress-close error must not skip worker drain and close databases under it.
  const ingress=await Promise.allSettled([google?.stop(),trigger?.stop()]);
  await job;
  const ui=await Promise.allSettled([review?.close()]);
  // Close ingress before stopping memory; then drain actual provider/tool calls,
  // not just the runtime's cancellation-bounded observation of those calls.
  const worker=await Promise.allSettled([memory?.stop()]);
  while(operations.size)await Promise.allSettled([...operations]);
  const taskResources=await Promise.allSettled([closeTaskTools()]);
  const toolResources=await Promise.allSettled([Promise.resolve().then(()=>config.stopTools?.())]);
  try {try{evidence?.close();}finally{tasks?.close();}}finally{closeSync(lock);unlinkSync(lockPath);}
  if([...ingress,...ui,...worker,...taskResources,...toolResources].some(result=>result.status==='rejected'))throw Error('Application resource shutdown failed');
 })();
 try {
  tasks=new AgentStore(join(directory,'tasks.sqlite'));evidence=new EvidenceStore(join(directory,'evidence'));
  const sessions=new AgentSessionStore(evidence.db);
  const provider=new NebiusAgentProvider({model:config.model,budget,credential:config.credential,persist:sessions.persist,transport:config.modelTransport,signal:controller.signal});
  const trackedProvider={id:provider.id,next:(...args:Parameters<typeof provider.next>)=>track(provider.next(...args))};
  if(account){
   const service=createUserMemoryApplication({evidence,evidenceRoot:join(directory,'evidence'),account,workspaceId:namespace.workspaceId,provider:trackedProvider});
   // A disconnected review socket can outlive server.close(). The service owns
   // its learning/sync drain; startup additionally owns async account ingress.
   memory={...service,
    signin:(...args)=>track(Promise.resolve().then(()=>{if(stopped)throw Error('Application stopped');return service.signin(...args);})),
    signout:()=>track(Promise.resolve().then(()=>{if(stopped)throw Error('Application stopped');return service.signout();})),
   };memory.start();
  }
  const trackedTool=(tool:ToolDefinition):ToolDefinition=>({...tool,invoke:(...args:Parameters<ToolDefinition['invoke']>)=>track(Promise.resolve().then(()=>{args[1].signal.throwIfAborted();return tool.invoke(...args);} ))});
  const registry=(await config.tools(evidence,{tasks,namespace:structuredClone(namespace),signal:controller.signal})).map(trackedTool);
  let runtime=new AgentRuntime(tasks,registry);
  tick=async()=>{
   // Only this owner consumes tasks. Previously attempted work may have an unknown
   // model dispatch even without Task.pending; do not infer safety from its absence.
   for(const task of tasks!.working(namespace,20)) {
    if(stopped)return;
    if(task.run.attempt>0||task.pending||task.recovery!=='clean') {
     tasks!.update(task.id,t=>{t.generation++;t.status='blocked';t.recovery='reconciliation_required';t.blocker='Interrupted execution needs reconciliation';t.nextAction='Review retained model envelopes and effects before explicit recovery';});continue;
    }
    try {
     if(config.taskTools){
      const binding=await config.taskTools(structuredClone(task),{tasks:tasks!,evidence:evidence!,namespace:structuredClone(namespace),signal:controller.signal});
      taskTools=binding;runtime=new AgentRuntime(tasks!,[...registry,...binding.tools.map(trackedTool)]);
     }
     const policy=taskTools?.execution;
     if(trigger)try{await trigger.assertDispatchCurrent(task.id,controller.signal);}catch{
      if(stopped)return;
      tasks!.update(task.id,t=>{if(t.status==='working'){t.status='blocked';t.blocker='Google trigger authorization unavailable before execution';t.nextAction='Review the Google connection and standing trigger authorization before explicit continuation';}});
      continue;
     }
     trigger?.observeDispatch(task.id);
     await runtime.run(task.id,trackedProvider,config.maxTurns,{...execution,
      approveExternalWrite:(...args)=>!!(execution?.approveExternalWrite?.(...args)||policy?.approveExternalWrite?.(...args)),
      assertReady:t=>{execution?.assertReady?.(t);policy?.assertReady?.(t);},
      signal:controller.signal,scope,timeoutMs:config.timeoutMs});
    }finally{
     // Observation ending is not actual tool settlement or remote rollback.
     while(operations.size)await Promise.allSettled([...operations]);
     await closeTaskTools();
    }
    const after=tasks!.get(task.id);
    if(after.status==='working')tasks!.update(task.id,t=>{t.status='blocked';t.blocker='Preparation turn bound reached';t.nextAction='Review observations before explicit continuation';});
    break; // one active task and one execution per poll
   }
  };
  // Exactly one ingestion service shares the application's existing task store.
  if(config.trigger)trigger=await startGoogleTriggerRuntime(config.trigger.config,{authority:config.trigger.authority,receiver:config.trigger.receiver,tasks,http:config.googleDependencies?.http,scheduler:{wake,isRunning:()=>queueReady&&!stopped}});
  else {
   const legacy=config.google!;
   google=await startGoogleApplication({...legacy,onAdmission:observation=>{try{legacy.onAdmission?.(observation);}finally{wake();}},onSynchronized:()=>{try{legacy.onSynchronized?.();}finally{wake();}}},{...config.googleDependencies,tasks});
  }
  if(config.review)review=await startTaskReview(tasks,namespace,evidence,memory,config.reviewMail);
  queueReady=true;wake(); // Recover committed, unattempted work even if an admission signal was lost.
  return {tasks,evidence,sessions,budget,google,trigger,review,stop,wake,
   cancelTask:(id:string)=>{if(stopped)throw Error('Application stopped');if(!tasks!.taskInNamespace(namespace,id))throw Error('Task unavailable');runtime.cancel(id);},
   status:()=>({stopped,failure,active:!!job&&operations.size>0})};
 }catch(error){try{await stop();}catch(shutdown){throw new AggregateError([error,shutdown],'Application startup and shutdown failed');}throw error;}
}

async function main(){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--application-module'||!isAbsolute(args[1]))throw Error('Usage: startup.js --application-module /absolute/trusted-application.mjs');
 const module=await import(pathToFileURL(args[1]).href);
 if(typeof module.agentApplicationConfig!=='function')throw Error('Expected trusted agentApplicationConfig()');
 const app=await startAgentApplication(await module.agentApplicationConfig());
 if(app.review)console.log(app.review.url); // Private local capability; never put in evidence.
 const stop=()=>{void app.stop().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main().catch(()=>{console.error('Agent startup failed');process.exitCode=1;});
