import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, readFileSync, fstatSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, SourceRef } from './types.js';
export interface Namespace { workspaceId: string; accountId: string }
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Dedicated agent evidence store; credentials and capture data do not belong here. */
export class EvidenceStore {
 readonly db: DatabaseSync;
 private readonly directory: string;
 constructor(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  this.directory = join(root, 'artifacts'); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  this.db = new DatabaseSync(join(root, 'context.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, workspace TEXT, account TEXT, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, workspace TEXT, account TEXT, body TEXT NOT NULL);`);
 }
 close(): void { this.db.close(); }
 artifact(ns: Namespace, id: string): ArtifactRef {
  const row = this.db.prepare('SELECT body FROM artifacts WHERE id=? AND workspace=? AND account=?').get(id, ns.workspaceId, ns.accountId);
  if (!row) throw new Error('Artifact unavailable in this namespace');
  return JSON.parse(row.body as string) as ArtifactRef;
 }
 read(ns: Namespace, id: string, maxBytes = 32 * 1024 * 1024): Buffer {
  const artifact = this.artifact(ns, id);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > maxBytes) throw new Error('Snapshot exceeds read bound');
  const fd = openSync(join(this.directory, artifact.id), 'r');
  let bytes: Buffer;
  try {
   if (fstatSync(fd).size !== artifact.bytes) throw new Error('Snapshot integrity failure: size mismatch');
   bytes = Buffer.alloc(artifact.bytes);
   let offset = 0;
   while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length-offset, offset); if (!n) throw new Error('Truncated snapshot'); offset += n; }
   if (fstatSync(fd).size !== artifact.bytes) throw new Error('Snapshot integrity failure: size changed');
  } finally { closeSync(fd); }
  if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new Error('Snapshot integrity failure');
  return bytes;
 }
 source(ns: Namespace, id: string): SourceRef {
  const row = this.db.prepare('SELECT body FROM sources WHERE id=? AND workspace=? AND account=?').get(id, ns.workspaceId, ns.accountId);
  if (!row) throw new Error('Source unavailable in this namespace');
  return JSON.parse(row.body as string) as SourceRef;
 }
 /** Bytes reach stable storage before metadata commit. A crash can leave only an unreferenced orphan. */
 put(ns: Namespace, bytes: Uint8Array, mimeType: string, derivedFrom: string[] = [], source?: Omit<SourceRef, 'id'|'sha256'|'snapshotArtifactId'|'retrievedAt'|'mimeType'>): { artifact: ArtifactRef; source?: SourceRef } {
  if (bytes.length > 32 * 1024 * 1024 || !mimeType || mimeType.length > 256 || derivedFrom.length > 100 || derivedFrom.some(id => typeof id !== 'string' || id.length > 8192)) throw new Error('Invalid artifact metadata/size');
  for (const id of derivedFrom) {
   try { this.artifact(ns, id); } catch { this.source(ns, id); }
  }
  const id = randomUUID(); const temporary = join(this.directory, `${id}.tmp`); const final = join(this.directory, id);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, final);
  // Windows does not expose portable directory fsync through Node. File contents
  // are flushed there, but power-loss directory durability is not promised.
  if (process.platform !== 'win32') {
   const directoryFd = openSync(this.directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  const artifact: ArtifactRef = { id, mimeType, sha256: digest(bytes), bytes: bytes.length, relativePath: `artifacts/${id}`, createdAt: new Date().toISOString(), derivedFrom: [...derivedFrom], version: 1 };
  const snapshot: SourceRef | undefined = source && { ...source, accountId: ns.accountId, id: randomUUID(), mimeType, sha256: artifact.sha256, snapshotArtifactId: id, retrievedAt: artifact.createdAt };
  this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run(id, ns.workspaceId, ns.accountId, JSON.stringify(artifact));
   if (snapshot) this.db.prepare('INSERT INTO sources VALUES (?,?,?,?)').run(snapshot.id, ns.workspaceId, ns.accountId, JSON.stringify(snapshot));
   this.db.exec('COMMIT');
  } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  return { artifact, source: snapshot };
 }
 /** Invoke only with exclusive store ownership, after all writers have closed. Bounded deletion. */
 recoverOrphans(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new Error('Invalid recovery limit');
  let removed = 0;
  for (const file of readdirSync(this.directory)) {
   if (removed >= limit) break;
   if (!/^[a-f0-9-]{36}(\.tmp)?$/.test(file)) continue;
   if (!this.db.prepare('SELECT id FROM artifacts WHERE id=?').get(file)) { unlinkSync(join(this.directory, file)); removed++; }
  }
  return removed;
 }
}
