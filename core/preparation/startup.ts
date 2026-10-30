import {TextProvider} from '../models/provider.js';
import {parseTriage,triageSystem} from '../inbox/service.js';
import {mkdirSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AgentStore} from '../storage/agent-store.js';
import {EvidenceStore} from '../evidence/store.js';
import {FileCallBudget} from '../models/file-budget.js';
import {NebiusAgentProvider} from '../models/agent-provider.js';
import {AgentSessionStore} from '../models/agent-session-store.js';
import type {MailServiceConfig} from '../mail/service.js';
import {startTrackingServer} from '../tracking/server.js';
import type {SharedGoogleConfig} from '../tracking/google.js';
import {productionPreparation,type ProductionPreparationOptions} from './production.js';
import type {PreparationPortal} from './browser-review.js';
import type {WorkOSConfig} from '../account/workos-provider.js';
import type {ClassificationConfig} from '../account/classification-host.js';
import {validatePublicProxy,type PublicProxyConfig} from '../tracking/public-proxy.js';
import {validatePublicPaidAccess,type PublicPaidAccess} from '../account/paid-task-quota.js';
export type {PublicPaidAccess} from '../account/paid-task-quota.js';
import {startFictionalPortal,type FictionalPortalMapping} from './fictional-portal.js';
import {fictionalPortalContinuation} from './portal-production.js';
export interface PreparationAccountConfig extends Omit<ProductionPreparationOptions,'tasks'|'store'|'budget'|'workspaceId'> {
 /** The EXISTING account directory/key/Web client. Never a replacement account/auth database. */
 directory:string;key:Buffer;google?:SharedGoogleConfig;port?:number;publicOrigin?:string;
 /** Explicit operator services; absent Google means preparation/mail are unavailable, never guessed. */
 workos?:WorkOSConfig;classification?:ClassificationConfig;
 /** Private trusted-edge contract; valid only with publicOrigin. See docs/PUBLIC_RELEASE.md. */
 publicProxy?:PublicProxyConfig;
 /** Trusted temporary release boundary. Public HTTPS defaults to connection-only. */
 publicPaidAccess?:PublicPaidAccess;
 budgetPath:string;
 /** Private hosts default enabled. Public mail requires owned-pilot AND explicit true. */
 mailEnabled?:boolean;
 /** Optional metadata-only diagnostics for inbox automation. */
 inboxLog?:(record:Record<string,unknown>)=>void;
 /** Read-only review target until authenticated approval/execution wiring is configured. */
 browserPortal?:PreparationPortal;
 /** Explicit DEVELOPER-FICTIONAL owner-approved submission. Default disabled: absent or `enabled!==true`
  * exposes no approve/reconcile execution. Starts only the owned loopback fictional portal; the
  * destination, mapping and required controls come from this trusted configuration, never a request. */
 developerFictionalPortal?:{enabled:boolean;directory:string;chromiumExecutable:string;port?:number;mapping?:FictionalPortalMapping;timeoutMs?:number;maxTurns?:number;browserTimeoutMs?:number;providerTimeoutMs?:number};
}
/** Explicit production account host. Constructing it never processes sources or loads a model key.
 * Actual request/correction work uses the normal /connections AccountClient API, not an operator DAG. */
export async function startPreparationAccount(config:PreparationAccountConfig){
 if(!config.sourceIdentity||! /^[a-f0-9]{40}$/.test(config.sourceIdentity.revision)||config.sourceIdentity.tree!==undefined&&!/^[a-f0-9]{40}$/.test(config.sourceIdentity.tree)||!config.buildIdentity||config.buildIdentity.length>256)throw Error('SOURCE_BUILD_BINDING_REQUIRED');
 if(!isAbsolute(config.directory)||!isAbsolute(config.budgetPath)||config.key.length!==32)throw Error('EXPLICIT_PREPARATION_HOST_CONFIGURATION_REQUIRED');
 validatePublicProxy(config.publicProxy,config.publicOrigin);
 const paidAccess=validatePublicPaidAccess(config.publicPaidAccess)??(config.publicOrigin?{mode:'connection-only'} as const:undefined);
 if(paidAccess?.mode==='connection-only'&&config.mailEnabled===true)throw Error('PUBLIC_PILOT_MAIL_DISABLED');
 if(paidAccess?.mode==='connection-only'){
  // No budget/model factories, Agent/Evidence stores, Task owner, portal or mail.
  // Account/Google connection state remains the normal encrypted account store.
  const server=await startTrackingServer(config.directory,config.key,config.port??0,config.publicOrigin,config.google,undefined,undefined,config.workos,config.classification,config.publicProxy,paidAccess);
  let closing:Promise<void>|undefined;
  return {origin:server.origin,listenOrigin:server.listenOrigin,close:()=>closing??=server.close()};
 }
 const budget=new FileCallBudget(config.budgetPath); // Existing journal; fail before application-state creation.
 const directory=join(config.directory,'preparation');mkdirSync(directory,{recursive:true,mode:0o700});
 const tasks=new AgentStore(join(directory,'tasks.sqlite'));
 let evidence:EvidenceStore|undefined,server:Awaited<ReturnType<typeof startTrackingServer>>|undefined,portal:Awaited<ReturnType<typeof startFictionalPortal>>|undefined,closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{try{await server?.close();}finally{try{await portal?.close();}finally{try{evidence?.close();}finally{tasks.close();}}}})();
 try{
  evidence=new EvidenceStore(join(directory,'evidence'));
  const {directory:_directory,key:_key,google:_google,port:_port,publicOrigin:_origin,budgetPath:_budgetPath,mailEnabled:_mailEnabled,browserPortal,workos,classification,publicProxy,publicPaidAccess:_paidAccess,developerFictionalPortal:fictional,inboxLog:_inboxLog,...models}=config;
  let browserContinuation;
  if(fictional?.enabled===true){
   if(!config.google)throw Error('PREPARATION_GOOGLE_REQUIRED');
   if(browserPortal!==undefined)throw Error('BROWSER_PORTAL_CONFLICT');
   if(!isAbsolute(fictional.directory)||!isAbsolute(fictional.chromiumExecutable))throw Error('EXPLICIT_FICTIONAL_PORTAL_CONFIGURATION_REQUIRED');
   portal=await startFictionalPortal(fictional.directory,fictional.port);
   browserContinuation=fictionalPortalContinuation({origin:portal.origin,mapping:fictional.mapping,chromiumExecutable:fictional.chromiumExecutable,budget,decisionModel:config.decisionModel,credential:config.credential,modelTransport:config.modelTransport,processingPaused:config.processingPaused,timeoutMs:fictional.timeoutMs,maxTurns:fictional.maxTurns,browserTimeoutMs:fictional.browserTimeoutMs,providerTimeoutMs:fictional.providerTimeoutMs});
  }
  const preparation=config.google?{...productionPreparation({...models,tasks,store:evidence,budget,workspaceId:'account-private'}),browserPortal,browserContinuation}:undefined;
  const mail:MailServiceConfig|undefined=(paidAccess?config.mailEnabled!==true:config.mailEnabled===false)||!config.google?undefined:{tasks,store:evidence,workspaceId:'account-private',processingPaused:config.processingPaused,maxTurns:Math.min(config.maxTurns??12,16),timeoutMs:config.timeoutMs??300000,toolBudget:config.toolBudget??128,
   provider:c=>new NebiusAgentProvider({model:config.decisionModel,budget,
    credential:async()=>{await c.assertCurrent();const value=await c.track(config.credential());await c.assertCurrent();return value;},
    transport:async(...args)=>{await c.assertCurrent();c.dispatchGuard();const response=await c.track((config.modelTransport??fetch)(...args));try{await c.assertCurrent();return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}},
    timeoutMs:config.timeoutMs??300000,signal:c.signal,persist:new AgentSessionStore(c.store.db).persist})};
  // Inbox triage: one small JSON decision per new email, charged to the same budget journal.
  const triageProvider=new TextProvider({...config.decisionModel,thinking:false,maxOutputTokens:Math.min(config.decisionModel.maxOutputTokens,4096)},budget,async()=>{const key=await config.credential();if(!key)throw Error('MODEL_CREDENTIAL_UNAVAILABLE');return key;},config.modelTransport);
  const inbox=mail&&preparation?{triage:async(email:{from:string;subject:string;body:string})=>parseTriage((await triageProvider.complete(triageSystem,email,{current:()=>true,outputTokens:512,timeoutMs:15000})).value),log:config.inboxLog}:undefined;
  server=await startTrackingServer(config.directory,config.key,config.port??0,config.publicOrigin,config.google,preparation,mail,workos,classification,publicProxy,paidAccess,inbox);
  return {origin:server.origin,listenOrigin:server.listenOrigin,close};
 }catch(error){await close();throw error;}
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--application-module'||!isAbsolute(args[1]))throw Error('Usage: preparation/startup.js --application-module /absolute/trusted-account-configuration.mjs');
 // Same trusted executable-configuration pattern as agent/startup.ts. Never request/model input.
 const module=await import(pathToFileURL(args[1]).href);
 if(typeof module.preparationAccountConfig!=='function')throw Error('Expected trusted preparationAccountConfig()');
 const server=await startPreparationAccount(await module.preparationAccountConfig());
 console.log(`Spindle signed-in preparation: ${server.origin}/connections`);
 const stop=()=>{void server.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main().catch(()=>{console.error('Preparation account startup failed');process.exitCode=1;});
