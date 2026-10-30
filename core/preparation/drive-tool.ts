import type {ToolDefinition} from '../agent/contracts.js';
import {DriveReader} from '../connectors/google/drive.js';
import {driveOutputUploader,driveOutputGrants,preferredOutputGrant,type DriveUploadIntent,type DriveUploadResult,DriveUploadError} from '../connectors/google/upload.js';
import {scopes} from '../connectors/google/oauth.js';
import type {PreparationContext} from './service.js';
import {preparationArtifactCurrent} from './artifact-binding.js';
const schema={jsonSchema:{type:'object',properties:{artifactId:{type:'string',minLength:1,maxLength:256},name:{type:'string',minLength:1,maxLength:180}},required:['artifactId','name'],additionalProperties:false},parse(v:unknown){const a=v as {artifactId:string;name:string};if(!a||Object.keys(a).sort().join()!=='artifactId,name'||typeof a.artifactId!=='string'||!a.artifactId||a.artifactId.length>256||typeof a.name!=='string'||!a.name||a.name.length>180)throw Error('Invalid artifact arguments');return a;}};
const output={jsonSchema:{type:'object',properties:{artifactId:{type:'string'},state:{enum:['verified','needs_consent','uncertain']},url:{type:'string'},code:{type:'string'}},required:['artifactId','state']},parse(v:unknown){return v;}};
/** Model-callable output creation; parent/account/revision are host-bound, never model-selected. */
export function createDriveArtifactTool(c:PreparationContext):ToolDefinition {
 return {name:'drive.create_artifact',version:'1',effect:'external_write',capabilities:['drive.create_artifact'],inputSchema:schema,outputSchema:output,
  invoke(value,ctx){return c.serializeOutput(async()=>{
   const {artifactId,name}=value as {artifactId:string;name:string},task=c.tasks.get(c.taskId),p=task.preparation!,revision=p.revision;
   const currentArtifact=()=>preparationArtifactCurrent(c.store,c.namespace,c.tasks.get(c.taskId).preparation!,artifactId);
   // Refusals decided before any Drive request have no effect: answer them as feedback, not unknown writes.
   const refused=(code:string,hint:string)=>({callId:ctx.callId,status:'failed' as const,effect:'none' as const,data:{artifactId,state:'needs_consent' as const,code},artifacts:[],evidence:[],observations:[hint],error:{code,message:code,producer:'drive.create_artifact'}});
   if(!currentArtifact())return refused('OUTPUT_ARTIFACT_STALE','That artifact is not a current output of this preparation; save the latest prepared file instead.');
   const approved=()=>{const now=c.tasks.get(c.taskId).preparation!,intent=c.outputApproval,save=intent&&now.saves?.find(s=>s.id===intent.snapshotId);return intent?!!save&&save.saveOutputs&&save.revision===revision&&save.artifactIds.includes(artifactId)&&intent.artifactIds.includes(artifactId):now.processingConsent&&now.saveOutputs;};
   const fence=async()=>{ctx.signal.throwIfAborted();if(!currentArtifact())throw Error('OUTPUT_ARTIFACT_STALE');if(!ctx.isCurrent()||!approved()||c.tasks.get(c.taskId).preparation!.revision!==revision)throw Error('STALE_OUTPUT_APPROVAL');await c.binding.assertCurrent({signal:ctx.signal});ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('STALE_OUTPUT_APPROVAL');};
   await fence();
   const a=c.store.artifact(c.namespace,artifactId);
   const exported=!!p.artifactBindings?.[artifactId]?.exportKind;
   if(!p.artifactIds.includes(artifactId)||p.sources.some(s=>s.snapshotArtifactId===artifactId)||!['application/pdf','image/jpeg','image/png','image/webp','application/json'].includes(a.mimeType)||a.mimeType==='application/json'&&!exported||!a.derivedFrom.length)return refused('OUTPUT_ARTIFACT_DENIED','Only prepared outputs (PDF or image derived from the sources) can be saved; source files are already in Drive.');
   const artifact={id:a.id,mimeType:a.mimeType,sha256:a.sha256,bytes:c.store.read(c.namespace,a.id,5*1024*1024)};
   // Only drive.file. No full-Drive fallback; provider parent authorization is checked by uploader.
   let uploader:Awaited<ReturnType<typeof driveOutputUploader>>;
   try{uploader=await driveOutputUploader(c.binding.oauth,c.binding.connectionId,{rootId:c.binding.rootId,selectedRoots:new Set([c.binding.rootId]),assertCurrent:options=>c.binding.assertCurrent(options)},await preferredOutputGrant(c.binding.oauth,c.binding.connectionId),c.binding.http);}
   catch{return {callId:ctx.callId,status:'needs_input',effect:'none',data:{artifactId,state:'needs_consent',code:'GOOGLE_OUTPUT_CONSENT_REQUIRED'},artifacts:[],evidence:[],observations:['Local preparation retained. Owner must grant drive.file and authorize this selected parent in Google; readonly access does not permit creation.']};}
   const op={signal:ctx.signal,isCurrent:ctx.isCurrent};
   let saved=c.tasks.get(c.taskId).preparation!.uploads.find(u=>u.revision===revision&&u.artifactId===artifactId);
   if(saved&&saved.name!==name)throw Error('OUTPUT_INTENT_NAME_IMMUTABLE');
   try{
    let result:DriveUploadResult|undefined;
    if(saved){
     // Every repeated call reconciles the original ID before doing anything. Never automatically rePOST.
     result=await uploader.reconcile(saved.intent as DriveUploadIntent,op);await fence();
     if(!result)throw Error('OUTPUT_NOT_OBSERVED_RECONCILIATION_REQUIRED');
    }else{
     const intent=await uploader.prepare(artifact,name,op);await fence();
     // FULL durable commit of exact Google ID/name/hash BEFORE dispatching POST.
     c.tasks.update(c.taskId,t=>{if(t.preparation!.revision!==revision)throw Error('STALE_OUTPUT_REVISION');t.preparation!.uploads.push({revision,artifactId,name,state:'intent',intent});});
     saved=c.tasks.get(c.taskId).preparation!.uploads.find(u=>u.revision===revision&&u.artifactId===artifactId)!;
     result=await uploader.upload(intent,artifact,op);await fence();
    }
    // Independently read exact new provider bytes through the existing selected-root reader.
    const access=await c.binding.oauth.connectorAccess(c.binding.connectionId,scopes.drive);await fence();
    const token=await access.token({signal:ctx.signal});await fence();
    // A freshly created Drive file may bump its version once after creation (post-processing). Proof is the
    // exact bytes plus parent/name/MIME at a version that is stable across the readback; retry briefly on drift.
    const reader=new DriveReader(token,access.accountId,new Set([c.binding.rootId]),c.binding.http,5*1024*1024);
    let read:Awaited<ReturnType<DriveReader['read']>>|undefined,final:DriveUploadResult|undefined;
    for(let attempt=0;attempt<3&&!final;attempt++){
     if(attempt)await new Promise(resolve=>setTimeout(resolve,1500*attempt));
     try{read=await reader.read(result.intent.providerId,ctx.signal);}catch(error){if((error as Error)?.message==='Drive source changed during retrieval')continue;throw error;}
     await fence();
     if(read.mimeType!==a.mimeType||read.sha256!==a.sha256||!read.bytes.equals(artifact.bytes))throw Error('OUTPUT_READBACK_MISMATCH');
     // Reconcile exact parent/name/MIME/version again after bytes, rather than trusting a JSON200.
     const now=await uploader.reconcile(result.intent,op);await fence();if(!now)throw Error('OUTPUT_NOT_OBSERVED_RECONCILIATION_REQUIRED');
     if(now.providerVersion===read.providerVersion)final=now;
    }
    if(!read||!final)throw Error('OUTPUT_VERSION_CHANGED');
    const url=`https://drive.google.com/file/d/${encodeURIComponent(result.intent.providerId)}/view`;
    c.tasks.update(c.taskId,t=>{const u=t.preparation!.uploads.find(u=>u.revision===revision&&u.artifactId===artifactId)!;u.state='verified';u.providerId=result!.intent.providerId;u.providerVersion=read.providerVersion;u.url=url;});
    return {callId:ctx.callId,status:'ok',data:{artifactId,state:'verified',url,providerId:result.intent.providerId,providerVersion:read.providerVersion,sha256:read.sha256,rootId:c.binding.rootId,mimeType:read.mimeType,bytes:read.bytes.length},artifacts:[],evidence:[],observations:['New Drive file verified by exact parent/name/MIME/version metadata and independent exact-byte readback. Original sources unchanged.']};
   }catch(error){
    // Preserve external facts even if run/session/revision was revoked after dispatch. No success publication.
    if(!saved&&error instanceof DriveUploadError&&error.effect==='none')return {callId:ctx.callId,status:'needs_input',data:{artifactId,state:'needs_consent',code:error.code},artifacts:[],evidence:[],observations:['No output POST was dispatched. Verify genuine write consent and Google app authorization/canAddChildren for this selected parent; local work is retained.']};
    if(saved)c.tasks.update(c.taskId,t=>{const u=t.preparation!.uploads.find(u=>u.revision===revision&&u.artifactId===artifactId);if(u)u.state='uncertain';t.recovery='reconciliation_required';});
    throw error;
   }
  });}
 };
}
