import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../../core/evidence/store.js';
import { MemoryStore } from '../../core/memory/store.js';
import { ScopedFilesystem } from '../../core/connectors/filesystem.js';
test('disk snapshots preserve versions, namespace and corrected memory after restart', () => {
 const dir = mkdtempSync(join(tmpdir(), 'spindle-context-')); const ns = {workspaceId:'w',accountId:'a'};
 try {
  const root = join(dir,'input'); mkdirSync(root); writeFileSync(join(root,'statement'),'00123');
  let store = new EvidenceStore(join(dir,'state')); const files = new ScopedFilesystem(store, { selected: root });
  const first = files.read(ns,'selected','statement'); writeFileSync(join(root,'statement'),'00456');
  const second = files.read(ns,'selected','statement'); assert.notEqual(first.source!.id, second.source!.id);
  const output = files.write(ns, Buffer.from('prepared'), 'text/plain', [first.source!.id]);
  assert.equal(first.artifact.sha256, store.source(ns,first.source!.id).sha256);
  const memory = new MemoryStore(store);
  memory.record(ns,{key:'account',kind:'fact',value:'00123',sourceIds:[first.source!.id],userCorrected:false});
  memory.record(ns,{key:'account',kind:'fact',value:'00999',sourceIds:[],userCorrected:true});
  memory.record(ns,{key:'account',kind:'fact',value:'00456',sourceIds:[second.source!.id],userCorrected:false});
  writeFileSync(join(dir,'outside'),'not permitted'); symlinkSync(join(dir,'outside'),join(root,'escape'));
  assert.throws(() => files.read(ns,'selected','escape'), /outside/);
  assert.throws(() => files.read(ns,'selected','../outside'), /outside/);
  assert.equal(readOriginal(), '00456');
  function readOriginal() { return files.read(ns,'selected','statement').source && store.read(ns,second.artifact.id).toString(); }
  store.close(); store = new EvidenceStore(join(dir,'state'));
  assert.equal(store.read(ns,first.artifact.id).toString(),'00123');
  assert.equal(store.read(ns,output.id).toString(),'prepared');
  assert.throws(() => store.read({...ns,accountId:'other'},first.artifact.id), /namespace/);
  const reopened = new MemoryStore(store); assert.equal(reopened.search(ns,'00999')[0].value,'00999'); assert.equal(reopened.history(ns,'account').length,3);
  assert.equal(reopened.search({...ns,workspaceId:'other'},'').length,0);
  writeFileSync(join(dir,'state','artifacts',first.artifact.id),'tampered'); assert.throws(() => store.read(ns,first.artifact.id), /integrity/);
  writeFileSync(join(dir,'state','artifacts','00000000-0000-0000-0000-000000000000.tmp'),'orphan');
  assert.equal(store.recoverOrphans(1),1); store.close();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
