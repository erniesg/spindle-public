import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { SourceEvent, Task } from '../agent/contracts.js';
import type { TaskSummary, TaskView } from '../assistant/task-view.js';
import type { PreparationNotice, TaskNamespace } from '../notifications/events.js';
import type {PreparationAction} from '../preparation/types.js';

/** Dedicated agent metadata, not the capture vault. SQLite commits admissions and fences atomically.
 * Local private plaintext data: caller owns directory permissions and retention; no secrets here.
 */
export interface AdmissionObservation {task:Task;disposition:'inserted'|'existing';observedAt:number}
export class AgentStore {
 private db: DatabaseSync;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS agent_tasks (id TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL)');
  this.db.exec(`CREATE TABLE IF NOT EXISTS preparation_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, task_id TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS preparation_action_owner ON preparation_actions(workspace_id,account_id,task_id,id);`);
  // Triggers share the Task statement/transaction: rollback cannot publish a ghost notice.
  // Installing the outbox does not invent past transitions for pre-existing tasks.
  this.db.exec(`CREATE TABLE IF NOT EXISTS preparation_notices (
   id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
   account_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER, acknowledged INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS preparation_delivery ON preparation_notices(workspace_id,account_id,acknowledged,id);
   CREATE TRIGGER IF NOT EXISTS preparation_admitted AFTER INSERT ON agent_tasks BEGIN
    INSERT INTO preparation_notices(task_id,workspace_id,account_id,kind,revision)
    SELECT NEW.id,json_extract(NEW.body,'$.sourceEvent.workspaceId'),json_extract(NEW.body,'$.sourceEvent.accountId'),json_extract(NEW.body,'$.status'),json_extract(NEW.body,'$.applicationRevision.revision');
   END;
   CREATE TRIGGER IF NOT EXISTS preparation_transition AFTER UPDATE OF body ON agent_tasks
   WHEN json_extract(OLD.body,'$.status') != json_extract(NEW.body,'$.status') BEGIN
    INSERT INTO preparation_notices(task_id,workspace_id,account_id,kind,revision)
    SELECT NEW.id,json_extract(NEW.body,'$.sourceEvent.workspaceId'),json_extract(NEW.body,'$.sourceEvent.accountId'),json_extract(NEW.body,'$.status'),json_extract(NEW.body,'$.applicationRevision.revision');
   END;`);
 }
 /** Exclusive preparation dispatcher ownership; crash leaves a reconciliation hold, never auto-steal. */
 claimPreparationOwner():()=>void {
  const nonce=randomUUID();this.db.exec('CREATE TABLE IF NOT EXISTS preparation_runtime_owner (id INTEGER PRIMARY KEY CHECK(id=1), nonce TEXT NOT NULL)');
  try{this.db.prepare('INSERT INTO preparation_runtime_owner VALUES(1,?)').run(nonce);}catch{throw Error('PREPARATION_OWNER_RECONCILIATION_REQUIRED');}
  return ()=>{this.db.prepare('DELETE FROM preparation_runtime_owner WHERE id=1 AND nonce=?').run(nonce);};
 }
 close(): void { this.db.close(); }
 /** Trusted UI namespace only; model arguments never select it. */
 tasks(namespace: TaskNamespace): Task[] {
  return (this.db.prepare("SELECT body FROM agent_tasks WHERE json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=? ORDER BY rowid DESC LIMIT 100").all(namespace.workspaceId,namespace.accountId) as {body:string}[]).map(row=>JSON.parse(row.body) as Task);
 }
 /** Exact-intent admission lookup, independent of the UI's bounded history projection. */
 preparationForIntent(namespace:TaskNamespace,rootId:string,request:string):Task|undefined {
  const row=this.db.prepare("SELECT body FROM agent_tasks WHERE json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=? AND json_extract(body,'$.preparation.rootId')=? AND json_extract(body,'$.preparation.request')=? ORDER BY (json_extract(body,'$.status')='working') DESC,rowid DESC LIMIT 1").get(namespace.workspaceId,namespace.accountId,rootId,request) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 preparationForRequest(namespace:TaskNamespace,requestId:string):Task|undefined {
  const row=this.db.prepare('SELECT body FROM agent_tasks WHERE event_key=?').get(JSON.stringify([namespace.workspaceId,namespace.accountId,'preparation:'+requestId])) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 preparationAction(namespace:TaskNamespace,actionId:string):PreparationAction|undefined {
  const row=this.db.prepare("SELECT body FROM preparation_actions WHERE workspace_id=? AND account_id=? AND json_extract(body,'$.action')='request' AND json_extract(body,'$.actionId')=? ORDER BY id DESC LIMIT 1").get(namespace.workspaceId,namespace.accountId,actionId) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 recordPreparationAction(namespace:TaskNamespace,action:PreparationAction):void {
  // No deletion/rollup of unknown facts. Saturation refuses new actions rather than erasing history.
  const count=this.db.prepare('SELECT count(*) AS n FROM preparation_actions WHERE workspace_id=? AND account_id=?').get(namespace.workspaceId,namespace.accountId) as {n:number};
  if(count.n>=4096)throw Error('PREPARATION_ACTION_HISTORY_FULL');
  this.db.prepare('INSERT INTO preparation_actions(workspace_id,account_id,task_id,body) VALUES(?,?,?,?)').run(namespace.workspaceId,namespace.accountId,action.taskId,JSON.stringify(action));
 }
 preparationActionCount(namespace:TaskNamespace,taskId:string):number {
  return (this.db.prepare('SELECT count(*) AS n FROM preparation_actions WHERE workspace_id=? AND account_id=? AND task_id=?').get(namespace.workspaceId,namespace.accountId,taskId) as {n:number}).n;
 }
 preparationActions(namespace:TaskNamespace,taskId:string):PreparationAction[] {
  return (this.db.prepare('SELECT body FROM preparation_actions WHERE workspace_id=? AND account_id=? AND task_id=? ORDER BY id DESC LIMIT 64').all(namespace.workspaceId,namespace.accountId,taskId) as {body:string}[]).reverse().map(r=>JSON.parse(r.body));
 }
 /** Durable FIFO work selection, bounded in SQLite rather than a telemetry callback.
  * The exclusive application owner must fence previously attempted work before dispatch. */
 working(namespace: TaskNamespace, limit: number): Task[] {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid selection bound');
  return (this.db.prepare("SELECT body FROM agent_tasks WHERE json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=? AND json_extract(body,'$.status')='working' ORDER BY rowid LIMIT ?").all(namespace.workspaceId,namespace.accountId,limit) as {body:string}[]).map(row=>JSON.parse(row.body) as Task);
 }
 taskInNamespace(namespace: TaskNamespace,id:string): Task | undefined {
  const row=this.db.prepare("SELECT body FROM agent_tasks WHERE id=? AND json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=?").get(id,namespace.workspaceId,namespace.accountId) as {body:string}|undefined;
  return row?JSON.parse(row.body) as Task:undefined;
 }
 /** SQLite projects before returning data to Node: source/tool payloads never enter UI responses. */
 taskSummaries(namespace: TaskNamespace): TaskSummary[] {
  return (this.db.prepare("SELECT json_object('id',id,'requestedOutcome',substr(json_extract(body,'$.requestedOutcome'),1,160),'status',json_extract(body,'$.status')) AS view FROM agent_tasks WHERE json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=? ORDER BY rowid DESC LIMIT 100").all(namespace.workspaceId,namespace.accountId) as {view:string}[]).map(row=>JSON.parse(row.view) as TaskSummary);
 }
 /** Private saved-mail metadata only; raw observations/provider payloads stay in SQLite. */
 taskMailInNamespace(namespace:TaskNamespace,id:string):{mail?:Task['mail']}|undefined {
  const row=this.db.prepare("SELECT json_object('mail',json_extract(body,'$.mail')) AS view FROM agent_tasks WHERE id=? AND json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=?").get(id,namespace.workspaceId,namespace.accountId) as {view:string}|undefined;
  return row?JSON.parse(row.view) as {mail?:Task['mail']}:undefined;
 }
 taskView(namespace: TaskNamespace,id:string): TaskView | undefined {
  const fields=['id','requestedOutcome','status','checklist','nextAction','blocker','run','budget','generation','recovery','applicationRevision'];
  const projection=fields.map(field=>`'${field}',json_extract(body,'$.${field}')`).join(',');
  const row=this.db.prepare(`SELECT json_patch('{}',json_object(${projection})) AS view FROM agent_tasks WHERE id=? AND json_extract(body,'$.sourceEvent.workspaceId')=? AND json_extract(body,'$.sourceEvent.accountId')=?`).get(id,namespace.workspaceId,namespace.accountId) as {view:string}|undefined;
  return row?JSON.parse(row.view) as TaskView:undefined;
 }
 notifications(namespace: TaskNamespace): PreparationNotice[] {
  return (this.db.prepare('SELECT id,task_id,kind,revision FROM preparation_notices WHERE workspace_id=? AND account_id=? AND acknowledged=0 ORDER BY id LIMIT 100').all(namespace.workspaceId,namespace.accountId) as {id:number;task_id:string;kind:Task['status'];revision:number|null}[]).map(row=>({id:row.id,taskId:row.task_id,kind:row.kind,...(row.revision===null?{}:{revision:row.revision}),deepLink:`/?task=${encodeURIComponent(row.task_id)}${row.revision===null?'':`&revision=${row.revision}`}`}));
 }
 acknowledge(namespace: TaskNamespace,id:number): boolean {
  return this.db.prepare('UPDATE preparation_notices SET acknowledged=1 WHERE id=? AND workspace_id=? AND account_id=?').run(id,namespace.workspaceId,namespace.accountId).changes===1;
 }
 /** Exact durable admission identity; independent of the bounded UI history. */
 taskForEvent(event:Pick<SourceEvent,'workspaceId'|'accountId'|'messageId'>):Task|undefined {
  const row=this.db.prepare('SELECT body FROM agent_tasks WHERE event_key=?').get(JSON.stringify([event.workspaceId,event.accountId,event.messageId])) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 admit(event: SourceEvent, limit: number, observer?:(observation:AdmissionObservation)=>void): Task {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid budget');
  const key = JSON.stringify([event.workspaceId,event.accountId,event.messageId]);
  const task: Task = {id:randomUUID(),sourceEvent:event,requestedOutcome:event.outcome,status:'working',generation:0,run:{id:randomUUID(),attempt:0,cursor:0},checklist:{revision:0,reason:'Awaiting bounded inspection',items:[]},checklistHistory:[],observations:[],decisions:[],budget:{limit,used:0},recovery:'clean',nextAction:'Inspect request and permitted context'};
  const inserted = !!this.db.prepare('INSERT OR IGNORE INTO agent_tasks VALUES (?, ?, ?)').run(task.id,key,JSON.stringify(task)).changes;
  const result = JSON.parse((this.db.prepare('SELECT body FROM agent_tasks WHERE event_key=?').get(key) as {body:string}).body) as Task;
  // Post-commit wall-clock observation, not an exact SQLite commit timestamp.
  // Telemetry cannot turn a durable admission into a reported admission failure.
  const observedAt = Date.now();
  try { observer?.({task:structuredClone(result),disposition:inserted?'inserted':'existing',observedAt}); } catch { /* best-effort observer only */ }
  return result;
 }
 /** Preparation admission and its audit/initialization share the existing Task transaction.
  * The initializer must audit before writing a request artifact; no work is enqueued here. */
 admitPreparation(event:SourceEvent,limit:number,initialize:(task:Task)=>void):Task {
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const task=this.admit(event,limit);initialize(task);
   this.db.prepare('UPDATE agent_tasks SET body=? WHERE id=?').run(JSON.stringify(task),task.id);
   this.db.exec('COMMIT');return task;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 get(id: string): Task {
  const row = this.db.prepare('SELECT body FROM agent_tasks WHERE id=?').get(id) as {body:string}|undefined;
  if (!row) throw new Error('Unknown task'); return JSON.parse(row.body) as Task;
 }
 update(id: string, change: (task: Task)=>void): Task {
  this.db.exec('BEGIN IMMEDIATE');
  try { const task = this.get(id); change(task); this.db.prepare('UPDATE agent_tasks SET body=? WHERE id=?').run(JSON.stringify(task),id); this.db.exec('COMMIT'); return task; }
  catch(error) { this.db.exec('ROLLBACK'); throw error; }
 }
 cancel(id: string): void { this.update(id,t=>{t.generation++; t.status='cancelled'; t.nextAction='Cancelled by user';}); }
 /** Explicit recovery invalidates any old worker. Local write uncertainty requires reconciliation. */
 recover(id: string): Task { return this.update(id,t=>{
  t.generation++; t.run.attempt++;
  if (t.pending?.effect !== 'read' && t.pending) {t.recovery='reconciliation_required';if(t.status !== 'cancelled') t.status='blocked';t.blocker='Interrupted local write needs reconciliation';}
  else if(t.status !== 'cancelled' && t.recovery === 'clean') { delete t.pending; delete t.blocker; t.status='working'; t.nextAction='Resume from committed observations'; }
 }); }
}
