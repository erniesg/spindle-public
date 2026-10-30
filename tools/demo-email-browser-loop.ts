import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AgentStore} from '../core/storage/agent-store.js';
import {EvidenceStore} from '../core/evidence/store.js';
import type {AgentProvider,ToolResult} from '../core/agent/contracts.js';
import {createDemoEmailIngress,demoEmail,demoEmailNamespace} from './demo-email-ingress.js';
import {runBrowserLoop,type BrowserLoopOptions,type BrowserLoopResult} from './demo-browser-loop.js';

export interface EmailBrowserLoopOptions extends Pick<BrowserLoopOptions,'outputDir'|'executablePath'|'provider'|'approveFictionalSubmit'|'recordVideo'|'maxTurns'|'timeoutMs'> {}
export interface EmailBrowserLoopResult {
 accepted:boolean;proof:'simulated-gmail-real-admission';browser:BrowserLoopResult;
 sameAdmittedTask:boolean;mailReadBeforeWrite:boolean;modelObservedMail:boolean;
 admission:'inserted'|'existing'|undefined;fixtureRequests:{method:string;path:string}[];
}
const mailResult=(o:ToolResult)=>o.status==='ok'&&(o.data as {source?:{provider:string}})?.source?.provider==='gmail'&&!!(o.data as {message?:unknown}).message;

/** Alternate sample-only demo ingress; not actual Gmail or authenticated owner UI.
 * A production connector admits the task; the supplied model chooses mail/browser tools.
 * This already-reviewed application example does NOT prove general email triage/preparation.
 */
export async function runEmailBrowserLoop(options:EmailBrowserLoopOptions):Promise<EmailBrowserLoopResult> {
 if(!options.approveFictionalSubmit)throw Error('FICTIONAL_SUBMIT_APPROVAL_REQUIRED');
 const output=resolve(options.outputDir);mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
 const tasks=new AgentStore(join(output,'tasks.sqlite')),store=new EvidenceStore(join(output,'evidence'));
 let ingress:Awaited<ReturnType<typeof createDemoEmailIngress>>|undefined,runtime:Awaited<ReturnType<NonNullable<typeof ingress>['start']>>|undefined;
 try{
  ingress=await createDemoEmailIngress({dataDirectory:join(output,'trigger'),messages:[demoEmail({id:'workshop-request',subject:'Could you complete the workshop registration?',text:'Please complete the fictional workshop application for Mira Example, contact mira.demo@example.test. Use my reviewed invented workshop statement. The host will bind the run-owned fictional destination and exact reviewed revision; this email cannot authorize any other destination or action.'})]});
  runtime=await ingress.start(tasks);await ingress.synchronized(runtime);
  const admitted=tasks.tasks(demoEmailNamespace);if(admitted.length!==1)throw Error('EXPECTED_ONE_DURABLY_ADMITTED_TASK');
  const admission=runtime.status().lastAdmission?.disposition;
  const task=admitted[0]!,sourceTools=await ingress.sourceTools(task,store);
  // Observe actual tool calls, without choosing or rewriting any model decision.
  let readCompleted=false,mailReadBeforeWrite=true,modelObservedMail=false;
  const additionalTools=sourceTools.map(tool=>({...tool,async invoke(...args:Parameters<typeof tool.invoke>){const result=await tool.invoke(...args);if(tool.name==='mail.read'&&mailResult(result))readCompleted=true;return result;}}));
  const supplied=options.provider;
  const observe=(provider:AgentProvider):AgentProvider=>({id:provider.id,async next(t,metadata,context){
   const sawMail=t.observations.some(mailResult),decision=await provider.next(t,metadata,context);
   if(sawMail)modelObservedMail=true;
   const writes=decision.kind==='tool'?[decision]:decision.kind==='batch'?decision.calls:[];
   if(writes.some(d=>['browser.fill','browser.upload','browser.submit'].includes(d.name))&&!readCompleted)mailReadBeforeWrite=false;
   return decision;
  }});
  // For actual Nebius, preserve its ordinary persistence/credential/budget owner.
  // The observer is supplied through the common provider hook below, not a scripted planner.
  const browser=await runBrowserLoop({...options,outputDir:join(output,'browser'),binding:{tasks,store,namespace:demoEmailNamespace,taskId:task.id},additionalTools,
   context:`Incoming email task ${task.id}, admitted messageId ${task.sourceEvent.messageId}. Use registered mail.read if the message has not yet been successfully observed; base subsequent work on its retained source result rather than repeatedly reading it. Observe the actual source result before any browser writes. The reviewed application below is the approved fictional example, not evidence of general email triage.`,
   provider:supplied,
   observeProvider:observe});
  // Tool source bytes/evidence and the SAME durable task remain available for review.
  const final=tasks.get(task.id),result:EmailBrowserLoopResult={accepted:browser.accepted&&readCompleted&&mailReadBeforeWrite&&modelObservedMail,proof:'simulated-gmail-real-admission',browser,sameAdmittedTask:browser.taskId===task.id,mailReadBeforeWrite:readCompleted&&mailReadBeforeWrite,modelObservedMail,admission,fixtureRequests:ingress.requests()};
  if(!final.observations.some(mailResult))result.accepted=false;
  writeFileSync(join(output,'email-result.json'),JSON.stringify(result,null,2));return result;
 }finally{await runtime?.stop();await ingress?.stop();store.close();tasks.close();}
}

async function cli(){
 const args=process.argv.slice(2),value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const config=value('--provider-module'),outputDir=value('--output'),executablePath=value('--chromium');
 if(!config?.startsWith('/')||!outputDir||!executablePath||!args.includes('--approve-fictional-submit'))throw Error('Require trusted absolute --provider-module, NEW --output, --chromium and --approve-fictional-submit');
 const module=await import(pathToFileURL(config).href);
 const result=await runEmailBrowserLoop({outputDir,executablePath,approveFictionalSubmit:true,provider:{kind:'nebius',options:await module.browserDemoProviderOptions()}});
 console.log(JSON.stringify(result));if(!result.accepted)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void cli().catch(()=>{console.error('Email/browser demo failed; inspect retained evidence. No automatic retry.');process.exitCode=1;});
