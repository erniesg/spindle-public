import {driveOutputUploader,driveOutputGrants,preferredOutputGrant,type DriveUploadIntent} from '../connectors/google/upload.js';
import {DriveReader} from '../connectors/google/drive.js';
import {scopes} from '../connectors/google/oauth.js';
import type {PreparationContext} from './service.js';
/** Explicit owner recovery is read-only. A 404 never authorizes repost or a new ID. */
export async function reconcilePreparationOutputs(c:PreparationContext):Promise<void>{
 const initial=c.tasks.get(c.taskId),p=initial.preparation!,revision=p.revision;
 const signal=c.processingSignal;
 const current=()=>{const t=c.tasks.get(c.taskId);return t.preparation!.revision===revision&&t.status!=='cancelled';};
 const fence=async()=>{signal.throwIfAborted();if(!current())throw Error('STALE_OUTPUT_RECOVERY');await c.binding.assertCurrent({signal});await c.binding.assertSources(c.scope().sources,{signal});signal.throwIfAborted();if(!current())throw Error('STALE_OUTPUT_RECOVERY');};
 const uploader=await driveOutputUploader(c.binding.oauth,c.binding.connectionId,{rootId:p.rootId,selectedRoots:new Set([p.rootId]),assertCurrent:o=>c.binding.assertCurrent(o)},await preferredOutputGrant(c.binding.oauth,c.binding.connectionId),c.binding.http);
 for(const saved of p.uploads.filter(u=>u.state!=='verified')){
  await fence();const intent=saved.intent as DriveUploadIntent,a=c.store.artifact(c.namespace,saved.artifactId);
  if(!p.artifactIds.includes(a.id)||a.sha256!==intent.sha256||a.bytes!==intent.size||a.mimeType!==intent.mimeType)throw Error('RECOVERY_ARTIFACT_MISMATCH');
  const result=await uploader.reconcile(intent,{signal,isCurrent:current});await fence();if(!result)throw Error('OUTPUT_NOT_OBSERVED_RECONCILIATION_REQUIRED');
  const access=await c.binding.oauth.connectorAccess(c.binding.connectionId,scopes.drive),token=await access.token({signal});await fence();
  const read=await new DriveReader(token,access.accountId,new Set([p.rootId]),c.binding.http,5*1024*1024).read(intent.providerId,signal);await fence();
  if(read.providerVersion!==result.providerVersion||read.mimeType!==a.mimeType||read.sha256!==a.sha256||!read.bytes.equals(c.store.read(c.namespace,a.id,5*1024*1024)))throw Error('RECOVERY_READBACK_MISMATCH');
  const final=await uploader.reconcile(intent,{signal,isCurrent:current});await fence();if(!final||final.providerVersion!==read.providerVersion)throw Error('RECOVERY_OUTPUT_VERSION_CHANGED');
  c.tasks.update(c.taskId,t=>{const u=t.preparation!.uploads.find(u=>u.revision===saved.revision&&u.artifactId===a.id)!;u.state='verified';u.providerId=intent.providerId;u.providerVersion=read.providerVersion;u.url=`https://drive.google.com/file/d/${encodeURIComponent(intent.providerId)}/view`;});
 }
}
