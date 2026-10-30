import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {ToolContext,ToolDefinition} from '../agent/contracts.js';
import type {AgentStore} from '../storage/agent-store.js';
import {EmailDrafts,mailAddress,mailBinding,mailSendGrants,MailFailure,type DraftRef,type MailSendBinding} from '../connectors/google/outgoing.js';
import {boundedJson} from '../connectors/google/bounded.js';
import {abortRace} from '../connectors/google/abort.js';
import {scopes} from '../connectors/google/oauth.js';
import type {MailConnectionBinding} from './service.js';
import type {GmailDraftPublication} from './types.js';
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(v);
const fail=(code:string):never=>{throw new MailFailure(code);};
const unknown=(p:GmailDraftPublication)=>p.state==='intent'||p.state==='uncertain';
/**
 * Gmail may add Received and replace Date/Message-ID during draft ingestion.
 * Only these transport headers may differ. All other headers and the complete
 * MIME body (including encoded attachment bytes and structure) remain exact.
 */
export function gmailDraftMimeMatches(local:Buffer,remote:Buffer):boolean {
 if(remote.equals(local))return true;
 const parse=(bytes:Buffer)=>{
  const end=bytes.indexOf('\r\n\r\n');if(end<0||end>65536||bytes.length>24*1024*1024+65536)throw Error('MIME_BOUND');
  const text=bytes.subarray(0,end).toString('latin1');if(/[^\x09\x20-\x7e\r\n]/.test(text)||text.replace(/\r\n/g,'').match(/[\r\n]/))throw Error('MIME_HEADERS');
  const rows:{name:string;value:string;raw:string}[]=[];
  for(const line of text.split('\r\n')){
   if(/^[ \t]/.test(line)){if(!rows.length)throw Error('MIME_FOLD');rows.at(-1)!.value+=' '+line.trim();rows.at(-1)!.raw+='\r\n'+line;continue;}
   const at=line.indexOf(':');if(at<1||!/^[A-Za-z0-9-]+$/.test(line.slice(0,at)))throw Error('MIME_HEADER');
   rows.push({name:line.slice(0,at).toLowerCase(),value:line.slice(at+1).trim(),raw:line});if(rows.length>1000)throw Error('MIME_HEADER_BOUND');
  }
  const headers=new Map<string,string>(),received:string[]=[];
  for(const row of rows){if(row.name==='received'){received.push(row.value);if(received.length>20)throw Error('MIME_RECEIVED_BOUND');continue;}if(headers.has(row.name))throw Error('MIME_DUPLICATE');headers.set(row.name,row.value);}
  const date=headers.get('date'),messageId=headers.get('message-id');
  if(!date||!Number.isFinite(Date.parse(date))||!messageId||messageId.length>254||!/^<[^<>"\s]+>$/.test(messageId))throw Error('MIME_TRANSPORT');
  mailAddress(messageId.slice(1,-1));headers.delete('date');headers.delete('message-id');
  return {headers:rows.filter(row=>!['received','date','message-id'].includes(row.name)).map(row=>row.raw),body:bytes.subarray(end+4)};
 };
 try{const expected=parse(local),actual=parse(remote);return expected.body.equals(actual.body)&&expected.headers.length===actual.headers.length&&expected.headers.every((value,index)=>actual.headers[index]===value);}catch{return false;}
}
export function gmailDraftTools(options:{tasks:AgentStore;drafts:EmailDrafts;binding:MailConnectionBinding;http(input:RequestInfo|URL,init:RequestInit|undefined,context:ToolContext):Promise<Response>;assertCurrent(ctx:ToolContext):Promise<void>;allowAttachment(ctx:ToolContext,id:string):boolean;allowCancelledRead?:boolean;arguments:ToolDefinition['inputSchema']}){
 const {tasks,drafts,binding:b}=options;
 const task=(id:string)=>tasks.taskInNamespace(drafts.namespace,id)??fail('MAIL_TASK_NOT_FOUND');
 const sameRevision=(a:MailSendBinding,b:MailSendBinding)=>a.accountId===b.accountId&&a.workspaceId===b.workspaceId&&same(a.draft,b.draft)&&same(a.mime,b.mime);
 const record=(id:string,binding:MailSendBinding)=>Object.values(task(id).mail?.publishes??{}).find(p=>same(p.binding,binding)&&p.state!=='denied');
 const current=(taskId:string,ref:DraftRef)=>{const t=task(taskId);if(t.status==='cancelled'&&!options.allowCancelledRead||!same(t.mail?.drafts[ref.draftId],ref))fail('MAIL_DRAFT_NOT_CURRENT');};
 const transport=async(ctx:ToolContext,ref:DraftRef,readOnly=false)=>{
  const check=async()=>{ctx.signal.throwIfAborted();if(!ctx.isCurrent())fail('MAIL_CONTEXT_CHANGED');current(ctx.taskId,ref);await options.assertCurrent(ctx);ctx.signal.throwIfAborted();if(!ctx.isCurrent())fail('MAIL_CONTEXT_CHANGED');current(ctx.taskId,ref);};
  await check();const protectedState=await abortRace(b.oauth.connectionState(b.connectionId,{signal:ctx.signal}),ctx.signal);await check();
  const grant=(readOnly?[scopes.mail,mailSendGrants.compose,mailSendGrants.modify,mailSendGrants.full]:[mailSendGrants.compose,mailSendGrants.modify,mailSendGrants.full]).find(g=>protectedState?.grants.includes(g));if(!grant)fail('MAIL_GMAIL_COMPOSE_GRANT_REQUIRED');
  const access=await abortRace(b.oauth.connectorAccess(b.connectionId,grant!,{signal:ctx.signal}),ctx.signal);await check();
  if(access.accountId!==drafts.sender||access.connectionEpoch!==b.connectionEpoch)fail('MAIL_CONNECTION_CHANGED');
  const connection=async()=>{await check();await abortRace(access.assertCurrent({signal:ctx.signal}),ctx.signal);await check();};
  await connection();const token=await abortRace(access.token({signal:ctx.signal}),ctx.signal);await connection();
  const request=async(path:string,init?:RequestInit)=>{await connection();const pending=options.http('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...init,headers:{Authorization:`Bearer ${token}`,...(init?.method?{'Content-Type':'application/json'}:{})},redirect:'error',signal:ctx.signal},ctx);void pending.then(r=>{if(ctx.signal.aborted)void r.body?.cancel().catch(()=>{});},()=>{});const r=await abortRace(pending,ctx.signal);try{await connection();if(!r.ok){void r.body?.cancel().catch(()=>{});fail('MAIL_GMAIL_DRAFT_UNAVAILABLE');}const result=await boundedJson(r,40*1024*1024,ctx.signal);await connection();return result;}catch(e){void r.body?.cancel().catch(()=>{});throw e;}};
  return {request,connection};
 };
 const verify=(ref:DraftRef,data:any)=>{
  if(!opaque(data?.id)||!opaque(data.message?.id)||!opaque(data.message?.threadId)||typeof data.message.raw!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(data.message.raw))fail('MAIL_REMOTE_DRAFT_CHANGED');
  const snapshot=drafts.read(ref),bytes=drafts.mime(snapshot,()=>true),remote=Buffer.from(data.message.raw,'base64url');
  if(!gmailDraftMimeMatches(bytes,remote))fail('MAIL_REMOTE_DRAFT_CHANGED');
  return {providerDraftId:data.id as string,providerMessageId:data.message.id as string,providerThreadId:data.message.threadId as string};
 };
 return {
  approve(taskId:string,ref:DraftRef,requestId:string){
   const snapshot=drafts.read(ref),bound=mailBinding(drafts.namespace,b.connectionEpoch,snapshot);let result:GmailDraftPublication|undefined;
   tasks.update(taskId,t=>{current(taskId,ref);const state=t.mail!,entries=state.publishes??={};
    const retained=entries['request:'+requestId];if(retained){if(!same(retained.binding,bound))fail('MAIL_REQUEST_ID_CONFLICT');result=retained;return;}
    if(Object.values(entries).some(unknown))fail('MAIL_RECONCILIATION_REQUIRED');
    const existing=Object.values(entries).find(p=>p.connectionId===b.connectionId&&sameRevision(p.binding,bound)&&p.state==='verified');
    result=existing??{id:randomUUID(),requestId,binding:bound,connectionId:b.connectionId,state:'approved'};entries['request:'+requestId]=structuredClone(result);
   });return structuredClone(result!);
  },
  approveExternalWrite(taskId:string,args:unknown){try{const {draft}=options.arguments.parse(args) as {draft:DraftRef};current(taskId,draft);const snap=drafts.read(draft),p=record(taskId,mailBinding(drafts.namespace,b.connectionEpoch,snap));return !!p&&(p.state==='approved'||p.state==='verified');}catch{return false;}},
  tool:{name:'mail.draft.publish',version:'1',effect:'external_write',capabilities:['mail.draft.publish'],inputSchema:options.arguments,
   outputSchema:{jsonSchema:{type:'object',properties:{state:{enum:['gmail_draft','denied','uncertain']},code:{type:'string'},providerDraftId:{type:'string'},providerMessageId:{type:'string'},providerThreadId:{type:'string'}},required:['state'],additionalProperties:false},parse(v:unknown){if(!v||typeof v!=='object'||!['gmail_draft','denied','uncertain'].includes((v as any).state)||Object.entries(v).some(([k,x])=>!['state','code','providerDraftId','providerMessageId','providerThreadId'].includes(k)||typeof x!=='string'))fail('MAIL_INVALID_PUBLICATION_RESULT');return structuredClone(v);}},
   async invoke(value:unknown,original:ToolContext){
    const ctx={...original,signal:AbortSignal.any([original.signal,AbortSignal.timeout(15000)])};let publication:GmailDraftPublication|undefined,dispatched=false;
    const settle=(state:GmailDraftPublication['state'],facts:Partial<GmailDraftPublication>={})=>tasks.update(ctx.taskId,t=>{for(const p of Object.values(t.mail?.publishes??{}))if(p.id===publication!.id){Object.assign(p,facts);if(p.state!=='verified')p.state=state;}});
    try{
     const {draft:ref}=options.arguments.parse(value) as {draft:DraftRef};const snapshot=drafts.read(ref),bound=mailBinding(drafts.namespace,b.connectionEpoch,snapshot);current(ctx.taskId,ref);
     await options.assertCurrent(ctx);publication=record(ctx.taskId,bound);if(!publication)fail('MAIL_GMAIL_DRAFT_APPROVAL_REQUIRED');
     if(publication!.state==='verified')return {callId:ctx.callId,status:'ok' as const,data:{state:'gmail_draft',providerDraftId:publication!.providerDraftId!,providerMessageId:publication!.providerMessageId!,providerThreadId:publication!.providerThreadId!},artifacts:[],evidence:[],observations:['Retained verified Gmail draft; no new POST.']};
     if(publication!.state!=='approved')fail('MAIL_RECONCILIATION_REQUIRED');
     const mime=drafts.mime(snapshot,id=>options.allowAttachment(ctx,id));const api=await transport(ctx,ref);
     tasks.update(ctx.taskId,t=>{if(t.pending?.tool!=='mail.draft.publish'||t.pending.callId!==ctx.callId||t.run.id!==ctx.runId||t.status!=='working'||ctx.signal.aborted||!ctx.isCurrent())fail('MAIL_RUNTIME_ADMISSION_REQUIRED');const p=t.mail?.publishes?.['request:'+publication!.requestId];if(!p||p.state!=='approved'||!same(p.binding,bound))fail('MAIL_RECONCILIATION_REQUIRED');p!.state='intent';});
     await api.connection();dispatched=true;
     const result=await api.request('drafts',{method:'POST',body:JSON.stringify({message:{raw:mime.toString('base64url'),...(snapshot.record.content.reply?{threadId:snapshot.record.content.reply.threadId}:{})}})});
     if(!opaque(result.id))fail('MAIL_GMAIL_DRAFT_UNAVAILABLE');settle('intent',{providerDraftId:result.id});
     const remote=await api.request(`drafts/${encodeURIComponent(result.id)}?format=raw`),facts=verify(ref,remote);if(facts.providerDraftId!==result.id)fail('MAIL_REMOTE_DRAFT_CHANGED');settle('verified',facts);
     return {callId:ctx.callId,status:'ok' as const,data:{state:'gmail_draft',...facts},artifacts:[],evidence:[],observations:['Gmail draft created and its actual MIME read back with exact content and permitted Gmail transport headers. No email sent.']};
    }catch(error){
     const code=dispatched?'MAIL_GMAIL_DRAFT_OUTCOME_UNKNOWN':error instanceof MailFailure?error.code:'MAIL_GMAIL_COMPOSE_GRANT_OR_CONNECTION_REQUIRED';
     if(publication&&publication.state!=='verified')settle(dispatched?'uncertain':'denied',{code});
     return {callId:ctx.callId,status:'needs_input' as const,...(!dispatched?{effect:'none' as const}:{}),data:{state:dispatched?'uncertain':'denied',code},artifacts:[],evidence:[],observations:[dispatched?'Gmail draft outcome uncertain. Read-only reconciliation required; never blindly create again.':'No Gmail draft creation was dispatched.']};
    }
   }
  } satisfies ToolDefinition,
  async providerDraft(ctx:ToolContext,bound:Readonly<MailSendBinding>){
   const publications=Object.values(task(ctx.taskId).mail?.publishes??{}).filter(p=>p.binding.draft.draftId===bound.draft.draftId);
   if(publications.some(unknown))fail('MAIL_RECONCILIATION_REQUIRED');
   const p=publications.find(p=>p.connectionId===b.connectionId&&sameRevision(p.binding,bound)&&p.state==='verified');if(!p)return undefined;
   const api=await transport(ctx,bound.draft);const data=await api.request(`drafts/${encodeURIComponent(p.providerDraftId!)}?format=raw`);const facts=verify(bound.draft,data);if(facts.providerDraftId!==p.providerDraftId)fail('MAIL_REMOTE_DRAFT_CHANGED');return p.providerDraftId;
  },
  async reconcile(ctx:ToolContext,ref:DraftRef){
   const bound=mailBinding(drafts.namespace,b.connectionEpoch,drafts.read(ref)),p=record(ctx.taskId,bound);if(!p||!unknown(p))return;
   const api=await transport(ctx,ref,true);let ids:string[],complete=true;
   if(p.providerDraftId)ids=[p.providerDraftId];else{
    const q=new URLSearchParams({q:`rfc822msgid:${bound.mime.messageId.slice(1,-1)}`,maxResults:'10'}),page=await api.request('drafts?'+q);
    if(page.drafts!==undefined&&(!Array.isArray(page.drafts)||page.drafts.length>10||page.drafts.some((d:any)=>!opaque(d?.id))))fail('MAIL_RECONCILIATION_UNAVAILABLE');
    ids=(page.drafts??[]).map((d:any)=>d.id);complete=page.nextPageToken===undefined;
   }
   const matches:{providerDraftId:string;providerMessageId:string;providerThreadId:string}[]=[];for(const id of ids){const data=await api.request(`drafts/${encodeURIComponent(id)}?format=raw`);try{const facts=verify(ref,data);if(facts.providerDraftId===id)matches.push(facts);}catch{/* A different remote revision is not the authorized snapshot. */}}
   if(complete&&matches.length===1)tasks.update(ctx.taskId,t=>{for(const retained of Object.values(t.mail?.publishes??{}))if(retained.id===p.id){Object.assign(retained,matches[0]);retained.state='verified';delete retained.code;}});
  }
 };
}
