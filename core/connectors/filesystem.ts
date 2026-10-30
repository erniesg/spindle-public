import { openSync, closeSync, readFileSync, realpathSync, fstatSync, constants } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvidenceStore, digest, type Namespace } from '../evidence/store.js';
/** Roots are selected by the application, never supplied as model authority. Outputs live only in the evidence store. */
export class ScopedFilesystem {
 private readonly roots: Map<string, string>;
 constructor(private readonly store: EvidenceStore, roots: Record<string, string>) {
  this.roots = new Map(Object.entries(roots).map(([id, root]) => [id, realpathSync(root)]));
 }
 read(ns: Namespace, rootId: string, path: string, mimeType = 'application/octet-stream') {
  const root = this.roots.get(rootId); if (!root) throw new Error('Root not selected');
  const target = realpathSync(resolve(root, path)); const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Path outside selected root');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
   // Verify the opened handle on Linux as well as the resolved path, closing symlink-swap races.
   if (process.platform === 'linux' && realpathSync(`/proc/self/fd/${fd}`) !== target) throw new Error('Source changed during open');
   const before = fstatSync(fd); if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error('Unsupported source size/type');
   const bytes = readFileSync(fd); const after = fstatSync(fd);
   if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during read');
   return this.store.put(ns, bytes, mimeType, [], { provider: 'filesystem', providerId: target, providerVersion: digest(bytes), originalUrl: pathToFileURL(target).href });
  } finally { closeSync(fd); }
 }
 write(ns: Namespace, bytes: Uint8Array, mimeType: string, derivedFrom: string[]) { return this.store.put(ns, bytes, mimeType, derivedFrom).artifact; }
}
