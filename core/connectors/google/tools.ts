import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/contracts.js';
import { EvidenceStore } from '../../evidence/store.js';
import { GoogleOAuth, scopes } from './oauth.js';
import { abortRace } from './abort.js';
import { SelectedMail } from './mail.js';
import { DriveReader,DriveFailure } from './drive.js';
import {GoogleOAuthFailure} from './oauth.js';
import {isEvidenceStoreFault} from '../../evidence/inputs.js';
const text = {type:'string',minLength:1,maxLength:8192};
const partId = {...text,minLength:0};
const object = (properties:Record<string,unknown>,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const sourceKeys=['id','provider','accountId','providerId','providerVersion','originalUrl','mimeType','sha256','snapshotArtifactId','retrievedAt'];
const sourceShape=object(Object.fromEntries(sourceKeys.map(k=>[k,{...text,...(k==='id'?{description:'Local provenance source ID; accepted by local document/image tools, NOT a Google file ID.'}:k==='providerId'?{description:'Provider identifier: Drive file ID after read, folder ID for a listing. Listing files[].id are provider IDs usable by drive.read.'}:k==='snapshotArtifactId'?{description:'Local immutable artifact ID for document/image inputId; use after successful drive.read.'}:{})}])),sourceKeys.filter(k=>k!=='originalUrl'));
const optionalText={type:'string',maxLength:65536};
const messageShape=object({subject:optionalText,from:optionalText,text:optionalText,mimeType:{type:'string',maxLength:32}});
const listingShape=object({files:{type:'array',maxItems:100,items:object({id:{...text,description:'Observed provider file/folder ID: use a file ID with drive.read or folder ID with drive.list; not a local artifact/source ID.'},name:text,mimeType:text,version:text,webViewLink:text},['id','name','mimeType','version'])},nextPageToken:text},['files']);
const artifactShape=object({...Object.fromEntries(['id','mimeType','sha256','relativePath','createdAt'].map(k=>[k,{...text,...(k==='id'?{description:'Immutable local artifact ID. Use this for document/image inputId after successful drive.read.'}:{})}])),bytes:{type:'integer',minimum:0,maximum:33554432},derivedFrom:{type:'array',maxItems:100,items:text},version:{const:1}});
const successShape=object({source:sourceShape,artifact:artifactShape,parts:{type:'array',maxItems:1000,items:partId},message:messageShape,search:object({messages:{type:'array',maxItems:100,items:object({id:text})},nextPageToken:text},['messages']),listing:listingShape},['source','artifact']);
const sourceCodes=['source_unavailable','needs_discovery','needs_selected_root','source_scope_denied','source_permission_denied','source_not_found_or_denied','source_metadata_invalid','source_version_changed','source_provider_unavailable','source_connection_unavailable'];
const failureShape=object({code:{type:'string',enum:sourceCodes},nextAction:text,category:text,correlationId:text,httpStatus:{type:'integer',minimum:100,maximum:599}},['code','nextAction']);
class SourceContractFailure extends Error {constructor(readonly code:string,readonly nextAction:string){super(code);}}
function failure(error:unknown,callId:string){
 let code='source_unavailable',category='unknown',nextAction='Inspect this failed source operation before retrying; no source snapshot was committed.',httpStatus:number|undefined;
 if(error instanceof SourceContractFailure){code=error.code;category='identifier';nextAction=error.nextAction;}
 else if(error instanceof DriveFailure){httpStatus=error.httpStatus;category=error.code;code=error.code==='drive_http_denied'?'source_permission_denied':error.code==='drive_not_found'?'source_not_found_or_denied':error.code==='drive_scope_denied'?'source_scope_denied':error.code==='drive_version_changed'?'source_version_changed':error.code==='drive_folder_needs_listing'?'needs_discovery':['drive_metadata_invalid','drive_list_invalid'].includes(error.code)?'source_metadata_invalid':'source_provider_unavailable';nextAction=code==='needs_discovery'?'Use drive.list {} to discover files in the bound folder, then drive.read with a returned files[].id.':code==='source_scope_denied'?'Stay within the host-selected folder and its observed descendants.':code==='source_version_changed'?'Rediscover the selected source and inspect its current version.':code==='source_metadata_invalid'?'Provider metadata did not match the requested observed ID; use drive.list {} instead of guessing IDs.':'Check the recorded provider category/status and the existing connection; do not infer missing write permission for a readonly operation.';}
 else if(error instanceof GoogleOAuthFailure){code='source_connection_unavailable';category=error.code;httpStatus=error.status;nextAction='Check this existing connection and its actual readonly grant/status; do not reset accounts or infer a write grant.';}
 else if(error instanceof SyntaxError){code='source_metadata_invalid';category='metadata_parse';nextAction='Provider metadata could not be parsed safely; inspect this correlation and refresh scoped discovery. No provider body is retained in the error.';}
 return {code,nextAction,category,correlationId:callId,...(httpStatus===undefined?{}:{httpStatus})};
}
function validate(shape:any,value:any):void {
 if(shape.const!==undefined){if(value!==shape.const)throw Error('Invalid source constant');return;}
 if(shape.enum!==undefined&&!shape.enum.includes(value))throw Error('Invalid source category');
 if(shape.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(shape.properties,k))||shape.required.some((k:string)=>!Object.hasOwn(value,k)))throw Error('Invalid source object');
  for(const k of Object.keys(value))validate(shape.properties[k],value[k]);
 }else if(shape.type==='string'){if(typeof value!=='string'||value.length<(shape.minLength??0)||value.length>shape.maxLength)throw Error('Invalid source string');}
 else if(shape.type==='array'){if(!Array.isArray(value)||value.length>shape.maxItems)throw Error('Invalid source array');for(const item of value)validate(shape.items,item);}
 else if(!Number.isSafeInteger(value)||value<shape.minimum||value>shape.maximum)throw Error('Invalid source number');
}
const outputSchema={jsonSchema:{oneOf:[successShape,failureShape]},parse(value:unknown){validate(value && typeof value==='object' && 'code' in value?failureShape:successShape,value);return value;}};
/** Factory callers own admission. Model args identify only previously admitted messages/parts. */
export async function googleSourceTools(oauth:GoogleOAuth,connectionId:string,workspaceId:string,messages:ReadonlySet<string>,store:EvidenceStore,http:typeof fetch=fetch,driveRoots?:ReadonlySet<string>,queries:ReadonlyMap<string,string>=new Map(),binding?:{ownerId:string;assertCurrent(ctx:ToolContext):Promise<void>;admit(source:import('../../evidence/types.js').SourceRef,ctx:ToolContext):void}):Promise<ToolDefinition[]> {
 const access=await oauth.connectorAccess(connectionId,scopes.mail);
 const mail=new SelectedMail(access,messages,http,queries);
 const schema=(keys:string[],optional:string[]=['pageToken'])=>({jsonSchema:{type:'object',properties:Object.fromEntries(keys.map(k=>[k,{...(k==='partId'?partId:text),...(k==='folderId'?{description:'Omit to list the single HOST-BOUND selected root. Literal root means ONLY that bound folder, never Google My Drive. Explicit subfolders must be observed in scoped listings.'}:k==='fileId'?{description:'Use files[].id returned by drive.list, or an already-admitted Drive source/artifact reference. Never the user request snapshot UUID or a guessed ID.'}:{})}])),required:keys.filter(k=>!optional.includes(k)),additionalProperties:false},parse(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.filter(k=>!optional.includes(k)).some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>typeof (value as any)[k]!=='string'||(k!=='partId'&&!(value as any)[k])||(value as any)[k].length>8192))throw Error('Invalid source arguments');return value;}});
 const active=(ctx:ToolContext)=>{if(ctx.workspaceId!==workspaceId||ctx.accountId!==(binding?.ownerId??access.accountId))throw Error('Source namespace denied');ctx.signal.throwIfAborted();if(!ctx.isCurrent())throw Error('Stale source operation');};
 function tool(name:string,keys:string[],read:(args:any,ctx:ToolContext)=>Promise<any>,authority=access,options:{optional?:string[];prepare?:(args:any,ctx:ToolContext)=>any;committed?:(result:any,ctx:ToolContext)=>void}={}):ToolDefinition{return {
  name,version:'1',capabilities:[name],effect:'write_local',inputSchema:schema(keys,options.optional),outputSchema,
  async invoke(args,ctx):Promise<ToolResult>{let result:any;try{
   active(ctx);if(binding)await abortRace(binding.assertCurrent(ctx),ctx.signal);await abortRace(authority.assertCurrent({signal:ctx.signal}),ctx.signal);active(ctx);
   const prepared=options.prepare?options.prepare(args,ctx):args;
   result=await abortRace(read(prepared,ctx),ctx.signal);active(ctx);
   // Protected account, stable epoch and required grant are checked after retrieval,
   // at the last await before this store's synchronous filesystem/SQLite commit.
   await abortRace(authority.assertCurrent({signal:ctx.signal}),ctx.signal);if(binding)await abortRace(binding.assertCurrent(ctx),ctx.signal);active(ctx);
  }catch(error){if(isEvidenceStoreFault(error))throw error;const data=failure(error,ctx.callId);return {callId:ctx.callId,status:error instanceof SourceContractFailure||data.code==='needs_discovery'?'needs_input':'failed',effect:'none',data,artifacts:[],evidence:[],observations:[],error:{code:data.code,message:data.nextAction,producer:name}};}
   // Local commit failures must propagate to runtime reconciliation, not become ordinary network failures.
   const snapshot=store.put({workspaceId,accountId:binding?.ownerId??access.accountId},result.bytes,result.mimeType,[],{provider:name.startsWith('mail.')?'gmail':'drive',accountId:access.accountId,providerId:result.providerId,providerVersion:result.providerVersion,...(result.originalUrl === undefined ? {} : {originalUrl:result.originalUrl})});
   if(binding&&snapshot.source)binding.admit(snapshot.source,ctx);
   options.committed?.(result,ctx);
   return {callId:ctx.callId,status:'ok',data:{...snapshot,...(result.parts ? {parts:result.parts} : {}),...(result.message ? {message:result.message} : {}),...(result.search ? {search:result.search} : {}),...(result.listing ? {listing:result.listing} : {})},artifacts:[snapshot.artifact],evidence:[{id:snapshot.source!.id,sourceId:snapshot.source!.id,sourceVersion:result.providerVersion,artifactId:snapshot.artifact.id}],observations:['Original provider bytes preserved in namespace-scoped snapshot']};
  }
 };}
 const searchTool=tool('mail.search',['queryReference'],(a,c)=>mail.search(a.queryReference,c.signal));
 const selectedRoots=driveRoots && new Set(driveRoots);
 const tools=[tool('mail.read',['messageId'],(a,c)=>mail.read(a.messageId,c.signal)),tool('mail.attachments',['messageId','partId'],(a,c)=>mail.attachment(a.messageId,a.partId,c.signal))];
 tools.push(searchTool);
 if(selectedRoots){
  const drive=await oauth.connectorAccess(connectionId,scopes.drive);
  if(drive.accountId!==access.accountId)throw Error('Drive account mismatch');
  type Inventory={folders:Set<string>;files:Map<string,string>};
  // Bounded convenience cache, never a new authority/store. Real preparation rebuilds
  // it from hash/namespace-bound listing snapshots in the current trusted Task scope.
  const inventories=new Map<string,Inventory>();
  const inventory=(ctx:ToolContext)=>{
   const key=ctx.accountId+':'+ctx.taskId;let found=binding?undefined:inventories.get(key);
   // Bound preparation authority is rebuilt from the CURRENT trusted scope on
   // every call. Cache lifetime must never preserve a withdrawn listing grant.
   if(!found){if(!binding&&inventories.size>=64)inventories.delete(inventories.keys().next().value!);found={folders:new Set(selectedRoots),files:new Map()};if(!binding)inventories.set(key,found);}
   const ns={workspaceId:ctx.workspaceId,accountId:ctx.accountId};
   const listings=ctx.scope.sources.filter(s=>s.provider==='drive'&&s.providerVersion==='observed-listing');
   const admitted=new Set<string>();
   for(let pass=0;pass<Math.min(64,listings.length);pass++)for(const ref of listings){
    if(admitted.has(ref.id)||!ref.providerId||!found.folders.has(ref.providerId))continue;
    const source=store.source(ns,ref.id);
    if(source.sha256!==ref.sha256||source.snapshotArtifactId!==ref.snapshotArtifactId||source.providerId!==ref.providerId||source.providerVersion!=='observed-listing'||store.artifact(ns,source.snapshotArtifactId).sha256!==ref.sha256)throw new SourceContractFailure('source_scope_denied','The granted listing reference changed; inspect current scoped discovery.');
    const listing=JSON.parse(store.read(ns,source.snapshotArtifactId,1048576).toString('utf8'));
    validate(listingShape,listing);remember(found,listing);admitted.add(ref.id);
   }
   return found;
  };
  const remember=(found:Inventory,listing:any)=>{for(const file of listing.files){if(found.files.size>=4096&&!found.files.has(file.id))continue;found.files.set(file.id,file.mimeType);if(file.mimeType==='application/vnd.google-apps.folder')found.folders.add(file.id);}};
  const selectedFolder=(args:any,ctx:ToolContext)=>{
   const found=inventory(ctx);let id=args.folderId;
   if(id===undefined||id==='root'){if(selectedRoots.size!==1)throw new SourceContractFailure('needs_selected_root','Choose one host-selected root explicitly; no global Drive root is assumed.');id=[...selectedRoots][0];}
   if(!found.folders.has(id))throw new SourceContractFailure('needs_discovery','Use drive.list {} for the host-bound folder; explicit subfolder IDs must come from its observed listing.');
   return {...args,folderId:id};
  };
  const selectedFile=(args:any,ctx:ToolContext)=>{
   const found=inventory(ctx),ns={workspaceId:ctx.workspaceId,accountId:ctx.accountId};let id=args.fileId;
   const refs=ctx.scope.sources.filter(s=>s.provider==='drive'&&s.providerVersion!=='observed-listing'&&(s.id===id||s.snapshotArtifactId===id||s.providerId===id));
   if(refs.length){const versions=new Set(refs.map(s=>s.providerVersion+':'+s.sha256));if(versions.size!==1)throw new SourceContractFailure('needs_discovery','This provider reference is ambiguous; select an exact current source/artifact reference.');const source=store.source(ns,refs[0].id);if(source.sha256!==refs[0].sha256||source.providerId!==refs[0].providerId||source.snapshotArtifactId!==refs[0].snapshotArtifactId)throw new SourceContractFailure('source_scope_denied','Granted source reference changed.');id=source.providerId;}
   if(!refs.length&&!found.files.has(id)||found.folders.has(id)||found.files.get(id)==='application/vnd.google-apps.shortcut')throw new SourceContractFailure('needs_discovery','Use drive.list {} first, then drive.read with a returned files[].id. The user request artifact/source UUID is not a Google file ID; document/image tools use the downloaded artifact.id.');
   return {...args,fileId:id};
  };
  tools.push(tool('drive.list',['folderId','pageToken'],async(a,c)=>{const token=await drive.token({signal:c.signal});active(c);const listing=await new DriveReader(token,drive.accountId,selectedRoots,http).list(a.folderId,a.pageToken,c.signal);return {bytes:Buffer.from(JSON.stringify(listing)),mimeType:'application/json',providerId:a.folderId,providerVersion:'observed-listing',listing};},drive,{optional:['folderId','pageToken'],prepare:selectedFolder,committed:(r,c)=>remember(inventory(c),r.listing)}));
  tools.push(tool('drive.read',['fileId'],async(a,c)=>{const token=await drive.token({signal:c.signal});active(c);return new DriveReader(token,drive.accountId,selectedRoots,http).read(a.fileId,c.signal);},drive,{prepare:selectedFile}));
 }
 return tools;
}
