import type { DatabaseSync } from 'node:sqlite';
import type { Namespace } from '../evidence/store.js';
import type { AgentEnvelope } from './agent-provider.js';

export interface AgentOperationEnvelope {
 id:string;workspaceId:string;accountId:string;taskId:string;runId:string;revision:number;kind:'vision';model:string;configDigest:string;
 inputArtifactId:string;inputHash:string;sourceIds:string[];status:'attempt'|'completed'|'failed';
 usage:{inputTokens:number;outputTokens:number}|null;promptDigest?:string;errorCode?:string;
}

/** Uses the application EvidenceStore connection; never stores credentials or raw provider reasoning.
 * A reservation is unique within the explicitly selected cumulative budget journal.
 * Envelopes retain separate attempts at the same run cursor instead of overwriting them.
 */
export class AgentSessionStore {
 constructor(private readonly db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_model_envelopes (
   workspace TEXT NOT NULL, account TEXT NOT NULL, task TEXT NOT NULL,
   run TEXT NOT NULL, cursor INTEGER NOT NULL, reservation INTEGER NOT NULL,
   body TEXT NOT NULL, PRIMARY KEY(workspace,account,task,run,cursor,reservation));
   CREATE TABLE IF NOT EXISTS agent_operation_envelopes (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, account TEXT NOT NULL, task TEXT NOT NULL, body TEXT NOT NULL);`);
 }
 /** Arrow binding is intentional: pass directly as AgentProviderOptions.persist. */
 readonly persist = async (envelope: AgentEnvelope): Promise<void> => {
  const e = structuredClone(envelope);
  if (![e.workspaceId,e.accountId,e.taskId,e.runId,e.model,e.configDigest].every(v=>typeof v==='string' && v.length>0) || !Number.isSafeInteger(e.cursor) || e.cursor<0 || !Number.isSafeInteger(e.reservation) || e.reservation<1) throw new Error('Invalid model envelope identity');
  const body=JSON.stringify(e);
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const previous=this.db.prepare('SELECT body FROM agent_model_envelopes WHERE workspace=? AND account=? AND task=? AND run=? AND cursor=? AND reservation=?').get(e.workspaceId,e.accountId,e.taskId,e.runId,e.cursor,e.reservation);
   if (previous) {
    const old=JSON.parse(previous.body as string) as AgentEnvelope;
    const {response:oldResponse,...oldRequest}=old;const {response,...request}=e;
    if (JSON.stringify(oldRequest)!==JSON.stringify(request) || (oldResponse && JSON.stringify(oldResponse)!==JSON.stringify(response))) throw new Error('Model envelope is immutable');
   }
   this.db.prepare('INSERT INTO agent_model_envelopes VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace,account,task,run,cursor,reservation) DO UPDATE SET body=excluded.body').run(e.workspaceId,e.accountId,e.taskId,e.runId,e.cursor,e.reservation,body);
   this.db.exec('COMMIT');
  } catch(error) { this.db.exec('ROLLBACK');throw error; }
 };
 /** Explicit allowlisted operation metadata only; no image blobs, prompts, raw configuration or credentials. */
 async persistOperation(value:AgentOperationEnvelope):Promise<void>{
  const e=structuredClone(value);
  if(![e.id,e.workspaceId,e.accountId,e.taskId,e.runId,e.model,e.inputArtifactId].every(v=>typeof v==='string'&&v.length>0)||!Number.isSafeInteger(e.revision)||e.revision<1||! /^[a-f0-9]{64}$/.test(e.configDigest)||! /^[a-f0-9]{64}$/.test(e.inputHash)||e.kind!=='vision'||!['attempt','completed','failed'].includes(e.status)||!Array.isArray(e.sourceIds)||e.sourceIds.some(s=>typeof s!=='string')||e.usage!==null&&(!Number.isSafeInteger(e.usage.inputTokens)||!Number.isSafeInteger(e.usage.outputTokens)||e.usage.inputTokens<0||e.usage.outputTokens<0)||e.promptDigest!==undefined&&!/^[a-f0-9]{64}$/.test(e.promptDigest)||e.errorCode!==undefined&&!/^[A-Z_0-9]{1,128}$/.test(e.errorCode))throw Error('Invalid model operation metadata');
  const old=this.db.prepare('SELECT body FROM agent_operation_envelopes WHERE id=?').get(e.id);
  if(old){const previous=JSON.parse(old.body as string) as AgentOperationEnvelope;const identity=(v:AgentOperationEnvelope)=>JSON.stringify([v.id,v.workspaceId,v.accountId,v.taskId,v.runId,v.revision,v.model,v.configDigest,v.inputArtifactId,v.inputHash,v.sourceIds]);if(identity(previous)!==identity(e)||previous.status!=='attempt'&&JSON.stringify(previous)!==JSON.stringify(e))throw Error('Model operation metadata immutable');}
  // Explicit projection: untyped callers cannot persist extra hidden/secret fields.
  const body={id:e.id,workspaceId:e.workspaceId,accountId:e.accountId,taskId:e.taskId,runId:e.runId,revision:e.revision,kind:e.kind,model:e.model,configDigest:e.configDigest,inputArtifactId:e.inputArtifactId,inputHash:e.inputHash,sourceIds:e.sourceIds,status:e.status,usage:e.usage&&{inputTokens:e.usage.inputTokens,outputTokens:e.usage.outputTokens},...(e.promptDigest?{promptDigest:e.promptDigest}:{}),...(e.errorCode?{errorCode:e.errorCode}:{})};
  this.db.prepare('INSERT INTO agent_operation_envelopes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(e.id,e.workspaceId,e.accountId,e.taskId,JSON.stringify(body));
 }
 operations(ns:Namespace,taskId:string):AgentOperationEnvelope[]{return this.db.prepare('SELECT body FROM agent_operation_envelopes WHERE workspace=? AND account=? AND task=? ORDER BY rowid').all(ns.workspaceId,ns.accountId,taskId).map(r=>JSON.parse(r.body as string) as AgentOperationEnvelope);}
 list(ns: Namespace, taskId: string): AgentEnvelope[] {
  return this.db.prepare('SELECT body FROM agent_model_envelopes WHERE workspace=? AND account=? AND task=? ORDER BY rowid').all(ns.workspaceId,ns.accountId,taskId).map(row=>JSON.parse(row.body as string) as AgentEnvelope);
 }
}
