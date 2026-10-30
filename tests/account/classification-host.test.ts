// SIMULATION: real authenticated HTTP against startTrackingServer with a real
// TextProvider whose transport is scripted. No network, credential or paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startTrackingServer } from '../../core/tracking/server.js';
import { EncryptedStore } from '../../core/tracking/store.js';
import { PreviewSession } from '../../core/preview/session.js';
import { CallBudget, TextProvider, type ModelDeclaration } from '../../core/models/provider.js';
import type { ClassificationConfig, ClassificationState } from '../../core/account/classification-host.js';
import { recordKey, type Operation } from '../../core/tracking/types.js';

const model: ModelDeclaration = { provider: 'nebius', id: 'invented/classifier', text: true, jsonObject: true, inputContextTokens: 4096, maxOutputTokens: 256, pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.1, verifiedAt: '2026-10-01T00:00:00Z', source: 'https://example.com/invented-pricing' } };
const suggestion = { decision: 'suggest', categoryId: 'learning', activityId: 'reading', relatedIds: [], description: '  Reading cell biology notes ' };
function scripted(hold = false) {
  const calls: string[] = []; let entered!: () => void; const dispatched = new Promise<void>(resolve => { entered = resolve; });
  let created = 0, release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body)); entered();
    // Held until released; an abort first proves the commit fence cancelled dispatch.
    if (hold) await Promise.race([released, new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }))]);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(suggestion) } }], usage: { prompt_tokens: 40, completion_tokens: 12 } }));
  }) as unknown as typeof fetch;
  const config: ClassificationConfig = { model, createProvider: () => { created++; return new TextProvider(model, new CallBudget(1, 10), async () => 'invented-server-key', transport); } };
  return { config, calls, dispatched, release, created: () => created };
}
function observation(deviceId: string, wall: number, text = 'Invented permitted reading about invented cell biology notes'): Operation {
  const session = new PreviewSession(); session.start({ pixels: false, rich: false, retain: true });
  assert.equal(session.focus({ epoch: session.epoch, at: 0, revision: 1, key: 'invented/window', app: 'Reader', title: 'Invented study chapter', clock: 'source-boot-1' }), true);
  assert.equal(session.sample({ epoch: session.epoch, revision: 1, at: 0, text, textSource: 'native', status: 'native-text' }), true);
  session.pause(20000); const visit = session.visits[0]!;
  return { id: randomUUID(), deviceId, recordingId: 'recording', visitId: visit.id, record: { schema: 'spindle-tracking/v1', deviceId, recordingId: 'recording', visitId: visit.id, revision: 1, consentRevision: 1, policyRevision: 1, wallAnchor: wall, monotonicAnchor: 0, observedAt: 20000, expiresAt: Date.now() + 600000, labelRevision: 0, correctionRevision: 0, scopes: { recording: true, retention: true, upload: true, pixels: false }, activity: { awake: true, unlocked: true, inputAgeBucket: 'over-5m', heartbeatAt: 20000, coverage: 'observed' }, visit } };
}
interface Auth { cookie: string; csrf: string }
async function call(origin: string, path: string, body?: unknown, auth?: Auth, csrf = true) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Cookie: auth.cookie, ...(csrf ? { 'X-CSRF-Token': auth.csrf } : {}) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, any>, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function account(origin: string, name: string, register = true) {
  const r = await call(origin, register ? '/register' : '/signin', { name, password: 'invented-password-123' });
  assert.equal(r.status, 200); return { cookie: r.cookie, csrf: String(r.json.csrf) };
}
async function upload(origin: string, auth: Auth, wall: number, text?: string) {
  const device = await call(origin, '/devices', { name: 'Invented Mac' }, auth); assert.equal(device.status, 200);
  const op = observation(device.json.deviceId, wall, text);
  assert.equal((await call(origin, '/sync', { operations: [op] }, auth)).status, 200);
  return op;
}
const classify = (origin: string, auth: Auth, op: Operation, requestId = randomUUID(), mode = 'text', evidenceRevision = 1) => call(origin, '/classification/classify', { key: recordKey(op), evidenceRevision, requestId, mode }, auth);
const consent = (origin: string, auth: Auth, fields: string[] = ['appId', 'domain', 'title', 'text']) => call(origin, '/classification/consent', { enabled: true, fields }, auth);
const report = async (origin: string, auth: Auth, wall: number) => (await call(origin, `/sessions?from=${wall}&to=${wall + 30000}`, undefined, auth)).json;
async function persisted(dir: string, key: Buffer) {
  return new EncryptedStore<{ accounts: { labels?: { inferences?: Record<string, unknown>; corrections: Record<string, unknown> }; classification?: ClassificationState }[] }>(dir, key, () => ({ accounts: [] })).transaction(s => structuredClone(s.accounts), false);
}

test('authenticated consent on an owned current record dispatches once and /sessions reads the persisted model inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classification-host-')), key = randomBytes(32), script = scripted(), wall = Date.now() - 100000;
  let server = await startTrackingServer(join(dir, 'server'), key, 0, undefined, undefined, undefined, undefined, undefined, script.config);
  try {
    const origin = server.origin, auth = await account(origin, 'classify-owner'), op = await upload(origin, auth, wall);
    const config = await call(origin, '/classification/config', {}, auth);
    assert.deepEqual(config.json.model, { provider: 'nebius', id: 'invented/classifier', vision: false });
    assert.equal(config.json.consent, null); assert.equal(config.json.automatic, false);
    assert.equal((await call(origin, '/processing', { local: true }, auth)).status, 200);
    assert.equal((await consent(origin, auth)).json.consent.revision, 1);
    assert.equal(script.created(), 0, 'config/consent never create a provider');
    const result = await classify(origin, auth, op);
    assert.equal(result.status, 200); assert.equal(result.json.status, 'suggested'); assert.equal(result.json.model, 'invented/classifier');
    assert.equal(result.json.description, 'Reading cell biology notes'); assert.equal(result.json.label.description, 'Reading cell biology notes');
    assert.equal(script.calls.length, 1);
    const sent = JSON.parse(script.calls[0]!); assert.equal(sent.model, 'invented/classifier');
    assert.ok(!script.calls[0]!.includes('invented-server-key') && !JSON.stringify(result.json).includes('invented-server-key'));
    let visit = (await report(origin, auth, wall)).visits[0];
    assert.equal(visit.label.source, 'inference'); assert.deepEqual(visit.label.labels, { categoryId: 'learning', activityId: 'reading', relatedIds: [] });
    assert.equal(visit.label.inferenceSource.engine, 'nebius'); assert.equal(visit.label.remoteInference.model, 'invented/classifier');
    assert.equal(visit.label.description, 'Reading cell biology notes');
    // Inference is not correction history; a manual correction wins and undo restores the inference.
    const disk = await persisted(join(dir, 'server'), key);
    assert.deepEqual(disk[0]!.labels!.corrections, {}); assert.equal((disk[0]!.labels!.inferences![recordKey(op)] as { description?: string }).description, 'Reading cell biology notes');
    assert.equal((await call(origin, '/corrections', { key: recordKey(op), evidenceRevision: 1, expectedRevision: 0, labels: { categoryId: 'work', activityId: 'writing', relatedIds: [] } }, auth)).status, 200);
    // The user's own labels stand alone: no model description beside an override.
    assert.equal((await report(origin, auth, wall)).visits[0].label.source, 'override'); assert.equal((await report(origin, auth, wall)).visits[0].label.description, null);
    assert.equal((await call(origin, '/corrections', { key: recordKey(op), evidenceRevision: 1, expectedRevision: 1, undo: true }, auth)).status, 200);
    assert.equal((await report(origin, auth, wall)).visits[0].label.source, 'inference'); assert.equal((await report(origin, auth, wall)).visits[0].label.description, 'Reading cell biology notes');
    await server.close(); server = await startTrackingServer(join(dir, 'server'), key, Number(new URL(origin).port), undefined, undefined, undefined, undefined, undefined, script.config);
    const again = await account(origin, 'classify-owner', false);
    visit = (await report(origin, again, wall)).visits[0];
    assert.equal(visit.label.remoteInference.model, 'invented/classifier'); assert.equal(visit.label.description, 'Reading cell biology notes'); assert.equal(script.calls.length, 1);
    // Processing off revokes consent and discards inference.
    await call(origin, '/processing', { local: false }, again); await call(origin, '/processing', { local: true }, again);
    assert.equal((await call(origin, '/classification/config', {}, again)).json.consent, null);
    assert.notEqual((await report(origin, again, wall)).visits[0].label.source, 'inference');
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('foreign, stale, unconsented, field-denied and unauthenticated requests never create a provider or dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classification-deny-')), script = scripted(), wall = Date.now() - 100000;
  const server = await startTrackingServer(join(dir, 'server'), randomBytes(32), 0, undefined, undefined, undefined, undefined, undefined, script.config);
  const plain = await startTrackingServer(join(dir, 'plain'), randomBytes(32));
  try {
    const origin = server.origin, owner = await account(origin, 'deny-owner'), other = await account(origin, 'deny-other');
    const op = await upload(origin, owner, wall), short = await upload(origin, owner, wall, 'x');
    await call(origin, '/processing', { local: true }, owner);
    assert.equal((await classify(origin, owner, op)).json.code, 'REMOTE_DISABLED');
    await consent(origin, owner);
    await call(origin, '/processing', { local: true }, other); await consent(origin, other);
    assert.equal((await classify(origin, other, op)).status, 404, 'foreign record');
    assert.equal((await classify(origin, owner, op, randomUUID(), 'text', 2)).json.code, 'STALE_EVIDENCE');
    assert.equal((await classify(origin, owner, op, randomUUID(), 'image')).json.code, 'FIELDS_DENIED');
    assert.equal((await consent(origin, owner, ['image'])).json.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal((await call(origin, '/classification/classify', { key: recordKey(op), evidenceRevision: 1, requestId: randomUUID(), mode: 'text' }, owner, false)).json.code, 'CSRF_DENIED');
    assert.equal((await call(origin, '/classification/classify', { key: recordKey(op), evidenceRevision: 1, requestId: randomUUID(), mode: 'text', model: 'other', url: 'https://example.com' }, owner)).status, 400);
    assert.equal((await call(origin, '/classification/config', {})).status, 401);
    assert.equal(script.created(), 0);
    // Missing text is an honest abstention before dispatch; no URL guess.
    const insufficient = await classify(origin, owner, short);
    assert.equal(insufficient.json.status, 'insufficient-evidence'); assert.equal(script.calls.length, 0);
    const plainAuth = await account(plain.origin, 'plain-owner');
    assert.deepEqual((await call(plain.origin, '/classification/config', {}, plainAuth)).json, { configured: false });
    assert.equal((await call(plain.origin, '/classification/classify', { key: 'x', evidenceRevision: 1, requestId: randomUUID(), mode: 'text' }, plainAuth)).status, 503);
  } finally { await server.close(); await plain.close(); await rm(dir, { recursive: true, force: true }); }
});

test('signout, consent revocation and deletion while awaiting the provider cancel dispatch and never persist late', async () => {
  for (const action of ['logout', 'revoke', 'delete'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'classification-cancel-')), key = randomBytes(32), script = scripted(true), wall = Date.now() - 100000;
    const server = await startTrackingServer(join(dir, 'server'), key, 0, undefined, undefined, undefined, undefined, undefined, script.config);
    try {
      const origin = server.origin, auth = await account(origin, 'cancel-owner'), second = await account(origin, 'cancel-owner', false);
      const op = await upload(origin, auth, wall);
      await call(origin, '/processing', { local: true }, auth); await consent(origin, auth);
      const pending = classify(origin, auth, op);
      await script.dispatched;
      if (action === 'logout') assert.equal((await call(origin, '/logout', {}, auth)).status, 200);
      if (action === 'revoke') assert.equal((await call(origin, '/classification/consent', { enabled: false }, second)).status, 200);
      if (action === 'delete') assert.equal((await call(origin, '/sync', { operations: [{ id: randomUUID(), deviceId: op.deviceId, recordingId: op.recordingId, visitId: op.visitId, delete: true }] }, auth)).status, 200);
      script.release(); const result = await pending;
      assert.equal(result.json.status, 'TIMEOUT_OR_CANCELLED', action); assert.equal(script.calls.length, 1);
      const disk = await persisted(join(dir, 'server'), key);
      assert.deepEqual(disk[0]!.labels!.inferences ?? {}, {}, action);
      assert.equal(disk[0]!.classification!.requests[0]!.state, 'done');
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('request id replay returns the stored result and an interrupted dispatch reads back unknown, never another call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classification-replay-')), key = randomBytes(32), script = scripted(), wall = Date.now() - 100000;
  let server = await startTrackingServer(join(dir, 'server'), key, 0, undefined, undefined, undefined, undefined, undefined, script.config);
  try {
    const origin = server.origin, auth = await account(origin, 'replay-owner'), op = await upload(origin, auth, wall), id = randomUUID();
    await call(origin, '/processing', { local: true }, auth); await consent(origin, auth);
    const first = await classify(origin, auth, op, id);
    const replay = await classify(origin, auth, op, id);
    assert.equal(replay.json.status, 'suggested'); assert.deepEqual(replay.json.labels, first.json.labels); assert.equal(script.calls.length, 1);
    assert.equal((await call(origin, '/classification/status', { requestId: id }, auth)).json.status, 'suggested');
    assert.equal((await classify(origin, auth, op, id, 'text', 2)).json.code, 'REQUEST_ID_REUSED');
    // Simulated crash after durable admission: pending record with no live job.
    await server.close();
    const interrupted = randomUUID();
    await new EncryptedStore<{ accounts: { classification?: ClassificationState }[] }>(join(dir, 'server'), key, () => ({ accounts: [] })).transaction(s => {
      const c = s.accounts[0]!.classification!; c.requests.push({ ...c.requests[0]!, requestId: interrupted, state: 'pending', result: undefined });
    });
    server = await startTrackingServer(join(dir, 'server'), key, Number(new URL(origin).port), undefined, undefined, undefined, undefined, undefined, script.config);
    const again = await account(origin, 'replay-owner', false);
    assert.equal((await classify(origin, again, op, interrupted)).json.state, 'unknown');
    assert.equal((await call(origin, '/classification/status', { requestId: interrupted }, again)).json.state, 'unknown');
    assert.equal(script.calls.length, 1);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
