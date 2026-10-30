import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AdmissionObservation } from '../../storage/agent-store.js';
export interface GoogleWakeRoute {route:string;workspace:string;account:string;epoch:string}
export interface GoogleReceiptTiming {receiptAt:number;publishAt?:number}
export interface WakeClaim {key:string;token:string;sequence:number;receipt?:{delivery:string;receiptAt:number;publishAt:number|null}}
/** Google-only delivery journal. Caller authenticates push and verifies the current
 * protected connection epoch before enqueue/claim. A returned enqueue is durable;
 * HTTP acknowledgement must follow it, never precede it. No task admission here. */
export class GoogleWakeJournal {
 private db:DatabaseSync;
 constructor(path:string) {
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS google_wake(route TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, watch_id TEXT, watch_expires INTEGER);
   CREATE TABLE IF NOT EXISTS google_delivery(route TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(route,message));
   CREATE TABLE IF NOT EXISTS google_bootstrap(route TEXT PRIMARY KEY, since INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS google_watch_renewed(route TEXT PRIMARY KEY, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS google_receipt_sequence(route TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS google_admission(route TEXT NOT NULL, task TEXT NOT NULL, observation TEXT NOT NULL, replays INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(route,task));
   CREATE TABLE IF NOT EXISTS google_receipt(route TEXT PRIMARY KEY, delivery TEXT NOT NULL, receipt_at INTEGER NOT NULL, publish_at INTEGER);`);
 }
 close(){this.db.close();}
 /** Trusted configured boundary persists across restarts; a changed boundary requires a new explicit route. */
 bootstrap(route:GoogleWakeRoute,since:number):number {
  if(!Number.isSafeInteger(since)||since<0)throw Error('Invalid bootstrap boundary');
  const key=this.key(route);this.db.prepare('INSERT OR IGNORE INTO google_bootstrap VALUES (?,?)').run(key,since);
  const row=this.db.prepare('SELECT since FROM google_bootstrap WHERE route=?').get(key) as {since:number};
  if(row.since!==since)throw Error('Bootstrap boundary changed');return row.since;
 }
 status(route:GoogleWakeRoute) {return this.db.prepare('SELECT pending-completed AS backlog,retry_at AS retryAt,watch_expires AS watchExpires FROM google_wake WHERE route=?').get(this.key(route));}
 private key(route:GoogleWakeRoute){const fields=[route.route,route.workspace,route.account,route.epoch];if(fields.some(s=>typeof s!=='string'||!s.length||s.length>1024))throw Error('Invalid Google wake route');return JSON.stringify(fields);}
 /** Most recent distinct authenticated delivery, not a message-causal timestamp.
  * Duplicates never refresh it. Admission timing remains unknown until storage can
  * distinguish inserted tasks atomically from existing admissions. */
 receiptStatus(route:GoogleWakeRoute) {
  return this.db.prepare('SELECT delivery,receipt_at AS receiptAt,publish_at AS publishAt FROM google_receipt WHERE route=?').get(this.key(route));
 }
 enqueue(route:GoogleWakeRoute,messageId:string,timing?:GoogleReceiptTiming):boolean {
  const key=this.key(route);if(!messageId||messageId.length>1024)throw Error('Invalid Google delivery ID');
  if(timing&&(!Number.isSafeInteger(timing.receiptAt)||timing.receiptAt<0||timing.receiptAt>8640000000000000))throw Error('Invalid receipt timestamp');
  const publishAt=timing&&Number.isSafeInteger(timing.publishAt)&&timing.publishAt!>=0&&timing.publishAt!<=timing.receiptAt?timing.publishAt!:null;
  this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.prepare('INSERT OR IGNORE INTO google_wake(route) VALUES (?)').run(key);
   const fresh=!!this.db.prepare('INSERT OR IGNORE INTO google_delivery VALUES (?,?)').run(key,messageId).changes;
   if(fresh){
    this.db.prepare('UPDATE google_wake SET pending=pending+1 WHERE route=?').run(key);
    // Receipt and sequence always identify the same delivery. An older concurrent
    // receipt must not move a previously completed hint into the pending range.
    if(timing){
     const changed=this.db.prepare('INSERT INTO google_receipt VALUES (?,?,?,?) ON CONFLICT(route) DO UPDATE SET delivery=excluded.delivery,receipt_at=excluded.receipt_at,publish_at=excluded.publish_at WHERE excluded.receipt_at>=google_receipt.receipt_at').run(key,messageId,timing.receiptAt,publishAt).changes;
     if(changed)this.db.prepare('INSERT INTO google_receipt_sequence SELECT route,pending FROM google_wake WHERE route=? ON CONFLICT(route) DO UPDATE SET sequence=excluded.sequence').run(key);
    }
   }
   this.db.exec('COMMIT');return fresh;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 claim(route:GoogleWakeRoute,now=Date.now(),leaseMs=60000):WakeClaim|undefined {
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>300000)throw Error('Invalid wake lease');
  const key=this.key(route),token=randomUUID();
  // Serialize claim and receipt snapshot against every other journal instance.
  // A pending authenticated wake survives coalesced recovery enqueues, but a
  // receipt belonging to an already completed drain cannot label a new drain.
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const row=this.db.prepare('UPDATE google_wake SET token=?,lease_until=? WHERE route=? AND pending>completed AND retry_at<=? AND lease_until<=? RETURNING pending,completed').get(token,now+leaseMs,key,now,now) as {pending:number;completed:number}|undefined;
   const receipt=row?this.db.prepare('SELECT r.delivery,r.receipt_at AS receiptAt,r.publish_at AS publishAt FROM google_receipt r JOIN google_receipt_sequence s ON s.route=r.route WHERE r.route=? AND s.sequence>? AND s.sequence<=?').get(key,row.completed,row.pending) as WakeClaim['receipt']:undefined;
   this.db.exec('COMMIT');return row?{key,token,sequence:row.pending,receipt}:undefined;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 /** First durable task observation wins. Missing original observations remain unknown on replay.
  * The latest authenticated receipt captured at claim time correlates a route wake,
  * never a particular Gmail message. Recovery drains cannot overwrite prior metrics. */
 recordAdmission(claim:WakeClaim,observation:AdmissionObservation,push:boolean) {
  const {task,disposition,observedAt}=observation;
  const receipt=push?claim.receipt:undefined;
  const admittedAt=disposition==='inserted'?observedAt:null;
  const elapsed=(start:number|undefined|null)=>admittedAt!==null&&start!=null&&Number.isSafeInteger(start)&&start>=0&&start<=admittedAt?admittedAt-start:null;
  const metric={taskId:task.id,disposition,admittedAt,receipt:receipt??null,receiptToAdmissionMs:elapsed(receipt?.receiptAt),publishToAdmissionMs:elapsed(receipt?.publishAt),sequence:claim.sequence,label:'Post-commit observed wall clock; route-wake correlation, not message causality or provider guarantee'};
  this.db.prepare('INSERT INTO google_admission(route,task,observation,replays) VALUES (?,?,?,?) ON CONFLICT(route,task) DO UPDATE SET replays=CASE WHEN google_admission.replays>=9007199254740991 THEN 9007199254740991 ELSE google_admission.replays+1 END').run(claim.key,task.id,JSON.stringify(metric),disposition==='existing'?1:0);
 }
 admissionStatus(route:GoogleWakeRoute,limit=100) {
  return this.admissionPage(route,limit).items;
 }
 admissionPage(route:GoogleWakeRoute,limit=100) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid admission page limit');
  const key=this.key(route);
  // SQL limits rows before JSON parsing; historical retention is unchanged.
  this.db.exec('BEGIN');
  try {
   const {total}=this.db.prepare('SELECT count(*) AS total FROM google_admission WHERE route=?').get(key) as {total:number};
   const rows=this.db.prepare('SELECT observation,replays FROM google_admission WHERE route=? ORDER BY rowid DESC LIMIT ?').all(key,limit) as unknown as {observation:string;replays:number}[];
   const items=rows.reverse().map(row=>({...JSON.parse(row.observation),replays:row.replays}));
   this.db.exec('COMMIT');return {items,total,limit,hasMore:total>items.length};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 /** Renew only a still-live owned claim; never resurrect or steal. */
 renew(claim:WakeClaim,now=Date.now()) {
  const result=this.db.prepare('UPDATE google_wake SET lease_until=? WHERE route=? AND token=? AND lease_until>?').run(now+60000,claim.key,claim.token,now);
  if(!result.changes)throw Error('Google wake lease lost');
 }
 /** Complete only the captured sequence: arrivals during a drain stay pending. */
 complete(claim:WakeClaim,now=Date.now()) {
  const result=this.db.prepare('UPDATE google_wake SET completed=?,token=NULL,lease_until=0,retry_at=0 WHERE route=? AND token=? AND lease_until>? AND pending>=? AND completed<?').run(claim.sequence,claim.key,claim.token,now,claim.sequence,claim.sequence);
  if(!result.changes)throw Error('Google wake lease lost');
 }
 retry(claim:WakeClaim,retryAt:number,now=Date.now()) {
  if(!Number.isSafeInteger(retryAt)||retryAt<0)throw Error('Invalid wake retry');
  // A caller's immediate deadline may precede this clock read by a millisecond.
  retryAt=Math.max(retryAt,now);
  const result=this.db.prepare('UPDATE google_wake SET token=NULL,lease_until=0,retry_at=? WHERE route=? AND token=? AND lease_until>?').run(retryAt,claim.key,claim.token,now);
  if(!result.changes)throw Error('Google wake lease lost');
 }
 lastWatchRenewal(route:GoogleWakeRoute):number {return (this.db.prepare('SELECT at FROM google_watch_renewed WHERE route=?').get(this.key(route)) as {at:number}|undefined)?.at??0;}
 recordWatch(route:GoogleWakeRoute,historyId:string,expiresAt:number) {
  if(!/^\d+$/.test(historyId)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('Invalid Google watch');
  this.db.prepare('INSERT INTO google_watch_renewed VALUES (?,?) ON CONFLICT(route) DO UPDATE SET at=excluded.at').run(this.key(route),Date.now());
  this.db.prepare('INSERT INTO google_wake(route,watch_id,watch_expires) VALUES (?,?,?) ON CONFLICT(route) DO UPDATE SET watch_id=excluded.watch_id,watch_expires=excluded.watch_expires').run(this.key(route),historyId,expiresAt);
 }
 watch(route:GoogleWakeRoute) {return this.db.prepare('SELECT watch_id AS historyId,watch_expires AS expiresAt FROM google_wake WHERE route=? AND watch_id IS NOT NULL').get(this.key(route)) as {historyId:string;expiresAt:number}|undefined;}
}
