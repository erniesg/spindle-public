import {isDeepStrictEqual} from 'node:util';
import type {AccountClient} from '../account/client.js';
import type {Namespace} from '../evidence/store.js';
import {UserMemoryStore,validEntry} from './user-store.js';
import {USER_MEMORY_LIMITS as limits,type UserMemoryAck,type UserMemoryPage,type UserMemoryMutation,type UserMemoryEntry} from './user-protocol.js';
/** One bounded pass. Network results are fenced before any SQLite commit. Conflicts retain stable operation IDs. */
export async function syncUserMemory(store:UserMemoryStore,ns:Namespace,account:AccountClient,signal:AbortSignal,current:()=>boolean,onDeleted:(key:string)=>void,readOnly=false,onInvalidated?:(entry:UserMemoryEntry)=>void):Promise<void>{
 const check=()=>{if(signal.aborted||!current()||account.account?.id!==ns.accountId)throw Error('SESSION_CHANGED');};
 let conflict=false;let sourceError:unknown;let morePages=false;
 check();
 // Source privacy intent precedes any key writes; one bounded pass still reads canonical pages on failure.
 for(const op of readOnly?[]:store.sourceOutbox(ns).slice(0,limits.operations)){
  try{check();const raw=await account.request('/user-memory/forget-source',op,signal);check();const ack=raw as {acknowledged:string[]};if(!ack||Object.keys(ack).join(',')!=='acknowledged'||!Array.isArray(ack.acknowledged)||ack.acknowledged.length!==1||ack.acknowledged[0]!==op.id)throw Error('INVALID_SOURCE_ACK');store.transaction(()=>{check();store.acknowledgeSource(ns,op.id);});}
  catch(e){check();sourceError=e;break;}
 }
 check();const keys=new Set<string>(),operations:UserMemoryMutation[]=[];let oversized=false;
 for(const op of readOnly||store.sourceOutbox(ns).length||sourceError?[]:store.outbox(ns)){
  if(keys.has(op.key))continue;keys.add(op.key);
  // Measure exactly the body AccountClient encodes, including UTF-8 and JSON escaping.
  if(Buffer.byteLength(JSON.stringify({operations:[...operations,op]}),'utf8')>limits.requestBytes){oversized=!operations.length;break;}
  operations.push(op);if(operations.length===limits.operations)break;
 }
 if(operations.length){
  let raw:unknown;
  try{raw=await account.request('/user-memory/sync',{operations},signal);}catch(e){if(e instanceof Error&&e.message==='ACCOUNT_HTTP_409')conflict=true;else throw e;}
  check();if(!conflict){const ack=raw as UserMemoryAck;
  if(!ack||Object.keys(ack).sort().join(',')!=='acknowledged,entries'||!Array.isArray(ack.acknowledged)||ack.acknowledged.length!==operations.length||new Set(ack.acknowledged).size!==operations.length||!operations.every(o=>ack.acknowledged.includes(o.id))||!Array.isArray(ack.entries)||ack.entries.length!==operations.length||new Set(ack.entries.map(e=>e?.key)).size!==operations.length)throw Error('INVALID_SYNC_ACK');
  for(const op of operations){const e=ack.entries.find(e=>e?.key===op.key);if(!validEntry(e,ns.workspaceId)||e.sources?.some(s=>s.accountId!==ns.accountId))throw Error('INVALID_SYNC_ACK');
   const redacted=e.deleted&&e.revision>=op.expectedRevision+1;
   const correctionWins=op.origin==='inferred'&&e.origin==='user'&&e.revision>=op.expectedRevision;
   const exact=e.revision===op.expectedRevision+1&&e.deleted===(op.action==='forget')&&(e.deleted||e.value===op.value&&e.kind===op.kind&&e.origin===op.origin&&isDeepStrictEqual(e.sources,op.sources));
   if(!redacted&&!correctionWins&&!exact)throw Error('INVALID_SYNC_ACK');}
  for(const e of ack.entries)store.validateCanonical(ns,e);
  for(const e of ack.entries)if(e.deleted){if(e.deletionReason==='source_invalidated')onInvalidated?.(e);else onDeleted(e.key);}
  store.transaction(()=>{for(const e of ack.entries)store.putCanonical(ns,e);store.acknowledge(ns,ack.acknowledged);});}
 }
 let cursor=Number(store.state(ns,'cursor')??0);
 for(let pageIndex=0;pageIndex<4;pageIndex++){
  const raw=await account.request(`/user-memory/changes?workspaceId=${encodeURIComponent(ns.workspaceId)}&cursor=${cursor}&limit=50`,undefined,signal);check();const page=raw as UserMemoryPage;
  if(!page||Object.keys(page).sort().join(',')!=='cursor,entries,hasMore'||!Array.isArray(page.entries)||page.entries.length>50||!Number.isSafeInteger(page.cursor)||page.cursor<cursor||typeof page.hasMore!=='boolean'||page.hasMore&&page.cursor<=cursor)throw Error('INVALID_SYNC_PAGE');
  const pageKeys=new Set<string>();let seq=cursor;for(const e of page.entries){if(pageKeys.has(e?.key)||!validEntry(e,ns.workspaceId)||e.sources?.some(s=>s.accountId!==ns.accountId)||e.seq<=seq||e.seq>page.cursor)throw Error('INVALID_SYNC_PAGE');seq=e.seq;pageKeys.add(e.key);}
  for(const e of page.entries)store.validateCanonical(ns,e);
  for(const e of page.entries)if(e.deleted){if(e.deletionReason==='source_invalidated')onInvalidated?.(e);else onDeleted(e.key);}
  store.transaction(()=>{for(const e of page.entries)store.putCanonical(ns,e);store.setState(ns,'cursor',String(page.cursor));});
  cursor=page.cursor;morePages=page.hasMore;if(!page.hasMore)break;
 }
 if(sourceError)throw sourceError;
 if(oversized)throw Error('INVALID_MEMORY_OPERATION_BYTES');
 if(conflict)throw Error('ACCOUNT_HTTP_409');
 if(!morePages&&!store.outbox(ns).length&&!store.sourceOutbox(ns).length)store.setState(ns,'lastSync',new Date().toISOString());
}
