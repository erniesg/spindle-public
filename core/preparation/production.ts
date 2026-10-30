import {createHash,randomUUID} from 'node:crypto';
import type {AgentOperationEnvelope} from '../models/agent-session-store.js';
import type {PreparationConfig,PreparationContext} from './service.js';
import {NebiusAgentProvider} from '../models/agent-provider.js';
import {TextProvider,ModelError,worstCaseUsd,type ModelDeclaration,type Completion} from '../models/provider.js';
import type {FileCallBudget} from '../models/file-budget.js';
import {createImageTools} from '../tools/images.js';
import {createDocumentTools} from '../tools/documents.js';
import {createNebiusOcrTool} from '../tools/nebius-ocr.js';
import {createOcrRegionTool} from '../tools/ocr.js';
import type {ToolContext,ToolDefinition} from '../agent/contracts.js';
import {preparationPageGeometry} from './page-geometry.js';
import type {ImageVisionOptions} from '../tools/image-vision.js';
import {createDriveArtifactTool} from './drive-tool.js';
import {groundedDocumentTool} from './tools.js';
import {preparationBudget} from './budget.js';
import {TavilySearch} from '../tools/web.js';
import {createWebSearchTools} from '../tools/web-search.js';
import {createSkillTool} from './skills.js';
import {createFormFillTools} from './form-fill.js';
/** Background matting peaks near 6 GB (fixed 1024px BiRefNet input), so at most one runs on this host at a time, across all tasks. */
let matting:Promise<unknown>=Promise.resolve();
function oneMatteAtATime<T extends {invoke:(...a:any[])=>Promise<any>}>(t:T):T{return {...t,invoke:(...a:any[])=>{const run=matting.catch(()=>{}).then(()=>t.invoke(...a));matting=run;return run;}};}
export interface ProductionPreparationOptions extends Pick<PreparationConfig,'tasks'|'store'|'workspaceId'|'buildIdentity'|'sourceIdentity'|'maxTurns'|'timeoutMs'|'toolBudget'|'limits'|'processingPaused'|'processingPauseReason'> {
 /** Existing shared cumulative journal; never opened/created/reset by this facade. */
 budget:FileCallBudget;decisionModel:ModelDeclaration;visionModel:ModelDeclaration;credential:()=>Promise<string|undefined>;
 /** Optional independent OCR second reader (same Nebius endpoint/budget), called in parallel with visionModel. */
 secondaryVisionModel?:ModelDeclaration;
 /** Optional public web search (Tavily) for requirements/specs; credential is read lazily per search. */
 webSearch?:{credential:()=>Promise<string|undefined>};
 modelTransport?:typeof fetch;
 images?:Omit<NonNullable<Parameters<typeof createImageTools>[1]>,'vision'>;
 documents?:NonNullable<Parameters<typeof createDocumentTools>[1]>;
}
/** Normal production assembly: one existing runtime, actual Nebius adapters and existing tool factories.
 * No fixture provider, provider fallback, model-selected configuration or credential discovery. */
const custodyQueues=new Map<string,Promise<unknown>>();
export function productionPreparation(options:ProductionPreparationOptions):PreparationConfig {
 if(options.decisionModel.provider!=='nebius'||options.visionModel.provider!=='nebius'||!options.visionModel.images||options.secondaryVisionModel&&(options.secondaryVisionModel.provider!=='nebius'||!options.secondaryVisionModel.images))throw Error('NEBIUS_PREPARATION_MODELS_REQUIRED');
 const custody=(c:PreparationContext)=>{
  const initial=c.tasks.get(c.taskId).preparation!,revision=initial.revision;
  // Re-checks are serialized per task: concurrent readers refreshing the same Google credential raced
  // ("Connection changed") and invalidated each other. Model calls themselves still run in parallel.
  // The queue is shared by the decision provider and the tools of the same task (separate custody() calls).
  const check=()=>{const next=(custodyQueues.get(c.taskId)??Promise.resolve()).catch(()=>{}).then(checkWithRetry);custodyQueues.set(c.taskId,next);void next.finally(()=>{if(custodyQueues.get(c.taskId)===next)custodyQueues.delete(c.taskId);}).catch(()=>{});return next;};
  // A credential refresh that lost a compare-and-set to another refresher asks to be retried; do so once.
  const checkWithRetry=async()=>{try{return await checkOnce();}catch(error){if(error instanceof Error&&/Connection changed: retry/.test(error.message))return checkOnce();throw error;}};
  const checkOnce=async()=>{if(options.processingPaused)throw Error('PREPARATION_PROCESSING_PAUSED');const t=c.tasks.get(c.taskId),p=t.preparation!;if(t.status!=='working'||!p.processingConsent||p.revision!==revision)throw Error('PREPARATION_PROCESSING_REVOKED');await c.binding.assertCurrent();await c.binding.assertSources(c.scope().sources);const after=c.tasks.get(c.taskId);if(after.status!=='working'||!after.preparation!.processingConsent||after.preparation!.revision!==revision)throw Error('STALE_PREPARATION');};
  const credential=()=>c.track((async()=>{await check();const key=await options.credential();await check();return key;})());
  const transport:typeof fetch=(input,init)=>c.track((async()=>{await check();init?.signal?.throwIfAborted();const response=await (options.modelTransport??fetch)(input,init);try{await check();return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}})());
  return {credential,transport,revision};
 };
 const limits=options.limits??{limitUsd:0.3,maximumDecisionCalls:16,maximumVisionCalls:3};
 const describeSource:PreparationConfig['describeSource']=async(c,ctx,sourceId)=>{
  const inspect=(prepared.tools(c) as ToolDefinition[]).find(t=>t.name==='image.inspect');if(!inspect)return undefined;
  const r=await inspect.invoke(inspect.inputSchema.parse({inputId:sourceId,parameters:{focus:'In one short sentence say what this is (e.g. a portrait photo of a person; a bank passbook page showing account details; a printed form). No regions needed.'}}),ctx);
  const d=(r.data as {semantic?:{description?:string}}|null)?.semantic?.description;return d?d.split(/(?<=[.!?])\s/)[0]!.slice(0,200):undefined;
 };
 const prepared:PreparationConfig={...options,describeSource,modelStatus:{endpoint:'https://api.tokenfactory.nebius.com/v1/chat/completions',globalLimitUsd:options.budget.snapshot().limitUsd,maximumWholeTaskReservationUsd:Math.ceil((worstCaseUsd(options.decisionModel,options.decisionModel.maxOutputTokens)*limits.maximumDecisionCalls+worstCaseUsd(options.visionModel,Math.min(4096,options.visionModel.maxOutputTokens))*limits.maximumVisionCalls)*1e9)/1e9,decision:{modelId:options.decisionModel.id,inputContextTokens:options.decisionModel.inputContextTokens,maxOutputTokens:options.decisionModel.maxOutputTokens},vision:{modelId:options.visionModel.id,inputContextTokens:options.visionModel.inputContextTokens,maxOutputTokens:Math.min(4096,options.visionModel.maxOutputTokens),imageTokensUpperBound:options.visionModel.images.inputTokensUpperBound,imageAccounting:options.visionModel.images.accounting}},
  provider:c=>{if(options.processingPaused)throw Error('PREPARATION_PROCESSING_PAUSED');const k=custody(c);return new NebiusAgentProvider({model:options.decisionModel,budget:preparationBudget(c.tasks,c.taskId,options.budget,'decision'),credential:k.credential,transport:k.transport,timeoutMs:options.timeoutMs??300000,persist:c.sessions.persist});},
  tools:c=>{
   const k=custody(c);let operationBinding:Parameters<ImageVisionOptions['admit']>[0]|undefined;
   const visionProvider=(model:ModelDeclaration)=>new class extends TextProvider {
    override async complete(...args:Parameters<TextProvider['complete']>):Promise<Completion>{
     const binding=operationBinding;if(!binding)throw Error('VISION_SOURCE_ADMISSION_REQUIRED');
     const t=c.tasks.get(c.taskId),envelope:AgentOperationEnvelope={id:randomUUID(),workspaceId:c.namespace.workspaceId,accountId:c.namespace.accountId,taskId:c.taskId,runId:t.run.id,revision:t.preparation!.revision,kind:'vision',model:this.model.id,configDigest:createHash('sha256').update(JSON.stringify(this.model)).digest('hex'),inputArtifactId:binding.artifactId,inputHash:binding.inputHash,sourceIds:binding.roots.map(r=>r.sourceId),status:'attempt',usage:null};
     await c.sessions.persistOperation(envelope);
     let completion:Completion;
     try{completion=await super.complete(...args);}catch(error){await c.sessions.persistOperation({...envelope,status:'failed',errorCode:error instanceof ModelError?error.code:'VISION_OPERATION_FAILED'});throw error;}
     await c.sessions.persistOperation({...envelope,status:'completed',promptDigest:completion.promptDigest,usage:completion.usage});return completion;
    }
   }(model,preparationBudget(c.tasks,c.taskId,options.budget,'vision'),async()=>{const key=await k.credential();if(!key)throw Error('CREDENTIAL_UNAVAILABLE');return key;},k.transport);
   const provider=visionProvider(options.visionModel),secondProvider=options.secondaryVisionModel?visionProvider(options.secondaryVisionModel):undefined;
   const admit:ImageVisionOptions['admit']=binding=>{
    const isCurrent=()=>{const t=c.tasks.get(c.taskId),p=t.preparation!;return !options.processingPaused&&t.status==='working'&&p.revision===k.revision&&p.processingConsent&&binding.workspaceId===c.namespace.workspaceId&&binding.accountId===c.namespace.accountId&&binding.roots.length>0&&binding.roots.every(r=>p.sources.some(s=>s.id===r.sourceId&&s.sha256===r.sha256));};
    if(!isCurrent())return undefined;operationBinding=binding;return {signal:c.processingSignal,isCurrent};
   };
   const ocrOptions={store:c.store,provider,secondProvider,admit,maximumSpans:16,pythonExecutable:options.images?.pythonExecutable,resolvePageGeometry:(ctx:ToolContext,inputArtifactId:string)=>preparationPageGeometry(c,ctx,inputArtifactId)};
   // Semantic inspect persists a model envelope; it is not a pure read. Serialize
   // these invocations so each source-specific egress binding owns its actual call.
   const images=createImageTools(c.store,{...options.images,vision:{provider,admit}}).map(t=>t.name==='image.inspect'?{...t,effect:'write_local' as const,artifactFieldIds:()=>[]}:({...t,artifactFieldIds:t.name==='image.text_overlay'?(args:unknown)=>{const text=(args as {parameters:{text:string}}).parameters.text;return c.tasks.get(c.taskId).preparation!.fields.filter(f=>f.value.length>0&&text.includes(f.value)).map(f=>f.id);}:()=>[]}));
   // Enforce that serialization: parallel batch calls queue on one lock instead of sharing operationBinding.
   let egress:Promise<unknown>=Promise.resolve();
   const serial=<T extends {name:string;invoke:(...a:any[])=>Promise<any>}>(t:T):T=>({...t,invoke:(...a:any[])=>{const run=egress.catch(()=>{}).then(()=>t.invoke(...a));egress=run;return run;}});
   return [...images.map(t=>t.name==='image.inspect'?serial(t):t.name==='image.remove_background'?oneMatteAtATime(t):t),...createDocumentTools(c.store,options.documents).map(t=>['document.edit','document.overlay'].includes(t.name)?groundedDocumentTool(t,c):({...t,artifactFieldIds:()=>[]})),serial({...createNebiusOcrTool(ocrOptions),artifactFieldIds:()=>[]}),{...createOcrRegionTool({store:c.store,pythonExecutable:options.images?.pythonExecutable}),artifactFieldIds:()=>[]},createDriveArtifactTool(c),createSkillTool(),...(options.documents?.pdftotextExecutable&&options.documents?.pdftoppmExecutable?createFormFillTools(c,createDocumentTools(c.store,options.documents).find(t=>t.name==='document.overlay')!,{pdftotextExecutable:options.documents.pdftotextExecutable,pdftoppmExecutable:options.documents.pdftoppmExecutable,pythonExecutable:options.images?.pythonExecutable}):[]),...(options.webSearch?createWebSearchTools({store:c.store,search:new TavilySearch(options.webSearch.credential),admit:source=>{c.tasks.update(c.taskId,t=>{if(!t.preparation!.sources.some(s=>s.id===source.id))t.preparation!.sources.push(source);});},blockedTerms:()=>{
    // Everything captured from the owner's documents stays local: recorded values, OCR text and file names.
    const t=c.tasks.get(c.taskId),p=t.preparation!;
    const ocr=t.observations.flatMap(o=>{const d=o.data as {kind?:string;spans?:{text:string}[]}|null;return d?.kind==='spindle.ocr.v1'?(d.spans??[]).map(s=>s.text):[];});
    return [...p.fields.map(f=>f.value),...ocr,...Object.values(p.sourceNames??{})].filter(v=>typeof v==='string'&&v.trim().length>=4);
   }}):[])];
  }
 };
 return prepared;
}
