import {createHash} from 'node:crypto';
import {isUserMemorySource,isUserMemorySourceForget,USER_MEMORY_LIMITS as L,type UserMemorySource,type UserMemorySourceForget,type UserMemorySourceAck,type UserMemoryMutation,type UserMemoryEntry,type UserMemoryAck,type UserMemoryPage} from '../memory/user-protocol.js';
import type {Entry} from './types.js';
export interface UserMemoryState {
 entries:UserMemoryEntry[]; sequence:number;
 operationReceipts:{id:string;digest:string;entry:UserMemoryEntry}[];
 // Content-free, durable source-forget fences; operation IDs alone cannot fence new keys.
 sourceFences?:string[];
 // At most one binding per current automatic tombstone (1000 keys, <=8 hashes/key).
 // No source text/identity survives; explicit forget can still retire its revival authority.
 invalidatedSources?:{workspaceId:string;key:string;fences:string[]}[];
 // Separate content-free receipts: source invalidation is not a key mutation.
 sourceOperationReceipts?:{id:string;digest:string}[];
}
export class UserMemoryFailure extends Error {constructor(readonly status:number,code:string){super(code);}}
function fail(status:number,code:string):never {throw new UserMemoryFailure(status,code);}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const fields=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
// Sort recursively so equivalent JSON objects share one payload digest.
function canonical(v:unknown):string {
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
function validate(v:unknown,accountId:string):asserts v is UserMemoryMutation {
 if(!object(v)||!fields(v,['id','workspaceId','key','expectedRevision','action','kind','value','origin','sources'])||!text(v.id,L.eventId)||!text(v.workspaceId,L.workspace)||!text(v.key,L.key)||!Number.isSafeInteger(v.expectedRevision)||(v.expectedRevision as number)<0)fail(400,'INVALID_MEMORY_OPERATION');
 if(v.action==='forget'){
  if(Object.keys(v).some(k=>['kind','value','origin','sources'].includes(k)))fail(400,'INVALID_MEMORY_OPERATION');return;
 }
 if(v.action!=='put'||!['fact','preference','goal'].includes(v.kind as string)||!text(v.value,L.value)||!['user','inferred'].includes(v.origin as string)||v.sources!==undefined&&!Array.isArray(v.sources)||Array.isArray(v.sources)&&v.sources.length>L.sources||v.origin==='inferred'&&(!Array.isArray(v.sources)||v.sources.length===0))fail(400,'INVALID_MEMORY_OPERATION');
 for(const source of (v.sources??[]) as unknown[]){
  if(!isUserMemorySource(source,v.workspaceId as string,accountId))fail(400,'INVALID_MEMORY_SOURCE');
 }
}
function sourceFence(source:Pick<UserMemorySource,'workspaceId'|'kind'|'sourceId'|'activityKey'>):string {
 return createHash('sha256').update(JSON.stringify([source.workspaceId,source.kind,source.kind==='activity'?(source.activityKey??source.sourceId):source.sourceId])).digest('hex');
}
function fenceSources(state:UserMemoryState,sources:Pick<UserMemorySource,'workspaceId'|'kind'|'sourceId'|'activityKey'>[]=[]){
 fenceHashes(state,sources.map(sourceFence));
}
function fenceHashes(state:UserMemoryState,hashes:string[]){
 const fences=state.sourceFences??=[];
 const added=[...new Set(hashes)].filter(f=>!fences.includes(f));
 if(fences.length+added.length>10000)fail(507,'MEMORY_SOURCE_FENCE_BOUND');
 fences.push(...added);
}
// User corrections do not require live activity history. Only explicit invalidation
// or expiry removes otherwise well-formed provenance from their canonical value.
function forgottenSource(state:UserMemoryState,source:UserMemorySource,now:number):boolean {
 return !!state.sourceFences?.includes(sourceFence(source))||source.expiresAt!==undefined&&Date.parse(source.expiresAt)<=now;
}
function validSource(state:UserMemoryState,source:UserMemorySource,accountId:string,history:Entry[],now:number):boolean {
 if(source.accountId!==accountId||state.sourceFences?.includes(sourceFence(source))||source.expiresAt!==undefined&&Date.parse(source.expiresAt)<=now)return false;
 if(source.kind==='conversation')return true;
 if(!source.activityKey||!Number.isSafeInteger(source.activityRevision))return false;
 const entry=history.find(e=>e.key===source.activityKey),r=entry?.record;
 if(!r||entry!.deleted||r.revision!==source.activityRevision||r.expiresAt<=now||r.visit.expiresAt<=now||!r.scopes.recording||!r.scopes.retention||!r.scopes.upload)return false;
 const content=[r.visit.title,r.visit.text].filter(Boolean).join('\n');
 return createHash('sha256').update(content).digest('hex')===source.sha256&&content.includes(source.excerpt);
}
// Explicit privacy intent retires automatic tombstones with a NEW canonical revision.
function permanentlyForgetInvalidated(state:UserMemoryState,fences:string[],now=Date.now()){
 for(const binding of [...state.invalidatedSources??[]])if(binding.fences.some(f=>fences.includes(f))){
  const previous=state.entries.find(e=>e.workspaceId===binding.workspaceId&&e.key===binding.key);
  if(previous?.deleted&&previous.deletionReason==='source_invalidated'){
   if(state.sequence>=Number.MAX_SAFE_INTEGER||previous.revision>=Number.MAX_SAFE_INTEGER)fail(507,'MEMORY_SEQUENCE_BOUND');
   const entry:UserMemoryEntry={workspaceId:previous.workspaceId,key:previous.key,revision:previous.revision+1,seq:++state.sequence,deleted:true,updatedAt:new Date(now).toISOString()};
   state.entries[state.entries.indexOf(previous)]=entry;
   for(const r of state.operationReceipts)if(r.entry.workspaceId===entry.workspaceId&&r.entry.key===entry.key&&(!r.entry.deleted||r.entry.deletionReason==='source_invalidated'))r.entry=entry;
  }
  state.invalidatedSources=state.invalidatedSources!.filter(b=>b!==binding);
 }
}
/** Runs in the account transaction, independent of local processing/learner availability. */
export function reconcileUserMemory(state:UserMemoryState,accountId:string,history:Entry[],now=Date.now()):void {
 // Decide before adding expiry fences: existing explicit identity fences must never
 // acquire automatic revival authority. Ambiguous legacy/missing/deleted history stays permanent.
 const automatic=new Set(state.entries.filter(e=>!e.deleted&&e.origin==='inferred'&&e.sources?.length&&e.sources.length<=L.sources&&e.sources.every(s=>isUserMemorySource(s,e.workspaceId,accountId)&&!state.sourceFences?.includes(sourceFence(s)))&&e.sources.some(s=>{
  if(s.expiresAt!==undefined&&Date.parse(s.expiresAt)<=now)return true;
  const r=s.kind==='activity'?history.find(h=>h.key===s.activityKey&&!h.deleted)?.record:undefined;
  return !!r&&(r.revision!==s.activityRevision||r.expiresAt<=now||r.visit.expiresAt<=now);
 })));
 // Expired conversations have no server history row: retain a content-free fence so
 // a new operation/key (or a fabricated later expiry) cannot recreate that source.
 for(const e of [...state.entries,...state.operationReceipts.map(r=>r.entry)])for(const source of e.sources??[])if(source.kind==='conversation'&&source.expiresAt!==undefined&&Date.parse(source.expiresAt)<=now)fenceSources(state,[source]);
 const malformed=(e:UserMemoryEntry)=>e.sources?.some(s=>!isUserMemorySource(s,e.workspaceId,accountId));
 const forgotten=(e:UserMemoryEntry)=>e.sources?.some(s=>forgottenSource(state,s,now));
 const invalid=(e:UserMemoryEntry)=>!e.deleted&&e.origin==='inferred'&&(!e.sources?.length||malformed(e)||e.sources.some(s=>!validSource(state,s,accountId,history,now)));
 // Old APIs accepted structurally incompatible user provenance. Preserve correction
 // authority/content and valid sources, but publish the repair past existing cursors.
 for(const previous of state.entries)if(!previous.deleted&&previous.origin==='user'&&(malformed(previous)||forgotten(previous))){
  if(state.sequence>=Number.MAX_SAFE_INTEGER||previous.revision>=Number.MAX_SAFE_INTEGER)fail(507,'MEMORY_SEQUENCE_BOUND');
  const entry={...previous,sources:previous.sources!.filter(s=>isUserMemorySource(s,previous.workspaceId,accountId)&&!forgottenSource(state,s,now)),revision:previous.revision+1,seq:++state.sequence,updatedAt:new Date(now).toISOString()};
  state.entries[state.entries.indexOf(previous)]=entry;
 }
 for(const previous of state.entries)if(invalid(previous)){
  if(state.sequence>=Number.MAX_SAFE_INTEGER||previous.revision>=Number.MAX_SAFE_INTEGER)fail(507,'MEMORY_SEQUENCE_BOUND');
  const entry:UserMemoryEntry={workspaceId:previous.workspaceId,key:previous.key,revision:previous.revision+1,seq:++state.sequence,deleted:true,updatedAt:new Date(now).toISOString()};
  if(automatic.has(previous)){
   entry.deletionReason='source_invalidated';
   (state.invalidatedSources??=[]).push({workspaceId:entry.workspaceId,key:entry.key,fences:[...new Set(previous.sources!.map(sourceFence))]});
  }
  state.entries[state.entries.indexOf(previous)]=entry;
  for(const receipt of state.operationReceipts)if(receipt.entry.workspaceId===entry.workspaceId&&receipt.entry.key===entry.key)receipt.entry=entry;
 }
 // Superseded inferred snapshots can outlive their source too. Preserve independent corrections.
 for(const receipt of state.operationReceipts){
  const current=state.entries.find(e=>e.workspaceId===receipt.entry.workspaceId&&e.key===receipt.entry.key)!;
  // A tombstone ACK must never become a later recreation. Conversely a current
  // tombstone must replace any retained content, including legacy malformed rows.
  if(current&&(current.deleted||invalid(receipt.entry)||!receipt.entry.deleted&&(malformed(receipt.entry)||forgotten(receipt.entry))))receipt.entry=receipt.entry.deleted?receipt.entry:current;
 }
}
/** Caller commits fence, reconciliation and receipt in one encrypted account transaction. */
export function forgetUserMemorySource(state:UserMemoryState,accountId:string,data:unknown,history:Entry[]=[]):UserMemorySourceAck {
 if(!isUserMemorySourceForget(data))fail(400,'INVALID_MEMORY_SOURCE_FORGET');
 const op:UserMemorySourceForget=data;
 const digest=createHash('sha256').update(canonical(op)).digest('hex');
 const receipts=state.sourceOperationReceipts??=[];
 const receipt=receipts.find(r=>r.id===op.id);
 if(receipt){if(receipt.digest!==digest)fail(409,'MEMORY_OPERATION_CONFLICT');return {acknowledged:[op.id]};}
 if(receipts.length>=10000)fail(507,'MEMORY_SOURCE_RECEIPT_BOUND');
 fenceSources(state,[op]);
 permanentlyForgetInvalidated(state,[sourceFence(op)]);
 reconcileUserMemory(state,accountId,history);
 receipts.push({id:op.id,digest});
 return {acknowledged:[op.id]};
}
export function syncUserMemory(state:UserMemoryState,accountId:string,data:Record<string,unknown>,history:Entry[]=[]):UserMemoryAck {
 reconcileUserMemory(state,accountId,history);
 if(!fields(data,['operations'])||!Array.isArray(data.operations)||data.operations.length<1||data.operations.length>L.operations)fail(400,'MEMORY_BATCH_BOUND');
 const operations=data.operations as unknown[];for(const op of operations){
  // Exact legacy replays may contain a now-invalid source shape. Their retained
  // digest still authenticates the original payload; return only repaired ACKs.
  const replay=object(op)&&state.operationReceipts.find(r=>r.id===op.id&&r.digest===createHash('sha256').update(canonical(op)).digest('hex'));
  if(!replay)validate(op,accountId);
 }
 const acknowledged:string[]=[];
 for(const op of operations as UserMemoryMutation[]){
  const digest=createHash('sha256').update(canonical(op)).digest('hex');
  const receipt=state.operationReceipts.find(r=>r.id===op.id);
  if(receipt){if(receipt.digest!==digest)fail(409,'MEMORY_OPERATION_CONFLICT');acknowledged.push(op.id);continue;}
  if(op.action==='put'&&op.origin==='inferred'&&op.sources!.some(s=>!validSource(state,s,accountId,history,Date.now())))fail(409,'MEMORY_SOURCE_STALE');
  if(state.operationReceipts.length>=10000)fail(507,'MEMORY_RECEIPT_BOUND');
  const previous=state.entries.find(e=>e.workspaceId===op.workspaceId&&e.key===op.key);
  if(!previous&&state.entries.length>=1000)fail(507,'MEMORY_KEY_BOUND');
  if(previous?.deleted&&previous.deletionReason!=='source_invalidated'&&op.action==='put'&&op.origin==='inferred')fail(409,'MEMORY_FORGOTTEN');
  let entry:UserMemoryEntry;
  if(previous?.origin==='user'&&op.action==='put'&&op.origin==='inferred')entry=previous;
  else {
   if(op.expectedRevision!==(previous?.revision??0))fail(409,'MEMORY_STALE_REVISION');
   if(state.sequence>=Number.MAX_SAFE_INTEGER||(previous?.revision??0)>=Number.MAX_SAFE_INTEGER)fail(507,'MEMORY_SEQUENCE_BOUND');
   entry={workspaceId:op.workspaceId,key:op.key,revision:(previous?.revision??0)+1,seq:++state.sequence,deleted:op.action==='forget',updatedAt:new Date().toISOString()};
   if(op.action==='put')Object.assign(entry,{kind:op.kind,value:op.value,origin:op.origin,sources:op.sources??[]});
   const binding=state.invalidatedSources?.find(b=>b.workspaceId===op.workspaceId&&b.key===op.key);
   state.invalidatedSources=state.invalidatedSources?.filter(b=>b!==binding);
   if(previous)state.entries[state.entries.indexOf(previous)]=entry;else state.entries.push(entry);
   // Forget removes content from retained replay receipts too. IDs/digests still fence replay.
   if(op.action==='forget'){
    const hashes=[...(binding?.fences??[]),...(previous?.sources??[]).map(sourceFence)];
    for(const r of state.operationReceipts)if(r.entry.workspaceId===op.workspaceId&&r.entry.key===op.key){hashes.push(...(r.entry.sources??[]).map(sourceFence));r.entry=entry;}
    fenceHashes(state,hashes);
    permanentlyForgetInvalidated(state,hashes);
   }
  }
  state.operationReceipts.push({id:op.id,digest,entry});acknowledged.push(op.id);
 }
 // A forget can invalidate another key in the same batch; never publish an earlier snapshot.
 reconcileUserMemory(state,accountId,history);
 return {acknowledged,entries:acknowledged.map(id=>state.operationReceipts.find(r=>r.id===id)!.entry)};
}
export function userMemoryChanges(state:UserMemoryState,query:URLSearchParams):UserMemoryPage {
 if([...query.keys()].some(k=>!['workspaceId','cursor','limit'].includes(k)||query.getAll(k).length!==1)||!text(query.get('workspaceId'),L.workspace))fail(400,'INVALID_MEMORY_QUERY');
 const raw=query.get('cursor')??'0',limitRaw=query.get('limit')??'50';
 if(!/^(0|[1-9]\d{0,15})$/.test(raw)||! /^[1-9]\d?$/.test(limitRaw))fail(400,'INVALID_MEMORY_CURSOR');
 const cursor=Number(raw),limit=Number(limitRaw);
 if(!Number.isSafeInteger(cursor)||cursor>state.sequence||limit>L.page)fail(400,'INVALID_MEMORY_CURSOR');
 const selected=state.entries.filter(e=>e.workspaceId===query.get('workspaceId')&&e.seq>cursor).sort((a,b)=>a.seq-b.seq);
 const entries:UserMemoryEntry[]=[];let bytes=0;
 for(const e of selected){const size=Buffer.byteLength(JSON.stringify(e));if(entries.length>=limit||bytes+size>990000)break;entries.push(e);bytes+=size;}
 const hasMore=selected.length>entries.length;
 return {entries,cursor:hasMore?entries.at(-1)!.seq:state.sequence,hasMore};
}
