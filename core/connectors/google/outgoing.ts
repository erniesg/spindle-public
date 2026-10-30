import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { EvidenceStore, digest, type Namespace } from '../../evidence/store.js';
import type { ArtifactRef } from '../../evidence/types.js';
import type { ToolContext } from '../../agent/contracts.js';
import type { GoogleOAuth } from './oauth.js';
import { scopes } from './oauth.js';
import { abortRace } from './abort.js';
import { boundedJson } from './bounded.js';

export interface Mailbox {address:string;name?:string}
export interface DraftRef {artifactId:string;sha256:string;draftId:string;revision:number}
export interface MailAttachment {artifactId:string;sha256:string;name:string}
export interface DraftContent {
 to:Mailbox[];cc?:Mailbox[];bcc?:Mailbox[];subject:string;text?:string;html?:string;
 attachments?:MailAttachment[];
 reply?:{threadId:string;inReplyTo:string;references:string[]};
}
export interface LocalMailDraft {
 kind:'spindle.mail-draft.v1';workspaceId:string;accountId:string;draftId:string;revision:number;
 /** Trusted selected Google identity, distinct from the Spindle tenant namespace. Absent only in legacy email-namespaced drafts. */
 sender?:string;
 parent?:DraftRef;createdAt:string;content:DraftContent;provenanceIds:string[];
 attachments:(MailAttachment & {mimeType:string;bytes:number})[];
 mime:{artifactId:string;sha256:string;bytes:number;messageId:string};
}
export interface DraftSnapshot {draft:DraftRef;record:LocalMailDraft;artifact:ArtifactRef}
export class MailFailure extends Error {constructor(readonly code:string){super(code);}}
function fail(code:string):never {throw new MailFailure(code);}
export const draftMime='application/vnd.spindle.mail-draft+json';
export const mailLimits={body:1024*1024,mime:24*1024*1024,attachments:50,recipients:500,provenance:40} as const;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v);
const string=(v:unknown,max:number,min=0):v is string=>typeof v==='string'&&v.length>=min&&Buffer.byteLength(v)<=max&&Buffer.from(v).toString('utf8')===v;
function object(v:unknown,keys:string[],required=keys):asserts v is Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail('MAIL_INVALID_ARGUMENTS');}
const noControls=(v:string)=>!/[\x00-\x1f\x7f]/.test(v);
/** RFC 5322 ASCII addr-spec (including quoted local parts); IDNA domains are normalized.
 * SMTPUTF8 local parts are not encoded as misleading RFC 2047 words. */
export function mailAddress(v:unknown):string {
 if(!string(v,1024,1)||!noControls(v))return fail('MAIL_INVALID_ADDRESS');
 const at=v.lastIndexOf('@');if(at<1)return fail('MAIL_INVALID_ADDRESS');
 const local=v.slice(0,at),rawDomain=v.slice(at+1);
 if(Buffer.byteLength(local)>64||!(/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)||/^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/.test(local)))return fail('MAIL_INVALID_ADDRESS');
 const domain=rawDomain.startsWith('[')?rawDomain:domainToASCII(rawDomain).toLowerCase();
 if(domain.startsWith('[')?!(domain.endsWith(']')&&isIP(domain.slice(1,-1).replace(/^IPv6:/,''))):!domain||domain.length>253||domain.split('.').some(s=>!(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s))))return fail('MAIL_INVALID_ADDRESS');
 const result=`${local}@${domain}`;if(Buffer.byteLength(result)>254)return fail('MAIL_INVALID_ADDRESS');return result;
}
export function parseDraftRef(v:unknown):DraftRef {
 object(v,['artifactId','sha256','draftId','revision']);
 if(!opaque(v.artifactId)||!hash(v.sha256)||!opaque(v.draftId)||!Number.isSafeInteger(v.revision)||v.revision<1)return fail('MAIL_INVALID_DRAFT');
 return {artifactId:v.artifactId,sha256:v.sha256,draftId:v.draftId,revision:v.revision};
}
function messageId(v:unknown):v is string {
 if(!string(v,254,5)||!v.startsWith('<')||!v.endsWith('>')||v.includes('"'))return false;
 try{mailAddress(v.slice(1,-1));return true;}catch{return false;}
}
export function parseDraftContent(v:unknown):DraftContent {
 object(v,['to','cc','bcc','subject','text','html','attachments','reply'],['to','subject']);
 let count=0;
 const recipients=(a:unknown):Mailbox[]=>{
  if(!Array.isArray(a)||a.length>mailLimits.recipients)return fail('MAIL_INVALID_RECIPIENTS');count+=a.length;
  return a.map(m=>{object(m,['address','name'],['address']);if(m.name!==undefined&&(!string(m.name,512)||!noControls(m.name)))fail('MAIL_INVALID_ADDRESS');return {address:mailAddress(m.address),...(m.name===undefined?{}:{name:m.name})};});
 };
 const to=recipients(v.to),cc=v.cc===undefined?undefined:recipients(v.cc),bcc=v.bcc===undefined?undefined:recipients(v.bcc);
 if(count<1||count>mailLimits.recipients)return fail('MAIL_INVALID_RECIPIENTS');
 if(!string(v.subject,8192)||!noControls(v.subject))return fail('MAIL_INVALID_SUBJECT');
 if(v.text===undefined&&v.html===undefined)return fail('MAIL_BODY_REQUIRED');
 for(const body of [v.text,v.html])if(body!==undefined&&(!string(body,mailLimits.body)||body.includes('\0')))fail('MAIL_INVALID_BODY');
 if(v.attachments!==undefined&&(!Array.isArray(v.attachments)||v.attachments.length>mailLimits.attachments))return fail('MAIL_INVALID_ATTACHMENTS');
 const attachments=v.attachments?.map((a:unknown)=>{object(a,['artifactId','sha256','name']);if(!opaque(a.artifactId)||!hash(a.sha256)||!string(a.name,255,1)||!noControls(a.name)||/[\\/]/.test(a.name)||a.name==='.'||a.name==='..')fail('MAIL_INVALID_ATTACHMENT');return {artifactId:a.artifactId,sha256:a.sha256,name:a.name};});
 if(v.reply!==undefined){object(v.reply,['threadId','inReplyTo','references']);if(!opaque(v.reply.threadId)||!messageId(v.reply.inReplyTo)||!Array.isArray(v.reply.references)||v.reply.references.length<1||v.reply.references.length>20||v.reply.references.some((r:unknown)=>!messageId(r)))fail('MAIL_INVALID_REPLY');}
 return {to,...(cc===undefined?{}:{cc}),...(bcc===undefined?{}:{bcc}),subject:v.subject,...(v.text===undefined?{}:{text:v.text}),...(v.html===undefined?{}:{html:v.html}),...(attachments===undefined?{}:{attachments}),...(v.reply===undefined?{}:{reply:structuredClone(v.reply)})};
}
/** Actual signature/text verification for common formats, otherwise truthful generic
 * binary transport, not an arbitrary model MIME assertion or a file-type allowlist. */
function attachmentMime(declared:string,bytes:Buffer):string {
 if(!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(declared)||/[\r\n]/.test(declared))return fail('MAIL_INVALID_ATTACHMENT_MIME');
 const type=declared.split(';')[0].toLowerCase();
 const signatures:Record<string,boolean>={
  'application/pdf':bytes.subarray(0,5).equals(Buffer.from('%PDF-')),
  'image/png':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  'image/jpeg':bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
  'image/gif':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')),
  'image/webp':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP',
  'application/zip':bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&[[3,4],[5,6],[7,8]].some(([a,b])=>bytes[2]===a&&bytes[3]===b)
 };
 if(Object.hasOwn(signatures,type)){if(!signatures[type])return fail('MAIL_ATTACHMENT_MIME_MISMATCH');return type;}
 if(type.startsWith('text/')||type==='application/json'){
  if(bytes.toString('utf8').includes('\0')||!Buffer.from(bytes.toString('utf8')).equals(bytes))return fail('MAIL_ATTACHMENT_MIME_MISMATCH');
  if(type==='application/json'){try{JSON.parse(bytes.toString('utf8'));}catch{return fail('MAIL_ATTACHMENT_MIME_MISMATCH');}}
  return `${type}; charset=UTF-8`;
 }
 return 'application/octet-stream';
}
const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
function words(value:string):string {
 const chunks:string[]=[];let chunk='';
 for(const char of value){if(Buffer.byteLength(chunk+char)>42){chunks.push(chunk);chunk='';}chunk+=char;}if(chunk)chunks.push(chunk);
 return chunks.map(s=>`=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
}
function filename(value:string):string {
 // RFC 2231 parameter continuations; split bytes, never a %-escape triplet.
 const bytes=Buffer.from(value),params:string[]=[];
 for(let i=0;i<bytes.length;i+=15)params.push(`filename*${params.length}*=${i===0?"UTF-8''":''}${[...bytes.subarray(i,i+15)].map(b=>'%'+b.toString(16).toUpperCase().padStart(2,'0')).join('')}`);
 return `Content-Disposition: attachment;\r\n ${params.join(';\r\n ')}`;
}
function encodeMime(content:DraftContent,from:string,date:string,id:string,attachments:{bytes:Buffer;mimeType:string;name:string}[]):Buffer {
 const header=[`From: ${from}`,`Date: ${new Date(date).toUTCString()}`,`Message-ID: ${id}`,'MIME-Version: 1.0'];
 for(const [name,boxes] of [['To',content.to],['Cc',content.cc],['Bcc',content.bcc]] as const)if(boxes?.length)header.push(`${name}: ${boxes.map(m=>m.name?`${words(m.name)} <${m.address}>`:m.address).join(',\r\n ')}`);
 header.push(`Subject: ${words(content.subject)}`);
 if(content.reply)header.push(`In-Reply-To: ${content.reply.inReplyTo}`,`References: ${content.reply.references.join('\r\n ')}`);
 const leaf=(mime:string,text:string)=>`Content-Type: ${mime}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.from(text.replace(/\r\n|\r|\n/g,'\r\n')))}`;
 const boundary=(name:string)=>`spindle_${name}_${digest(Buffer.from(id)).slice(0,32)}`;
 const multipart=(type:string,b:string,parts:string[])=>`Content-Type: multipart/${type}; boundary="${b}"\r\n\r\n${parts.map(p=>`--${b}\r\n${p}\r\n`).join('')}--${b}--`;
 const bodies=[...(content.text===undefined?[]:[leaf('text/plain',content.text)]),...(content.html===undefined?[]:[leaf('text/html',content.html)])];
 let body=bodies.length===1?bodies[0]:multipart('alternative',boundary('alt'),bodies);
 if(attachments.length)body=multipart('mixed',boundary('mixed'),[body,...attachments.map(a=>`Content-Type: ${a.mimeType}\r\nContent-Transfer-Encoding: base64\r\n${filename(a.name)}\r\n\r\n${base64(a.bytes)}`)]);
 const bytes=Buffer.from(header.join('\r\n')+'\r\n'+body+'\r\n');
 if(bytes.length>mailLimits.mime||bytes.toString().split('\r\n').some(line=>Buffer.byteLength(line)>998))return fail('MAIL_PAYLOAD_TOO_LARGE');return bytes;
}
export class EmailDrafts {
 readonly namespace:Namespace;readonly sender:string;
 constructor(readonly store:EvidenceStore,namespace:Namespace,sender=namespace.accountId){this.namespace=Object.freeze({...namespace});this.sender=mailAddress(sender);}
 private attachments(content:DraftContent,allowed:(id:string)=>boolean){
  let total=0;
  return (content.attachments??[]).map(a=>{
   if(!allowed(a.artifactId))return fail('MAIL_ATTACHMENT_NOT_ADMITTED');
   let meta:ArtifactRef;try{meta=this.store.artifact(this.namespace,a.artifactId);}catch{return fail('MAIL_ATTACHMENT_UNAVAILABLE');}
   if(meta.sha256!==a.sha256)return fail('MAIL_ATTACHMENT_CHANGED');
   total+=meta.bytes;if(total>mailLimits.mime)return fail('MAIL_PAYLOAD_TOO_LARGE');
   let bytes:Buffer;try{bytes=this.store.read(this.namespace,a.artifactId,mailLimits.mime);}catch{return fail('MAIL_ATTACHMENT_INTEGRITY_FAILURE');}
   return {...a,bytes,mimeType:attachmentMime(meta.mimeType,bytes)};
  });
 }
 create(value:unknown,provenanceIds:string[],allowed:(id:string)=>boolean,parent?:DraftRef):DraftSnapshot {
  const content=parseDraftContent(value);
  if(!Array.isArray(provenanceIds)||provenanceIds.length>mailLimits.provenance||provenanceIds.some(id=>!opaque(id)))return fail('MAIL_INVALID_PROVENANCE');
  for(const id of provenanceIds){try{this.store.artifact(this.namespace,id);}catch{try{this.store.source(this.namespace,id);}catch{return fail('MAIL_PROVENANCE_UNAVAILABLE');}}}
  const previous=parent?this.read(parent):undefined;
  const attachments=this.attachments(content,allowed),draftId=previous?.draft.draftId??randomUUID(),revision=(previous?.draft.revision??0)+1;
  const createdAt=new Date().toISOString(),id=`<${randomUUID()}@spindle.invalid>`;
  const lineage=[...new Set([...provenanceIds,...attachments.map(a=>a.artifactId),...(parent?[parent.artifactId]:[])])];
  const mime=this.store.put(this.namespace,encodeMime(content,this.sender,createdAt,id,attachments),'message/rfc822',lineage).artifact;
  const record:LocalMailDraft={kind:'spindle.mail-draft.v1',...this.namespace,sender:this.sender,draftId,revision,...(parent?{parent:parseDraftRef(parent)}:{}),createdAt,content,provenanceIds:[...provenanceIds],attachments:attachments.map(({bytes,...a})=>({...a,bytes:bytes.length})),mime:{artifactId:mime.id,sha256:mime.sha256,bytes:mime.bytes,messageId:id}};
  const artifact=this.store.put(this.namespace,Buffer.from(JSON.stringify(record)),draftMime,[mime.id,...lineage]).artifact;
  return {draft:{artifactId:artifact.id,sha256:artifact.sha256,draftId,revision},record,artifact};
 }
 edit(ref:DraftRef,content:unknown,provenanceIds:string[],allowed:(id:string)=>boolean){return this.create(content,provenanceIds,allowed,ref);}
 read(value:unknown):DraftSnapshot {
  const ref=parseDraftRef(value);let artifact:ArtifactRef,record:LocalMailDraft;
  try{
   artifact=this.store.artifact(this.namespace,ref.artifactId);
   if(artifact.mimeType!==draftMime||artifact.sha256!==ref.sha256)return fail('MAIL_DRAFT_CHANGED');
   record=JSON.parse(this.store.read(this.namespace,ref.artifactId,16*1024*1024).toString('utf8')) as LocalMailDraft;
  }catch(error){if(error instanceof MailFailure)throw error;return fail('MAIL_DRAFT_UNAVAILABLE');}
  if(!record||record.kind!=='spindle.mail-draft.v1'||record.workspaceId!==this.namespace.workspaceId||record.accountId!==this.namespace.accountId||record.draftId!==ref.draftId||record.revision!==ref.revision||!messageId(record.mime?.messageId)||!opaque(record.mime.artifactId)||!hash(record.mime.sha256)||!Number.isSafeInteger(record.mime.bytes)||record.mime.bytes<1||record.mime.bytes>mailLimits.mime)return fail('MAIL_INVALID_DRAFT');
  object(record,['kind','workspaceId','accountId','sender','draftId','revision','parent','createdAt','content','provenanceIds','attachments','mime'],['kind','workspaceId','accountId','draftId','revision','createdAt','content','provenanceIds','attachments','mime']);
  object(record.mime,['artifactId','sha256','bytes','messageId']);
  if(!string(record.createdAt,64,1)||!Number.isFinite(Date.parse(record.createdAt))||!Array.isArray(record.provenanceIds)||record.provenanceIds.length>mailLimits.provenance||record.provenanceIds.some(id=>!opaque(id))||!isDeepStrictEqual(parseDraftContent(record.content),record.content))return fail('MAIL_INVALID_DRAFT');
  if(record.parent){parseDraftRef(record.parent);if(record.parent.draftId!==ref.draftId||record.parent.revision!==ref.revision-1||!artifact.derivedFrom.includes(record.parent.artifactId))return fail('MAIL_INVALID_DRAFT');}
  if(!artifact.derivedFrom.includes(record.mime.artifactId)||record.provenanceIds.some(id=>!artifact.derivedFrom.includes(id)))return fail('MAIL_INVALID_DRAFT');
  const snapshot={draft:ref,record,artifact};
  // A files.write lookalike is not trusted merely because its JSON has our MIME.
  // Review metadata and content must describe the exact immutable outgoing bytes.
  try{this.mime(snapshot,()=>true);}catch(error){if(error instanceof MailFailure)throw error;return fail('MAIL_DRAFT_UNAVAILABLE');}
  return snapshot;
 }
 /** Verify immutable bytes AND all attachment snapshots against their recorded MIME/hash. */
 mime(snapshot:DraftSnapshot,allowed:(id:string)=>boolean):Buffer {
  const {record}=snapshot,meta=this.store.artifact(this.namespace,record.mime.artifactId);
  if((record.sender??record.accountId)!==this.sender)return fail('MAIL_DRAFT_CHANGED');
  if(meta.mimeType!=='message/rfc822'||meta.sha256!==record.mime.sha256||meta.bytes!==record.mime.bytes)return fail('MAIL_DRAFT_CHANGED');
  const bytes=this.store.read(this.namespace,meta.id,mailLimits.mime);
  const attachments=this.attachments(record.content,allowed);
  const metadata=attachments.map(({bytes,...a})=>({...a,bytes:bytes.length}));
  if(!isDeepStrictEqual(metadata,record.attachments))return fail('MAIL_DRAFT_CHANGED');
  if(!bytes.equals(encodeMime(record.content,this.sender,record.createdAt,record.mime.messageId,attachments)))return fail('MAIL_DRAFT_CHANGED');
  return bytes;
 }
}

export const mailSendGrants={send:'https://www.googleapis.com/auth/gmail.send',compose:'https://www.googleapis.com/auth/gmail.compose',modify:'https://www.googleapis.com/auth/gmail.modify',full:'https://mail.google.com/'} as const;
export type MailSendGrant=typeof mailSendGrants[keyof typeof mailSendGrants];
export interface MailSendBinding extends Namespace {connectionEpoch:string;draft:DraftRef;mime:LocalMailDraft['mime']}
export interface MailSendApproval {id:string;binding:MailSendBinding}
export interface MailSendIntent {version:1;id:string;taskId:string;approvalId:string;binding:MailSendBinding}
export type SendOutcome=
 | {state:'sent';intentId:string;messageId:string;threadId:string;mimeSha256:string;mimeBytes:number;verification:'provider_acknowledged'}
 | {state:'denied'|'no_send';code:string;intentId?:string}
 | {state:'uncertain';code:string;intentId:string;mimeSha256:string;messageIdHeader:string;observedMessageId?:string;observedThreadId?:string};
/** Trusted durable adapter, NOT model callbacks. reserve atomically commits the exact
 * intent and serializes the approval across processes/restarts. existing never POSTs.
 * The serialization must remain held through settlement, without timed takeover;
 * assertReserved fences ownership. settle must preserve prior observed facts when
 * appending uncertainty/cancellation; it cannot erase intents or acknowledgements. */
export interface MailSendJournal {
 reserve(intent:Readonly<MailSendIntent>,context:ToolContext):Promise<'new'|'existing'>;
 assertReserved(intent:Readonly<MailSendIntent>,context:ToolContext):Promise<void>;
 settle(intent:Readonly<MailSendIntent>,outcome:Readonly<SendOutcome>):Promise<void>;
}
export interface MailSendHost {
 oauth:Pick<GoogleOAuth,'connectorAccess'>;connectionId:string;connectionEpoch:string;grant:MailSendGrant;
 approval(context:ToolContext,binding:Readonly<MailSendBinding>):Promise<MailSendApproval|undefined>;
 /** Must fence authenticated owner/session, approval revocation and selected draft revision. */
 assertCurrent(context:ToolContext,approval:Readonly<MailSendApproval>):Promise<void>;
 /** The invocation context reaches backend transports that guard their last async auth wait. */
 journal:MailSendJournal;http?:(input:RequestInfo|URL,init:RequestInit|undefined,context:ToolContext)=>Promise<Response>;
 /** Trusted host verifies a retained provider draft against the immutable MIME before send.
  * When present, drafts/send supplies both its ID and exact raw bytes; no stale remote edits are sent. */
 providerDraft?(context:ToolContext,binding:Readonly<MailSendBinding>):Promise<string|undefined>;
}
export function mailBinding(namespace:Namespace,epoch:string,snapshot:DraftSnapshot):MailSendBinding {return {...namespace,connectionEpoch:epoch,draft:{...snapshot.draft},mime:{...snapshot.record.mime}};}
const bindingEqual=(a:MailSendBinding,b:MailSendBinding)=>a.workspaceId===b.workspaceId&&a.accountId===b.accountId&&a.connectionEpoch===b.connectionEpoch&&a.draft?.artifactId===b.draft.artifactId&&a.draft.sha256===b.draft.sha256&&a.draft.draftId===b.draft.draftId&&a.draft.revision===b.draft.revision&&a.mime?.artifactId===b.mime.artifactId&&a.mime.sha256===b.mime.sha256&&a.mime.bytes===b.mime.bytes&&a.mime.messageId===b.mime.messageId;
const active=(ctx:ToolContext)=>{if(ctx.signal.aborted)fail('MAIL_CANCELLED');if(!ctx.isCurrent())fail('MAIL_STALE');};
const discard=(r:Response)=>{void r.body?.cancel().catch(()=>{});};
/** One POST maximum per durable reservation; no transport retry and no Gmail
 * idempotency claim. Local artifacts are not provider drafts. */
export async function sendOutgoingMail(drafts:EmailDrafts,value:unknown,context:ToolContext,host:MailSendHost|undefined,allowed:(id:string)=>boolean):Promise<SendOutcome> {
 let intent:MailSendIntent|undefined,reserved=false,dispatched=false;
 let observed:{observedMessageId:string;observedThreadId:string}|undefined;
 const ctx={...context,signal:AbortSignal.any([context.signal,AbortSignal.timeout(15000)])};
 const uncertain=(code:string):SendOutcome=>({state:'uncertain',code,intentId:intent!.id,mimeSha256:intent!.binding.mime.sha256,messageIdHeader:intent!.binding.mime.messageId,...observed});
 try{
  active(ctx);if(ctx.workspaceId!==drafts.namespace.workspaceId||ctx.accountId!==drafts.namespace.accountId)fail('MAIL_NAMESPACE_DENIED');
  if(!host)fail('MAIL_APPROVAL_REQUIRED');
  if(!host.journal?.reserve||!host.journal?.assertReserved||!host.journal?.settle)fail('MAIL_DURABLE_INTENT_REQUIRED');
  if(!Object.values(mailSendGrants).includes(host.grant))fail('MAIL_SEND_GRANT_REQUIRED');
  const snapshot=drafts.read(value),binding=mailBinding(drafts.namespace,host.connectionEpoch,snapshot);
  let approval=await abortRace(host.approval(ctx,structuredClone(binding)),ctx.signal);active(ctx);
  if(!approval||!opaque(approval.id)||!bindingEqual(approval.binding,binding))fail('MAIL_APPROVAL_REQUIRED');
  approval=structuredClone(approval);
  const fence=async()=>{active(ctx);await abortRace(host.assertCurrent(ctx,structuredClone(approval!)),ctx.signal);active(ctx);};
  await fence();
  const mime=drafts.mime(snapshot,allowed);active(ctx);
  // connectorAccess reads protected connection only; assertCurrent denies a missing
  // exact operation-specific grant before token refresh or Gmail network access.
  const access=await abortRace(host.oauth.connectorAccess(host.connectionId,host.grant,{signal:ctx.signal}),ctx.signal);await fence();
  if(access.accountId!==drafts.sender||access.connectionEpoch!==binding.connectionEpoch)fail('MAIL_CONNECTION_CHANGED');
  const connection=async()=>{await fence();try{await abortRace(access.assertCurrent({signal:ctx.signal}),ctx.signal);}catch(error){
   if(error instanceof Error&&error.message==='Required grant absent')fail('MAIL_SEND_GRANT_REQUIRED');
   if(error instanceof Error&&error.message==='Connection epoch changed')fail('MAIL_CONNECTION_CHANGED');
   fail('MAIL_CONNECTION_UNAVAILABLE');
  }await fence();};
  await connection();
  const token=await abortRace(access.token({signal:ctx.signal}),ctx.signal);await connection();
  const providerDraft=await abortRace(Promise.resolve(host.providerDraft?.(ctx,binding)),ctx.signal);await connection();
  if(providerDraft!==undefined&&!opaque(providerDraft))fail('MAIL_INVALID_PROVIDER_DRAFT');
  intent={version:1,id:approval.id,approvalId:approval.id,taskId:ctx.taskId,binding};
  const reservation=await abortRace(host.journal.reserve(structuredClone(intent),ctx),ctx.signal);
  // An interrupted reserve can have committed: its durable owner must reconcile.
  if(reservation==='existing')return uncertain('MAIL_EXISTING_INTENT_RECONCILIATION_REQUIRED');
  if(reservation!=='new')fail('MAIL_DURABLE_INTENT_REQUIRED');
  reserved=true;await connection();
  await abortRace(host.journal.assertReserved(structuredClone(intent),ctx),ctx.signal);await connection();active(ctx);
  const message={raw:mime.toString('base64url'),...(snapshot.record.content.reply?{threadId:snapshot.record.content.reply.threadId}:{})};
  const body=JSON.stringify(providerDraft?{id:providerDraft,message}:message);
  dispatched=true;
  const pending=(host.http??fetch)(`https://gmail.googleapis.com/gmail/v1/users/me/${providerDraft?'drafts/send':'messages/send'}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,redirect:'error',signal:ctx.signal},ctx);
  void pending.then(r=>{if(ctx.signal.aborted)discard(r);},()=>{});
  const response=await abortRace(pending,ctx.signal);
  let outcome:SendOutcome;
  try{
   await connection();
   if(!response.ok){discard(response);outcome=response.status>=400&&response.status<500?{state:'no_send',code:'MAIL_PROVIDER_REJECTED',intentId:intent.id}:uncertain('MAIL_PROVIDER_OUTCOME_UNKNOWN');}
   else{
    const result=await abortRace(boundedJson(response,65536,ctx.signal),ctx.signal);await connection();
    if(!opaque(result.id)||!opaque(result.threadId))fail('MAIL_INVALID_PROVIDER_RESULT');
    observed={observedMessageId:result.id,observedThreadId:result.threadId};
    outcome={state:'sent',intentId:intent.id,messageId:result.id,threadId:result.threadId,mimeSha256:binding.mime.sha256,mimeBytes:mime.length,verification:'provider_acknowledged'};
   }
  }catch(error){discard(response);throw error;}
  await abortRace(host.journal.settle(structuredClone(intent),outcome),ctx.signal);await connection();return outcome;
 }catch(error){
  const code=error instanceof MailFailure?error.code:ctx.signal.aborted?(context.signal.aborted?'MAIL_CANCELLED':'MAIL_DEADLINE'):'MAIL_UNAVAILABLE';
  const outcome:SendOutcome=dispatched?uncertain('MAIL_DISPATCH_UNCERTAIN'):{state:'denied',code,...(intent?{intentId:intent.id}:{})};
  // Retain external facts even when the runtime/session was cancelled. Do not let
  // a storage failure become an ordinary safe-to-retry denial after dispatch.
  if(reserved&&intent&&host){try{await abortRace(host.journal.settle(structuredClone(intent),outcome),AbortSignal.timeout(15000));}catch{return uncertain('MAIL_JOURNAL_RECONCILIATION_REQUIRED');}}
  return outcome;
 }
}

export interface MailReconciliation {state:'candidates'|'not_observed';intentId:string;draft:DraftRef;mimeSha256:string;messageIdHeader:string;candidates:{messageId:string;threadId:string}[];complete:boolean;automaticRetryAllowed:false}
/** Search is evidence, never proof of non-delivery or provider idempotency. Even an
 * exact Message-ID is not a cryptographic content attestation; caller reviews candidates. */
export async function reconcileOutgoingMail(drafts:EmailDrafts,intent:MailSendIntent,context:ToolContext,options:{oauth:Pick<GoogleOAuth,'connectorAccess'>;connectionId:string;assertCurrent(context:ToolContext):Promise<void>;http?:typeof fetch}):Promise<MailReconciliation> {
 const ctx={...context,signal:AbortSignal.any([context.signal,AbortSignal.timeout(15000)])};
 try{
  const snapshot=drafts.read(intent.binding.draft),expected=mailBinding(drafts.namespace,intent.binding.connectionEpoch,snapshot);
  if(intent.version!==1||!opaque(intent.id)||intent.id!==intent.approvalId||!bindingEqual(intent.binding,expected)||ctx.accountId!==expected.accountId||ctx.workspaceId!==expected.workspaceId||ctx.taskId!==intent.taskId)fail('MAIL_RECONCILIATION_BINDING_DENIED');
  const fence=async()=>{active(ctx);await abortRace(options.assertCurrent(ctx),ctx.signal);active(ctx);};await fence();
  const access=await abortRace(options.oauth.connectorAccess(options.connectionId,scopes.mail,{signal:ctx.signal}),ctx.signal);await fence();
  if(access.accountId!==drafts.sender||access.connectionEpoch!==expected.connectionEpoch)fail('MAIL_CONNECTION_CHANGED');
  const connection=async()=>{await fence();await abortRace(access.assertCurrent({signal:ctx.signal}),ctx.signal);await fence();};
  await connection();const token=await abortRace(access.token({signal:ctx.signal}),ctx.signal);await connection();
  const get=async(path:string)=>{await connection();const pending=(options.http??fetch)(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:ctx.signal});void pending.then(r=>{if(ctx.signal.aborted)discard(r);},()=>{});const r=await abortRace(pending,ctx.signal);try{await connection();if(!r.ok)fail('MAIL_RECONCILIATION_UNAVAILABLE');const data=await abortRace(boundedJson(r,65536,ctx.signal),ctx.signal);await connection();return data;}catch(error){discard(r);throw error;}};
  const q=new URLSearchParams({q:`in:sent rfc822msgid:${expected.mime.messageId.slice(1,-1)}`,maxResults:'10'});
  const page=await get(`messages?${q}`);
  if(page.messages!==undefined&&(!Array.isArray(page.messages)||page.messages.length>10||page.messages.some((m:any)=>!opaque(m?.id))))fail('MAIL_RECONCILIATION_UNAVAILABLE');
  if(page.nextPageToken!==undefined&&!string(page.nextPageToken,8192,1))fail('MAIL_RECONCILIATION_UNAVAILABLE');
  const candidates:MailReconciliation['candidates']=[];
  for(const m of page.messages??[]){
   const meta=await get(`messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Message-ID`);
   if(meta.id!==m.id||!opaque(meta.threadId)||!Array.isArray(meta.labelIds)||!meta.labelIds.includes('SENT')||!Array.isArray(meta.payload?.headers))fail('MAIL_RECONCILIATION_UNAVAILABLE');
   const ids=meta.payload.headers.filter((h:any)=>typeof h?.name==='string'&&h.name.toLowerCase()==='message-id');
   if(ids.length===1&&ids[0].value===expected.mime.messageId)candidates.push({messageId:meta.id,threadId:meta.threadId});
  }
  await connection();return {state:candidates.length?'candidates':'not_observed',intentId:intent.id,draft:{...expected.draft},mimeSha256:expected.mime.sha256,messageIdHeader:expected.mime.messageId,candidates,complete:page.nextPageToken===undefined,automaticRetryAllowed:false};
 }catch{throw new MailFailure('MAIL_RECONCILIATION_UNAVAILABLE');}
}
