import { randomUUID } from 'node:crypto';
import type { EvidenceStore, Namespace } from '../evidence/store.js';
export interface MemoryRecord { id: string; key: string; kind: 'fact'|'preference'|'goal'; value: string; sourceIds: string[]; userCorrected: boolean; createdAt: string; version: number }
export class MemoryStore {
 constructor(private readonly evidence: EvidenceStore) {
  evidence.db.exec('CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, workspace TEXT, account TEXT, key TEXT, version INTEGER, body TEXT, UNIQUE(workspace,account,key,version))');
 }
 /** Latest 100 revisions, oldest first; beforeVersion pages older history. */
 history(ns: Namespace, key: string, beforeVersion = Number.MAX_SAFE_INTEGER): MemoryRecord[] {
  if (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1) throw new Error('Invalid history cursor');
  return this.evidence.db.prepare('SELECT body FROM memories WHERE workspace=? AND account=? AND key=? AND version<? ORDER BY version DESC LIMIT 100').all(ns.workspaceId, ns.accountId, key, beforeVersion).reverse().map(row => JSON.parse(row.body as string) as MemoryRecord);
 }
 read(ns: Namespace, key: string): MemoryRecord | undefined {
  const row = this.evidence.db.prepare("SELECT body FROM memories WHERE workspace=? AND account=? AND key=? ORDER BY json_extract(body,'$.userCorrected') DESC, version DESC LIMIT 1").get(ns.workspaceId, ns.accountId, key);
  return row ? JSON.parse(row.body as string) as MemoryRecord : undefined;
 }
 private current = `WITH ranked AS (SELECT key, body, ROW_NUMBER() OVER (PARTITION BY key ORDER BY json_extract(body,'$.userCorrected') DESC, version DESC) AS rank FROM memories WHERE workspace=? AND account=?)`;
 /** Stable key-order pagination of effective context, not superseded model revisions. */
 list(ns: Namespace, afterKey = ''): MemoryRecord[] {
  if (afterKey.length > 8192) throw new Error('Invalid list cursor');
  return this.evidence.db.prepare(`${this.current} SELECT body FROM ranked WHERE rank=1 AND key>? ORDER BY key COLLATE BINARY LIMIT 50`).all(ns.workspaceId, ns.accountId, afterKey).map(row => JSON.parse(row.body as string) as MemoryRecord);
 }
 record(ns: Namespace, input: Omit<MemoryRecord, 'id'|'version'|'createdAt'>): MemoryRecord {
  if (typeof input.key !== 'string' || typeof input.value !== 'string' || !input.value.trim() || input.key.length > 8192 || input.value.length > 8192 || typeof input.userCorrected !== 'boolean' || !Array.isArray(input.sourceIds) || input.sourceIds.length > 100 || input.sourceIds.some(id => typeof id !== 'string' || !id || id.length > 8192) || !['fact','preference','goal'].includes(input.kind)) throw new Error('Invalid memory metadata');
  for (const id of input.sourceIds) this.evidence.source(ns, id);
  if (!input.key.trim() || (!input.userCorrected && !input.sourceIds.length)) throw new Error('Memory needs key and provenance');
  const db = this.evidence.db; db.exec('BEGIN IMMEDIATE');
  try {
   const last = db.prepare('SELECT MAX(version) AS version FROM memories WHERE workspace=? AND account=? AND key=?').get(ns.workspaceId, ns.accountId, input.key)!;
   const record = { ...input, id: randomUUID(), version: Number(last.version ?? 0) + 1, createdAt: new Date().toISOString() };
   db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)').run(record.id, ns.workspaceId, ns.accountId, record.key, record.version, JSON.stringify(record));
   db.exec('COMMIT'); return record;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 }
 search(ns: Namespace, text: string): MemoryRecord[] {
  if (typeof text !== 'string' || text.length > 512) throw new Error('Query exceeds 512 characters');
  const words = text.replace(/[A-Z]/g, letter => letter.toLowerCase()).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 16 || words.some(word => word.length > 64)) throw new Error('Query exceeds token bound');
  const tokens = [...new Set(words)];
  if (!tokens.length) return [];
  // Literal lexical substrings, OR recall ranked by distinct tokens matched. No LIKE wildcards.
  const score = tokens.map(() => "(instr(lower(key || ' ' || json_extract(body,'$.value')), ?) > 0)").join(' + ');
  return this.evidence.db.prepare(`${this.current} SELECT body, (${score}) AS score FROM ranked WHERE rank=1 AND score>0 ORDER BY score DESC, key COLLATE BINARY LIMIT 20`).all(ns.workspaceId, ns.accountId, ...tokens).map(row => JSON.parse(row.body as string) as MemoryRecord);
 }
}
