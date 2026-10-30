/** Shared user-memory wire contract. Identity is derived from the authenticated session, never a request user ID. */
export const USER_MEMORY_LIMITS={key:8192,value:8192,sourceId:256,eventId:128,workspace:256,sources:8,excerpt:512,operations:16,page:50,requestBytes:512000} as const;
export type MemoryKind = 'fact'|'preference'|'goal';
export interface UserMemorySource {
 id:string; kind:'conversation'|'activity'; sourceId:string;
 workspaceId:string; accountId:string; sha256:string;
 excerpt:string; observedAt:string; expiresAt?:string;
 /** Required for activity sources; references the already authenticated account history. */
 activityKey?:string; activityRevision?:number;
}
/** Same structural validation on writers, readers and persisted-row reconciliation. */
export function isUserMemorySource(value:unknown,workspace:string,accountId?:string):value is UserMemorySource {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const s=value as UserMemorySource,L=USER_MEMORY_LIMITS;
 const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
 const time=(v:unknown):v is string=>typeof v==='string'&&v.length===24&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
 return Object.keys(s).every(k=>['id','kind','sourceId','workspaceId','accountId','sha256','excerpt','observedAt','expiresAt','activityKey','activityRevision'].includes(k))&&text(s.id,L.eventId)&&['conversation','activity'].includes(s.kind)&&text(s.sourceId,L.sourceId)&&s.workspaceId===workspace&&text(s.accountId,256)&&(accountId===undefined||s.accountId===accountId)&&typeof s.sha256==='string'&&/^[a-f0-9]{64}$/.test(s.sha256)&&typeof s.excerpt==='string'&&s.excerpt.length<=L.excerpt&&time(s.observedAt)&&(s.expiresAt===undefined||time(s.expiresAt)&&Date.parse(s.expiresAt)>Date.parse(s.observedAt))&&(s.kind==='activity'?typeof s.activityKey==='string'&&/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(s.activityKey)&&Number.isSafeInteger(s.activityRevision)&&s.activityRevision!>=0:s.activityKey===undefined&&s.activityRevision===undefined);
}
export interface UserMemoryEntry {
 workspaceId:string; key:string; revision:number; seq:number; deleted:boolean; updatedAt:string;
 /** Server-derived automatic source invalidation only; absent means conservative/permanent deletion. */
 deletionReason?:'source_invalidated';
 kind?:MemoryKind; value?:string; origin?:'user'|'inferred'; sources?:UserMemorySource[];
}
/** expectedRevision=0 creates a key. A forgotten key can only be explicitly recreated by a user at its current revision. */
export interface UserMemoryMutation {
 id:string; workspaceId:string; key:string; expectedRevision:number; action:'put'|'forget';
 kind?:MemoryKind; value?:string; origin?:'user'|'inferred'; sources?:UserMemorySource[];
}
/** Content-free source invalidation is independent of current key authority. */
export interface UserMemorySourceForget { id:string; workspaceId:string; kind:'conversation'|'activity'; sourceId:string; activityKey?:string }
export interface UserMemorySourceAck { acknowledged:string[] }
export function isUserMemorySourceForget(value:unknown):value is UserMemorySourceForget {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as UserMemorySourceForget,L=USER_MEMORY_LIMITS;
 const text=(s:unknown,max:number):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
 return Object.keys(v).every(k=>['id','workspaceId','kind','sourceId','activityKey'].includes(k))&&text(v.id,L.eventId)&&text(v.workspaceId,L.workspace)&&text(v.sourceId,L.sourceId)&&['conversation','activity'].includes(v.kind)&&(v.kind==='activity'?typeof v.activityKey==='string'&&/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(v.activityKey):v.activityKey===undefined);
}
export interface UserMemoryPage { entries:UserMemoryEntry[]; cursor:number; hasMore:boolean }
export interface UserMemoryAck { acknowledged:string[]; entries:UserMemoryEntry[] }
export interface AccountIdentity { id:string; name:string }
