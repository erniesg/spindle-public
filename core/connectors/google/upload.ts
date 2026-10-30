import { createHash, randomBytes } from 'node:crypto';
import type { GoogleOAuth, GoogleOperation } from './oauth.js';
import { abortRace } from './abort.js';
import { boundedJson } from './bounded.js';

export const driveOutputGrants = {file:'https://www.googleapis.com/auth/drive.file',all:'https://www.googleapis.com/auth/drive'} as const;
export type DriveOutputGrant = typeof driveOutputGrants[keyof typeof driveOutputGrants];
/** Full Drive (granted in the single connect consent) writes straight into the selected folder; drive.file still needs a Picker-authorized parent. */
export async function preferredOutputGrant(oauth:{status(id:string):Promise<{grants:string[]}|undefined>},connectionId:string):Promise<DriveOutputGrant>{
 const grants=(await oauth.status(connectionId))?.grants??[];
 return grants.includes(driveOutputGrants.all)?driveOutputGrants.all:driveOutputGrants.file;
}
/** Trusted host configuration, never model arguments. assertCurrent must fence the
 * authenticated owner/session/incarnation AND the selected-root revision. */
export interface DriveOutputDestination {rootId:string;selectedRoots:ReadonlySet<string>;assertCurrent(options:GoogleOperation):Promise<void>}
export interface DriveOutputContext {signal:AbortSignal;isCurrent():boolean}
/** Resolve a generated (including sanitized session) artifact through EvidenceStore
 * in the authorized namespace first. No paths, URLs or credentials accepted. */
export interface GeneratedDriveArtifact {id:string;mimeType:string;sha256:string;bytes:Uint8Array}
export interface DriveUploadIntent {version:1;accountId:string;connectionEpoch:string;rootId:string;providerId:string;artifactId:string;sha256:string;size:number;name:string;mimeType:string}
export interface DriveUploadResult {intent:DriveUploadIntent;providerVersion:string;mimeType:string;sha256Checksum?:string;verification:'requires_readback'}
export class DriveUploadError extends Error {
 constructor(readonly code:string,readonly effect:'none'|'uncertain'){super(code);this.name='DriveUploadError';}
}
type Access = Awaited<ReturnType<GoogleOAuth['connectorAccess']>>;
const api='https://www.googleapis.com/drive/v3/';
const fields='id,name,mimeType,parents,version,size,trashed,sha256Checksum';
const maxBytes=5*1024*1024;
const mimes=new Set(['application/pdf','image/jpeg','image/png','image/webp','application/json','text/plain','application/zip']);
const id=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(s);
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function validName(s:unknown):s is string{return typeof s==='string'&&Buffer.byteLength(s)<=180&&/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._()\[\]+,\-]*$/u.test(s)&&!/[ .]$/.test(s);}
function artifactSnapshot(a:GeneratedDriveArtifact){
 if(!a||!id(a.id)||!mimes.has(a.mimeType)||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||!(a.bytes instanceof Uint8Array)||a.bytes.length<1||a.bytes.length>maxBytes)throw Error('Invalid generated artifact');
 const bytes=Buffer.from(a.bytes);if(hash(bytes)!==a.sha256)throw Error('Generated artifact hash mismatch');
 return {id:a.id,mimeType:a.mimeType,sha256:a.sha256,bytes};
}
function operation(ctx:DriveOutputContext):DriveOutputContext{return {signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(15000)]),isCurrent:()=>ctx.isCurrent()};}
function discard(response:Response){void response.body?.cancel().catch(()=>{});}

/** Binary-only files.create. No update/delete, conversion, search, or automatic
 * POST retry. This is NOT an atomic transaction with the caller's durable state.
 * Official protocol: https://developers.google.com/workspace/drive/api/guides/manage-uploads
 * (multipart and "Use a pre-generated ID to upload files"). */
class DriveOutputUploader {
 private readonly rootId:string;
 private readonly roots:ReadonlySet<string>;
 private readonly destinationCurrent:DriveOutputDestination['assertCurrent'];
 constructor(private access:Access,destination:DriveOutputDestination,private grant:DriveOutputGrant,private http:typeof fetch){
  this.rootId=destination.rootId;this.roots=new Set(destination.selectedRoots);
  this.destinationCurrent=options=>destination.assertCurrent(options);
 }
 private active(ctx:DriveOutputContext){ctx.signal.throwIfAborted();if(!ctx.isCurrent()||!this.roots.has(this.rootId))throw Error('Stale or unselected destination');}
 private async fence(ctx:DriveOutputContext){
  this.active(ctx);await abortRace(this.destinationCurrent({signal:ctx.signal}),ctx.signal);this.active(ctx);
  await abortRace(this.access.assertCurrent({signal:ctx.signal}),ctx.signal);this.active(ctx);
 }
 private async token(ctx:DriveOutputContext){await this.fence(ctx);const token=await abortRace(this.access.token({signal:ctx.signal}),ctx.signal);await this.fence(ctx);return token;}
 private async request(url:string,init:RequestInit,token:string,ctx:DriveOutputContext,dispatch?:()=>void){
  await this.fence(ctx);this.active(ctx);
  dispatch?.();
  const pending=this.http(url,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`},redirect:'error',signal:ctx.signal});
  // A noncooperative injected transport may return after cancellation. Dispose its
  // response without awaiting disposal or allowing an unhandled late rejection.
  void pending.then(r=>{if(ctx.signal.aborted)discard(r);},()=>{});
  const response=await abortRace(pending,ctx.signal);
  try{await this.fence(ctx);return response;}catch(error){discard(response);throw error;}
 }
 private async json(response:Response,ctx:DriveOutputContext){
  if(!response.ok){discard(response);throw Error('Drive request denied');}
  const result=await boundedJson(response,65536,ctx.signal);await this.fence(ctx);return result;
 }
 private async root(token:string,ctx:DriveOutputContext){
  const m=await this.json(await this.request(`${api}files/${encodeURIComponent(this.rootId)}?fields=id,mimeType,version,trashed,isAppAuthorized,capabilities(canAddChildren)`,{},token,ctx),ctx);
  // A readable ID (possibly visible through drive.readonly) is not proof that
  // drive.file can use an arbitrary existing parent. Do not silently broaden scope.
  if(m.id!==this.rootId||m.mimeType!=='application/vnd.google-apps.folder'||m.trashed!==false||typeof m.version!=='string'||!/^\d{1,40}$/.test(m.version)||m.capabilities?.canAddChildren!==true||(this.grant===driveOutputGrants.file&&m.isAppAuthorized!==true))throw Error('Drive output parent denied');
 }
 private intent(value:DriveUploadIntent):DriveUploadIntent{
  if(!value||value.version!==1||value.accountId!==this.access.accountId||value.connectionEpoch!==this.access.connectionEpoch||value.rootId!==this.rootId||!this.roots.has(value.rootId)||!id(value.providerId)||value.providerId===this.rootId||!id(value.artifactId)||!validName(value.name)||!mimes.has(value.mimeType)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<1||value.size>maxBytes)throw Error('Invalid upload intent');
  return {version:1,accountId:value.accountId,connectionEpoch:value.connectionEpoch,rootId:value.rootId,providerId:value.providerId,artifactId:value.artifactId,sha256:value.sha256,size:value.size,name:value.name,mimeType:value.mimeType};
 }
 private result(m:Record<string,any>,intent:DriveUploadIntent):DriveUploadResult{
  if(m.id!==intent.providerId||m.name!==intent.name||m.mimeType!==intent.mimeType||m.trashed!==false||!Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==this.rootId||typeof m.version!=='string'||!/^\d{1,40}$/.test(m.version)||m.size!==String(intent.size)||(m.sha256Checksum!==undefined&&m.sha256Checksum!==intent.sha256))throw Error('Invalid Drive upload metadata');
  return {intent:{...intent},providerVersion:m.version,mimeType:m.mimeType,...(m.sha256Checksum===undefined?{}:{sha256Checksum:m.sha256Checksum}),verification:'requires_readback'};
 }
 /** Reserve an ID, not a file. MUST durably save this returned intent before
  * upload. Serialize ownership across workers/processes. After timeout/crash,
  * reconcile the SAME ID; never call prepare again as a retry. Caller storage
  * must prevent intent/name/content rebinding, including across restarts. */
 async prepare(artifact:GeneratedDriveArtifact,name:string,context:DriveOutputContext):Promise<DriveUploadIntent>{
  const ctx=operation(context);
  try{
   const a=artifactSnapshot(artifact);if(!validName(name))throw Error('Invalid output name');
   const token=await this.token(ctx);await this.root(token,ctx);
   const m=await this.json(await this.request(`${api}files/generateIds?count=1&space=drive&type=files`,{},token,ctx),ctx);
   if(!Array.isArray(m.ids)||m.ids.length!==1||!id(m.ids[0])||(m.space!==undefined&&m.space!=='drive'))throw Error('Invalid generated Drive ID');
   return this.intent({version:1,accountId:this.access.accountId,connectionEpoch:this.access.connectionEpoch,rootId:this.rootId,providerId:m.ids[0],artifactId:a.id,sha256:a.sha256,size:a.bytes.length,name,mimeType:a.mimeType});
  }catch{throw new DriveUploadError('DRIVE_OUTPUT_PREPARATION_DENIED','none');}
 }
 /** Creates only a NEW binary file with the saved Google-generated ID. Reusing
  * that ID cannot overwrite a source: successful prior create yields 409, which
  * requires exact metadata reconciliation, not assumed success. No auto retry.
  * Any post-dispatch failure is conservatively uncertain, including stale replies. */
 async upload(value:DriveUploadIntent,artifact:GeneratedDriveArtifact,context:DriveOutputContext):Promise<DriveUploadResult>{
  const ctx=operation(context);let dispatched=false;
  try{
   const intent=this.intent(value),a=artifactSnapshot(artifact);
   if(a.id!==intent.artifactId||a.sha256!==intent.sha256||a.mimeType!==intent.mimeType||a.bytes.length!==intent.size)throw Error('Upload artifact changed');
   const token=await this.token(ctx);await this.root(token,ctx);
   let boundary:string;do{boundary=`spindle_${randomBytes(24).toString('hex')}`;}while(a.bytes.includes(boundary));
   // appProperties marks this app's own outputs so later discovery does not mistake them for user sources.
   const metadata=JSON.stringify({id:intent.providerId,name:intent.name,mimeType:intent.mimeType,parents:[this.rootId],appProperties:{spindle:'output'}});
   const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${intent.mimeType}\r\n\r\n`),a.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
   const response=await this.request(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body},token,ctx,()=>{dispatched=true;});
   if(response.status===409){
    discard(response);const reconciled=await this.reconcile(intent,ctx);if(!reconciled)throw Error('Upload conflict unresolved');return reconciled;
   }
   const m=await this.json(response,ctx);return this.result(m,intent);
  }catch{throw new DriveUploadError(dispatched?'DRIVE_OUTPUT_UNCERTAIN':'DRIVE_OUTPUT_UPLOAD_DENIED',dispatched?'uncertain':'none');}
 }
 /** 404 means not observed, NOT proof an in-flight create cannot still complete.
  * Keep the saved ID for any authorized retry. Errors leave prior effects unknown.
  * A matching result still requires DriveReader re-read/hash/version verification. */
 async reconcile(value:DriveUploadIntent,context:DriveOutputContext):Promise<DriveUploadResult|undefined>{
  const ctx=operation(context);
  try{
   const intent=this.intent(value);const token=await this.token(ctx);await this.root(token,ctx);
   const response=await this.request(`${api}files/${encodeURIComponent(intent.providerId)}?fields=${encodeURIComponent(fields)}`,{},token,ctx);
   if(response.status===404){discard(response);await this.fence(ctx);return undefined;}
   return this.result(await this.json(response,ctx),intent);
  }catch{throw new DriveUploadError('DRIVE_OUTPUT_RECONCILIATION_UNAVAILABLE','uncertain');}
 }
}
/** Host-only construction. No scope acquisition/discovery: readonly connections
 * fail assertCurrent BEFORE refresh/network. Broad drive is never a fallback. */
export async function driveOutputUploader(oauth:Pick<GoogleOAuth,'connectorAccess'>,connectionId:string,destination:DriveOutputDestination,grant:DriveOutputGrant,http:typeof fetch=fetch){
 if((grant!==driveOutputGrants.file&&grant!==driveOutputGrants.all)||!id(destination.rootId)||!destination.selectedRoots.has(destination.rootId))throw new DriveUploadError('DRIVE_OUTPUT_DESTINATION_DENIED','none');
 const access=await oauth.connectorAccess(connectionId,grant);
 await access.assertCurrent();
 return new DriveOutputUploader(access,destination,grant,http);
}
