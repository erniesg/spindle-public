import { createHash } from 'node:crypto';
import { boundedBytes, boundedJson, text } from './bounded.js';
export type DriveFailureCode='drive_http_denied'|'drive_not_found'|'drive_provider_unavailable'|'drive_metadata_invalid'|'drive_scope_denied'|'drive_version_changed'|'drive_list_invalid'|'drive_folder_needs_listing';
/** Safe category/status only: never retain provider bodies, tokens or source names. */
export class DriveFailure extends Error {constructor(readonly code:DriveFailureCode,message:string,readonly httpStatus?:number){super(message);}}
export class DriveReader {
 private roots:ReadonlySet<string>;
 constructor(private token:string,private accountId:string,roots:ReadonlySet<string>,private http:typeof fetch=fetch,private maxDownloadBytes=32*1024*1024){this.roots=new Set(roots);}
 private async request(path:string,signal?:AbortSignal){
  const active=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);active.throwIfAborted();
  const r=await this.http(`https://www.googleapis.com/drive/v3/${path}`,{headers:{Authorization:`Bearer ${this.token}`},signal:active});
  if(active.aborted){await r.body?.cancel().catch(()=>{});active.throwIfAborted();}
  if(!r.ok){void r.body?.cancel().catch(()=>{});throw new DriveFailure(r.status===401||r.status===403?'drive_http_denied':r.status===404?'drive_not_found':'drive_provider_unavailable',`Drive ${r.status}: access blocked`,r.status);}
  return r;
 }
 private async metadata(id:string,signal?:AbortSignal):Promise<any>{
  const m=await boundedJson(await this.request(`files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,version,webViewLink,trashed`,signal));signal?.throwIfAborted();
  // A host-selected root need not expose its own parent. Descendant ancestry still must be explicit.
  if(m.id!==id||!text(m.mimeType)||!text(m.version)||(!Array.isArray(m.parents)&&!(m.parents===undefined&&this.roots.has(id)))||(Array.isArray(m.parents)&&!m.parents.every(text))||typeof m.trashed!=='boolean')throw new DriveFailure('drive_metadata_invalid','Invalid Drive metadata');
  return m;
 }
 private async allowed(id:string,signal?:AbortSignal,seen=new Set<string>()):Promise<boolean>{
  if(seen.has(id)||seen.size>=100)return false;seen.add(id);const m=await this.metadata(id,signal);
  if(this.roots.has(id)){if(m.trashed||m.mimeType!=='application/vnd.google-apps.folder')throw new DriveFailure('drive_scope_denied','Invalid selected Drive root');return true;}
  if(m.trashed||m.mimeType==='application/vnd.google-apps.shortcut')return false;
  for(const parent of m.parents??[])if(await this.allowed(parent,signal,seen))return true;return false;
 }
 /** Verify a selected folder without listing children or downloading content. */
 async checkRoot(id:string,signal?:AbortSignal){
  if(!this.roots.has(id))throw new DriveFailure('drive_scope_denied','Outside selected Drive roots');
  const m=await boundedJson(await this.request(`files/${encodeURIComponent(id)}?fields=id,name,mimeType,version,trashed`,signal));signal?.throwIfAborted();
  if(m.id!==id||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||!text(m.version))throw new DriveFailure('drive_scope_denied','Invalid selected Drive root');
  return {providerId:id,providerVersion:m.version as string,mimeType:m.mimeType as string,...(text(m.name)?{name:(m.name as string).slice(0,200)}:{})};
 }
 /** Metadata-only currentness check for a previously preserved source snapshot. */
 async checkVersion(id:string,version:string,signal?:AbortSignal){if(!await this.allowed(id,signal))throw new DriveFailure('drive_scope_denied','Outside selected Drive roots');const m=await this.metadata(id,signal);if(m.version!==version)throw new DriveFailure('drive_version_changed','Drive source version changed');return true;}
 async list(folder:string,pageToken?:string,signal?:AbortSignal){
  if(!await this.allowed(folder,signal))throw new DriveFailure('drive_scope_denied','Outside selected Drive roots');
  const q=new URLSearchParams({q:`'${folder.replaceAll('\\','\\\\').replaceAll("'","\\'")}' in parents and trashed = false`,fields:'nextPageToken,files(id,name,mimeType,version,webViewLink)',pageSize:'100'});if(pageToken)q.set('pageToken',pageToken);
  const result=await boundedJson(await this.request(`files?${q}`,signal));signal?.throwIfAborted();
  if(!Array.isArray(result.files)||result.files.some((f:any)=>!f||!text(f.id)||!text(f.name)||!text(f.mimeType)||!text(f.version))||(result.nextPageToken!==undefined&&!text(result.nextPageToken)))throw new DriveFailure('drive_list_invalid','Invalid Drive list');return result;
 }
 async read(id:string,signal?:AbortSignal){
  if(!await this.allowed(id,signal))throw new DriveFailure('drive_scope_denied','Outside selected Drive roots');const before=await this.metadata(id,signal);
  if(before.mimeType==='application/vnd.google-apps.folder')throw new DriveFailure('drive_folder_needs_listing','Select a discovered file, not a Drive folder');
  const native=before.mimeType.startsWith('application/vnd.google-apps.');
  const response=await this.request(`files/${encodeURIComponent(id)}${native?'/export?mimeType=application%2Fpdf':'?alt=media'}`,signal);const bytes=await boundedBytes(response,this.maxDownloadBytes);signal?.throwIfAborted();
  const after=await this.metadata(id,signal);if(before.version!==after.version||!await this.allowed(id,signal))throw new DriveFailure('drive_version_changed','Drive source changed during retrieval');
  return {bytes,accountId:this.accountId,providerId:id,providerVersion:String(before.version),originalUrl:before.webViewLink,mimeType:native?'application/pdf':before.mimeType,sha256:createHash('sha256').update(bytes).digest('hex'),retrievedAt:new Date().toISOString()};
 }
}
