import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { createOcrTool } from '../../core/tools/ocr.js';

for (const mode of ['cancel', 'timeout'] as const) {
 test(`pending local HTTP OCR ${mode} leaves no artifact or late mutation`, { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocr-inflight-'));
  const evidence = new EvidenceStore(root), state = new AgentStore(':memory:');
  const ns = { workspaceId: 'w', accountId: 'a' };
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=', 'base64');
  const source = evidence.put(ns, bytes, 'image/png', [], { provider: 'user' }).source!;
  let started!: () => void, settled!: () => void;
  const requestStarted = new Promise<void>(r => { started = r; });
  const invocationSettled = new Promise<void>(r => { settled = r; });
  // Headers and a finite partial body exercise abort while reading an actual response.
  const server = createServer((req, res) => {
   req.resume(); res.writeHead(200, { 'content-type': 'application/json' });
   res.write('{"model":"local-test",'); started();
  });
  try {
   await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
   const task = state.admit({ ...ns, messageId: mode, outcome: 'Read invented source' }, 12);
   const before = Number(evidence.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
   const tool = createOcrTool({ store: evidence, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/ocr`, allowLoopback: true, authorize: () => true, timeoutMs: mode === 'timeout' ? 30 : 2000 });
   const invoke = tool.invoke;
   tool.invoke = async (args, ctx) => { try { return await invoke(args, ctx); } finally { settled(); } };
   const runtime = new AgentRuntime(state, [tool, {
    name: 'source.read', version: '1', effect: 'read', capabilities: [],
    inputSchema: { jsonSchema: { type: 'object' }, parse: v => v },
    outputSchema: { jsonSchema: { type: 'number' }, parse: v => v },
    async invoke(_args, ctx) {
     assert.deepEqual(evidence.read(ns, source.snapshotArtifactId), bytes);
     return { callId: ctx.callId, status: 'ok', data: bytes.length, artifacts: [], evidence: [], observations: ['Original bytes remain readable'] };
    }
   }]);
   const running = runtime.run(task.id, { id: 'local-script-not-model', async next(t) {
    if (!t.observations.length) return { kind: 'tool', name: tool.name, args: { sourceId: source.id } };
    assert.equal(mode, 'timeout');
    assert.equal(t.observations[0].status, 'failed');
    assert.equal(t.observations[0].error?.code, 'ocr_unavailable');
    assert.deepEqual(t.observations[0].artifacts, []);
    assert.equal(t.pending, undefined); assert.equal(t.recovery, 'clean');
    if (t.observations.length === 1) return { kind: 'tool', name: 'source.read', args: {} };
    assert.equal(t.observations[1].data, bytes.length);
    return { kind: 'ready', result: 'Independent stored read completed' };
   } }, 3, { scope: { sources: [source], destinations: [], grants: ['image.processing'] } });
   await requestStarted;
   assert.equal(state.get(task.id).pending?.tool, tool.name);
   if (mode === 'cancel') runtime.cancel(task.id);
   await running;
   const snapshot = state.get(task.id);
   assert.equal(snapshot.status, mode === 'cancel' ? 'cancelled' : 'ready');
   assert.equal(snapshot.observations.length, mode === 'cancel' ? 0 : 2);
   // Runtime cancellation can return before invoke settles; check both boundaries.
   await invocationSettled;
   await new Promise<void>(r => setImmediate(r));
   assert.deepEqual(state.get(task.id), snapshot);
   assert.equal(Number(evidence.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n), before);
  } finally {
   server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
   state.close(); evidence.close(); rmSync(root, { recursive: true, force: true });
  }
 });
}
