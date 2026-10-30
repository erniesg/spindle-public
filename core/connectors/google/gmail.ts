import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentStore, AdmissionObservation } from '../../storage/agent-store.js';
import { abortRace } from './abort.js';
import { boundedBytes, text } from './bounded.js';
export interface GmailPollLifecycle {
 onAdmission?:(observation:AdmissionObservation)=>void;
 signal?:AbortSignal;
 /** Stable verified connection identity; omitted for legacy low-level callers. */
 connectionEpoch?:string;
 /** Google-local bounded drain notification; number return remains compatible. */
 onProgress?:(complete:boolean)=>void;
 now?:()=>number;
 /** Synchronous connection-epoch fence supplied by the owning connection lifecycle. */
 assertCurrent?:()=>void|Promise<void>;
 /** Trusted owner policy for initial/expired-history scans, not a model decision. */
 eligibleDuringReconciliation?:(message:unknown)=>boolean;
}
/** Cursor commits occur only after durable AgentStore admission. Crash between DBs replays safely. */
export class GmailSync {
 private db:DatabaseSync;

 constructor(path:string,private tasks:AgentStore,private http:typeof fetch=fetch){this.db=new DatabaseSync(path);this.db.exec('CREATE TABLE IF NOT EXISTS google_cursor(account TEXT PRIMARY KEY,cursor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS google_poll_lease(owner TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS google_catchup(owner TEXT PRIMARY KEY, state TEXT NOT NULL)');}
 close(){this.db.close();}
 async poll(account:string,workspace:string,token:string,relevant:(message:unknown)=>Promise<string|undefined>,lifecycle:GmailPollLifecycle={}) {
  const current=async()=>{lifecycle.signal?.throwIfAborted();const work=Promise.resolve(lifecycle.assertCurrent?.());await (lifecycle.signal?abortRace(work,lifecycle.signal):work);lifecycle.signal?.throwIfAborted();};
  await current();
  const now=lifecycle.now??Date.now;
  const owner=JSON.stringify([workspace,account]), lease=randomUUID();
  const acquired=this.db.prepare('INSERT INTO google_poll_lease VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE google_poll_lease.expires<=?').run(owner,lease,now()+60000,now());
  if(!acquired.changes)throw Error('Gmail sync busy');
  let heartbeatFailure:unknown;
  const assertLease=async()=>{if(heartbeatFailure)throw heartbeatFailure;await current();if(closed)throw Error('Gmail poll closed');const renewed=this.db.prepare('UPDATE google_poll_lease SET expires=? WHERE owner=? AND token=? AND expires>?').run(now()+60000,owner,lease,now());if(!renewed.changes)throw Error('Gmail sync lease expired');};
  let heartbeatBusy=false,closed=false;
  const heartbeat=setInterval(()=>{if(heartbeatBusy||closed)return;heartbeatBusy=true;void assertLease().catch(error=>{heartbeatFailure=error;}).finally(()=>{heartbeatBusy=false;});},10000);heartbeat.unref();
  try{return await this.pollOnce(account,workspace,token,relevant,assertLease,lifecycle);}finally{closed=true;clearInterval(heartbeat);this.db.prepare('DELETE FROM google_poll_lease WHERE owner=? AND token=?').run(owner,lease);}
 }
 private async pollOnce(account:string,workspace:string,token:string,relevant:(message:unknown)=>Promise<string|undefined>,assertLease:()=>Promise<void>,lifecycle:GmailPollLifecycle) {
  const cursorKey=JSON.stringify(lifecycle.connectionEpoch===undefined?[workspace,account]:[workspace,account,lifecycle.connectionEpoch]);
  let totalBytes=0,calls=0;
  const get=async(path:string)=>{await assertLease();if(++calls>1102)throw Error('Gmail aggregate call limit exceeded');const signal=lifecycle.signal?AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);const r=await abortRace(this.http(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers:{Authorization:`Bearer ${token}`},signal}),signal);await assertLease();if(!r.ok){const bytes=await boundedBytes(r,Math.min(65536,16*1024*1024-totalBytes),signal);totalBytes+=bytes.length;await assertLease();let detail:any;try{detail=JSON.parse(bytes.toString('utf8'));}catch{}const errors=Array.isArray(detail?.error?.errors)?detail.error.errors:[];throw Object.assign(Error(`Gmail ${r.status}: reconnect or reconcile required`),{status:r.status,errors});}const bytes=await boundedBytes(r,Math.min(2*1024*1024,16*1024*1024-totalBytes),signal);totalBytes+=bytes.length;await assertLease();const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Gmail JSON');return value;};
  const profile=await get('profile');if(profile.emailAddress!==account)throw Error('Wrong Google account: reconnect required');
  const old=this.db.prepare('SELECT cursor FROM google_cursor WHERE account=?').get(cursorKey) as {cursor:string}|undefined;
  if(!text(profile.historyId))throw Error('Invalid Gmail profile');
  type Progress={incremental:boolean;start?:string;cursor:string;page?:string;next?:string;ids?:string[];offset:number};
  const saved=this.db.prepare('SELECT state FROM google_catchup WHERE owner=?').get(cursorKey) as {state:string}|undefined;
  let state:Progress=saved?JSON.parse(saved.state):{incremental:!!old,start:old?.cursor,cursor:String(profile.historyId),offset:0};
  const save=()=>this.db.prepare('INSERT INTO google_catchup VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET state=excluded.state').run(cursorKey,JSON.stringify(state));
  // Each invocation drains at most one provider page. Persist before item work,
  // then checkpoint only after durable task admission (cross-database replay dedupes).
  let processed=0,pages=0;const began=(lifecycle.now??Date.now)();
  while(true) {
  if(!state.ids) {
   if(++pages>10){lifecycle.onProgress?.(false);return processed;}
   const q=new URLSearchParams(state.incremental?{startHistoryId:state.start!,historyTypes:'messageAdded',maxResults:'100'}:{maxResults:'100'});if(state.page)q.set('pageToken',state.page);
   let data:Record<string,any>;
   try {data=await get(`${state.incremental?'history':'messages'}?${q}`);}
   catch(error){const failure=error as {status?:number;errors?:{reason?:string;message?:string}[]};if(state.page&&[400,404,410].includes(failure.status??0)&&failure.errors?.some(e=>['invalidArgument','invalid','notFound'].includes(e.reason??'')&&/page\s*token/i.test(e.message??''))){state={incremental:state.incremental,start:state.start,cursor:state.cursor,offset:0};await assertLease();save();continue;}if(state.incremental&&(failure.status===404||failure.status===410)){state={incremental:false,cursor:String(profile.historyId),offset:0};await assertLease();save();continue;}throw error;}
   if(data.nextPageToken!==undefined&&!text(data.nextPageToken))throw Error('Invalid Gmail page');
   if(data.messages!==undefined&&(!Array.isArray(data.messages)||data.messages.some((m:any)=>!m||!text(m.id))))throw Error('Invalid Gmail messages');
   if(data.history!==undefined){if(!Array.isArray(data.history))throw Error('Invalid Gmail history');for(const h of data.history){if(!h||!text(h.id))throw Error('Invalid Gmail history');if(h.messagesAdded!==undefined&&(!Array.isArray(h.messagesAdded)||h.messagesAdded.some((m:any)=>!m?.message||!text(m.message.id))))throw Error('Invalid Gmail additions');}}
   if(state.incremental&& !text(data.historyId))throw Error('Invalid Gmail history cursor');
   const ids=new Set<string>();
   if(state.incremental){for(const h of data.history??[])for(const m of h.messagesAdded??[])ids.add(m.message.id);}else for(const m of data.messages??[])ids.add(m.id);
   // Provider page bounded independently of mailbox size, never a whole-mailbox array.
   if(ids.size>1000)throw Error('Gmail provider page too large');
   if(data.nextPageToken&&data.nextPageToken===state.page)throw Error('Repeated Gmail page; cursor retained');
   state.ids=[...ids];state.next=data.nextPageToken;state.offset=0;await assertLease();save();
  }
  while(state.offset<state.ids!.length&&processed<20&&(processed===0||(lifecycle.now??Date.now)()-began<10000)) {
   const id=state.ids![state.offset];let message:any;
   try{message=await get(`messages/${encodeURIComponent(id)}?format=full`);}catch(error){const failure=error as {status?:number;errors?:{reason?:string}[]};if(failure.status===404&&failure.errors?.some(e=>e.reason==='notFound')){await assertLease();state.offset++;processed++;save();continue;}throw error;}
   if(message.id!==id)throw Error('Invalid Gmail message; cursor retained');await assertLease();
   if(state.incremental||!lifecycle.eligibleDuringReconciliation||lifecycle.eligibleDuringReconciliation(message)) {
    const outcome=await (lifecycle.signal?abortRace(relevant(message),lifecycle.signal):relevant(message));await assertLease();
    if(outcome)this.tasks.admit({accountId:account,workspaceId:workspace,messageId:id,outcome},100,lifecycle.onAdmission);
   }
   state.offset++;processed++;await assertLease();save();
  }
  await assertLease();
  if(state.offset<state.ids!.length){lifecycle.onProgress?.(false);return processed;}
  if(state.next){state.page=state.next;delete state.ids;delete state.next;state.offset=0;save();if(processed>=20||(lifecycle.now??Date.now)()-began>=10000){lifecycle.onProgress?.(false);return processed;}continue;}
  // Captured pre-list profile is deliberately conservative: mail arriving during
  // the scan is replayed by history on the next drain, not skipped.
  this.db.exec('BEGIN IMMEDIATE');
  try{this.db.prepare('INSERT INTO google_cursor VALUES (?,?) ON CONFLICT(account) DO UPDATE SET cursor=excluded.cursor').run(cursorKey,state.cursor);this.db.prepare('DELETE FROM google_catchup WHERE owner=?').run(cursorKey);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  lifecycle.onProgress?.(true);return processed;
  }
 }
}
