import type { ToolDefinition, ToolContext, ToolResult, Schema } from '../../agent/contracts.js';
import { EvidenceStore, type Namespace } from '../../evidence/store.js';
import { EmailDrafts, MailFailure, mailLimits, parseDraftContent, parseDraftRef, sendOutgoingMail, type MailSendHost, type DraftSnapshot } from './outgoing.js';

const text=(maxLength:number,minLength=0)=>({type:'string',minLength,maxLength});
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const array=(items:unknown,maxItems:number)=>({type:'array',items,maxItems});
const ref=object({artifactId:text(256,1),sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},draftId:text(256,1),revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}});
const mailbox=object({address:text(1024,1),name:text(512)},['address']);
const attachment=object({artifactId:text(256,1),sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},name:text(255,1)});
const reply=object({threadId:text(256,1),inReplyTo:text(254,5),references:array(text(254,5),20)});
const content=object({to:array(mailbox,mailLimits.recipients),cc:array(mailbox,mailLimits.recipients),bcc:array(mailbox,mailLimits.recipients),subject:text(8192),text:text(mailLimits.body),html:text(mailLimits.body),attachments:array(attachment,mailLimits.attachments),reply},['to','subject']);
const mime=object({artifactId:text(256,1),sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},bytes:{type:'integer',minimum:1,maximum:mailLimits.mime},messageId:text(254,5)});
const record=object({kind:{const:'spindle.mail-draft.v1'},workspaceId:text(8192,1),accountId:text(1024,1),sender:text(1024,1),draftId:text(256,1),revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},parent:ref,createdAt:text(64,1),content,provenanceIds:array(text(256,1),mailLimits.provenance),attachments:array(object({...attachment.properties,mimeType:text(256,1),bytes:{type:'integer',minimum:0,maximum:mailLimits.mime}}),mailLimits.attachments),mime},['kind','workspaceId','accountId','draftId','revision','createdAt','content','provenanceIds','attachments','mime']);
const local=object({state:{const:'local_draft'},draft:ref,record});
const denial=object({state:{enum:['denied','no_send']},code:text(128,1),intentId:text(256,1)},['state','code']);
const uncertain=object({state:{const:'uncertain'},code:text(128,1),intentId:text(256,1),mimeSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},messageIdHeader:text(254,5),observedMessageId:text(256,1),observedThreadId:text(256,1)},['state','code','intentId','mimeSha256','messageIdHeader']);
const sent=object({state:{const:'sent'},intentId:text(256,1),messageId:text(256,1),threadId:text(256,1),mimeSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},mimeBytes:{type:'integer',minimum:1,maximum:mailLimits.mime},verification:{const:'provider_acknowledged'}});
function validate(shape:any,v:any):void {
 if(shape.oneOf){let matches=0;for(const s of shape.oneOf)try{validate(s,v);matches++;}catch{}if(matches!==1)throw Error('MAIL_INVALID_SCHEMA');return;}
 if(shape.const!==undefined){if(v!==shape.const)throw Error('MAIL_INVALID_SCHEMA');return;}
 if(shape.enum){if(!shape.enum.includes(v))throw Error('MAIL_INVALID_SCHEMA');return;}
 if(shape.type==='object'){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!Object.hasOwn(shape.properties,k))||shape.required.some((k:string)=>!Object.hasOwn(v,k)))throw Error('MAIL_INVALID_SCHEMA');
  for(const k of Object.keys(v))validate(shape.properties[k],v[k]);
 }else if(shape.type==='array'){if(!Array.isArray(v)||v.length>shape.maxItems)throw Error('MAIL_INVALID_SCHEMA');for(const item of v)validate(shape.items,item);}
 else if(shape.type==='string'){if(typeof v!=='string'||v.length<shape.minLength||v.length>shape.maxLength||(shape.pattern&&!new RegExp(shape.pattern).test(v)))throw Error('MAIL_INVALID_SCHEMA');}
 else if(shape.type==='integer'){if(!Number.isSafeInteger(v)||v<shape.minimum||v>shape.maximum)throw Error('MAIL_INVALID_SCHEMA');}
 else throw Error('MAIL_INVALID_SCHEMA');
}
function schema(shape:Record<string,unknown>,parse?:(v:any)=>unknown):Schema {return {jsonSchema:shape,parse(v){validate(shape,v);return parse?parse(v):structuredClone(v);}};}
const draftArgs=(edit=false)=>schema(object({...edit?{draft:ref}:{},content,provenanceIds:array(text(256,1),mailLimits.provenance)}),v=>({...edit?{draft:parseDraftRef(v.draft)}:{},content:parseDraftContent(v.content),provenanceIds:[...v.provenanceIds]}));
const refArgs=schema(object({draft:ref}),v=>({draft:parseDraftRef(v.draft)}));
export interface OutgoingMailToolsOptions {
 store:EvidenceStore;namespace:Namespace;
 /** Host-selected Google identity; never a model-issued From address. Defaults only for legacy email namespaces. */
 sender?:string;
 /** Host-only generated-artifact admission. Default: exact scoped source snapshots.
  * Called again at send; arbitrary same-account evidence is not automatic authority. */
 allowAttachment?:(context:ToolContext,artifactId:string)=>boolean;
 send?:MailSendHost;
}
/** Reusable registry tools. Local drafting needs no Google scope. The runtime must
 * preserve its external_write gate until trusted durable host admission is wired. */
export function createOutgoingMailTools(options:OutgoingMailToolsOptions):ToolDefinition[] {
 const drafts=new EmailDrafts(options.store,options.namespace,options.sender);
 const allowed=(ctx:ToolContext,id:string)=>ctx.scope.sources.some(s=>s.accountId===ctx.accountId&&s.snapshotArtifactId===id)||(options.allowAttachment?.(ctx,id)??false);
 const active=(ctx:ToolContext)=>{if(ctx.signal.aborted)throw new MailFailure('MAIL_CANCELLED');if(!ctx.isCurrent())throw new MailFailure('MAIL_STALE');if(ctx.accountId!==drafts.namespace.accountId||ctx.workspaceId!==drafts.namespace.workspaceId)throw new MailFailure('MAIL_NAMESPACE_DENIED');};
 const localResult=(ctx:ToolContext,s:DraftSnapshot):ToolResult=>({callId:ctx.callId,status:'ok',data:{state:'local_draft',draft:s.draft,record:s.record},artifacts:[s.artifact,options.store.artifact(drafts.namespace,s.record.mime.artifactId)],evidence:[],observations:['Immutable local draft and MIME snapshot retained. No Gmail draft was created; no email was sent.']});
 const tool=(name:string,inputSchema:Schema,effect:ToolDefinition['effect'],execute:(v:any,ctx:ToolContext)=>Promise<ToolResult>):ToolDefinition=>({name,version:'1',capabilities:[name],effect,inputSchema,outputSchema:schema({oneOf:effect==='external_write'?[sent,denial,uncertain]:[local,denial]}),async invoke(v,ctx){
  try{active(ctx);const args=inputSchema.parse(v);return await execute(args,ctx);}
  catch(error){
   // Local durable commits must propagate, so runtime keeps pending/recovery.
   // Validation/namespace failures are fixed categories, never raw input/errors.
   if(!(error instanceof MailFailure)&&!(error instanceof Error&&error.message==='MAIL_INVALID_SCHEMA'))throw Error('MAIL_LOCAL_RECONCILIATION_REQUIRED');
   return {callId:ctx.callId,status:'needs_input',data:{state:'denied',code:error instanceof MailFailure?error.code:'MAIL_INVALID_ARGUMENTS'},artifacts:[],evidence:[],observations:[]};
  }
 }});
 return [
  tool('mail.draft.create',draftArgs(),'write_local',async(v,ctx)=>localResult(ctx,drafts.create(v.content,v.provenanceIds,id=>allowed(ctx,id)))),
  tool('mail.draft.read',refArgs,'read',async(v,ctx)=>localResult(ctx,drafts.read(v.draft))),
  tool('mail.draft.edit',draftArgs(true),'write_local',async(v,ctx)=>localResult(ctx,drafts.edit(v.draft,v.content,v.provenanceIds,id=>allowed(ctx,id)))),
  tool('mail.send',refArgs,'external_write',async(v,ctx)=>{
   const outcome=await sendOutgoingMail(drafts,v.draft,ctx,options.send,id=>allowed(ctx,id));
   return {callId:ctx.callId,status:outcome.state==='sent'?'ok':'needs_input',data:outcome,artifacts:[],evidence:[],observations:[outcome.state==='sent'?'Gmail acknowledged the exact MIME submission. This is not a recipient delivery receipt.':outcome.state==='uncertain'?'Preserve durable intent and reconcile before any further send; no automatic retry.':'No Gmail send was dispatched or the provider explicitly rejected it.']};
  })
 ];
}
