// SIMULATION: real loopback HTTP against startTrackingServer with invented accounts,
// a fixture-only proxy token and a scripted model transport. No network or paid call;
// the real edge (Worker) identity integration is not exercised here.
import { request } from 'node:http';
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
import type { WorkOSConfig } from '../../core/account/workos-provider.js';
import { recordKey, type Operation } from '../../core/tracking/types.js';

const publicOrigin = 'https://spindle.invented.example', host = new URL(publicOrigin).host;
const proxyToken = 'a'.repeat(64), clientA = 'b'.repeat(64), clientB = 'c'.repeat(64);
const workos: WorkOSConfig = { clientId: 'client_invented', issuer: 'https://api.workos.com/user_management/client_invented', jwksUri: 'https://api.workos.com/sso/jwks/client_invented', webRedirectUri: publicOrigin + '/auth/workos/callback' };
// Node fetch rewrites Host; the trusted edge reaches the loopback listener over plain HTTP.
const raw = (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) => new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
  const r = request(url, options, response => { const chunks: Buffer[] = []; response.on('data', c => chunks.push(c)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); let data = {}; try { data = JSON.parse(text); } catch { /* redirects have no JSON body */ } resolve({ status: response.statusCode!, data }); }); response.on('error', reject); });
  r.on('error', reject); r.end(options.body);
});
const edge = (client?: string, token = proxyToken) => ({ Host: host, ...(token ? { 'X-Spindle-Proxy-Token': token } : {}), ...(client ? { 'X-Spindle-Client': client } : {}) });
const auth = (listen: string, path: string, headers: Record<string, string>, name = 'x', password = 'short') => raw(listen + path, { method: 'POST', headers: { ...headers, Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
const begin = (listen: string, headers: Record<string, string>) => raw(listen + '/auth/workos/begin', { headers: { ...headers, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });

test('public proxy config is valid only with an HTTPS public origin and an exact 64-hex token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-abuse-config-'));
  try {
    await assert.rejects(startTrackingServer(join(dir, 'a'), randomBytes(32), 0, undefined, undefined, undefined, undefined, undefined, undefined, { token: proxyToken }), /PUBLIC_PROXY_REQUIRES_PUBLIC_ORIGIN/);
    for (const bad of [{ token: 'A'.repeat(64) }, { token: 'a'.repeat(63) }, { token: proxyToken, extra: 1 }, {}] as never[])
      await assert.rejects(startTrackingServer(join(dir, 'b'), randomBytes(32), 0, publicOrigin, undefined, undefined, undefined, undefined, undefined, bad), /PUBLIC_PROXY_CONFIG_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing, wrong or spoofed proxy identity is denied; one client cannot exhaust another client; begin is per-client throttled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-abuse-proxy-'));
  const server = await startTrackingServer(dir, randomBytes(32), 0, publicOrigin, undefined, undefined, undefined, workos, undefined, { token: proxyToken });
  const listen = server.listenOrigin;
  try {
    // Every public route, including the portal and the WorkOS callback, requires the edge token and tag.
    for (const headers of [{ Host: host }, edge(clientA, 'd'.repeat(64)), edge(undefined), edge('B'.repeat(64)), { ...edge(clientA), 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9', 'X-Spindle-Proxy-Token': 'd'.repeat(64) }])
      for (const path of ['/portal', '/auth/workos/config', '/auth/workos/callback?state=x&code=y'])
        assert.equal((await raw(listen + path, { headers })).status, 403, path);
    assert.equal((await auth(listen, '/register', { Host: host })).data.code, 'PROXY_DENIED');
    // Exact Host is still required behind a valid edge.
    assert.equal((await raw(listen + '/portal', { headers: { ...edge(clientA), Host: 'other.invented.example' } })).status, 403);
    // F1: client A spends its 20/min auth window (cheap invalid bodies); CF-/X-Forwarded headers do not re-key it.
    for (let i = 0; i < 20; i++) assert.equal((await auth(listen, '/signin', { ...edge(clientA), 'X-Forwarded-For': `198.51.100.${i}` })).status, 400);
    assert.equal((await auth(listen, '/signin', { ...edge(clientA), 'CF-Connecting-IP': '198.51.100.200' })).data.code, 'AUTH_BUSY');
    assert.equal((await auth(listen, '/register', edge(clientA), 'public-a-new', 'invented-password-123')).data.code, 'AUTH_BUSY');
    const signup = await auth(listen, '/register', edge(clientB), 'public-b-new', 'invented-password-123');
    assert.equal(signup.status, 200, 'distinct client signup remains available');
    // F8: WorkOS-derived names are reserved for direct registration.
    assert.equal((await auth(listen, '/register', edge(clientB), 'workos.' + '0'.repeat(32), 'invented-password-123')).data.code, 'ACCOUNT_NAME_RESERVED');
    // F2: browser begin is limited to 4 per client per 5 minutes, before the shared 64-entry table.
    for (let i = 0; i < 4; i++) assert.equal((await begin(listen, edge(clientA))).status, 303);
    assert.equal((await begin(listen, edge(clientA))).status, 429);
    assert.equal((await begin(listen, edge(clientB))).status, 303, 'distinct client can still begin sign-in');
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy configuration without proxy keeps the unchanged global auth window and ignores proxy headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-abuse-legacy-'));
  const server = await startTrackingServer(dir, randomBytes(32), 0, publicOrigin);
  const listen = server.listenOrigin;
  try {
    for (let i = 0; i < 20; i++) assert.equal((await auth(listen, '/signin', edge(clientA))).status, 400);
    // Without the explicit contract, tags are not identity: everybody shares one window (the reviewed F1 behaviour).
    assert.equal((await auth(listen, '/register', edge(clientB), 'legacy-b-new', 'invented-password-123')).data.code, 'AUTH_BUSY');
    assert.equal((await auth(listen, '/register', { Host: host }, 'legacy-c-new', 'invented-password-123')).data.code, 'AUTH_BUSY');
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

// --- F3: hosted classification per-account admission quota (scripted provider) ---
const model: ModelDeclaration = { provider: 'nebius', id: 'invented/classifier', text: true, jsonObject: true, inputContextTokens: 4096, maxOutputTokens: 256, pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.1, verifiedAt: '2026-10-01T00:00:00Z', source: 'https://example.com/invented-pricing' } };
function scripted(quota?: ClassificationConfig['quota']) {
  const calls: string[] = [];
  const transport = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ decision: 'suggest', categoryId: 'learning', activityId: 'reading', relatedIds: [] }) } }], usage: { prompt_tokens: 40, completion_tokens: 12 } }));
  }) as unknown as typeof fetch;
  const config: ClassificationConfig = { model, ...(quota ? { quota } : {}), createProvider: () => new TextProvider(model, new CallBudget(1, 10), async () => 'invented-server-key', transport) };
  return { config, calls };
}
interface Auth { cookie: string; csrf: string }
async function call(origin: string, path: string, body?: unknown, a?: Auth) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(a ? { Cookie: a.cookie, 'X-CSRF-Token': a.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, any>, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function owner(origin: string, name: string, register = true): Promise<Auth> {
  const r = await call(origin, register ? '/register' : '/signin', { name, password: 'invented-password-123' }); assert.equal(r.status, 200); return { cookie: r.cookie, csrf: String(r.json.csrf) };
}
async function ready(origin: string, a: Auth) {
  const device = await call(origin, '/devices', { name: 'Invented Mac' }, a);
  const session = new PreviewSession(); session.start({ pixels: false, rich: false, retain: true });
  session.focus({ epoch: session.epoch, at: 0, revision: 1, key: 'invented/window', app: 'Reader', title: 'Invented study chapter', clock: 'source-boot-1' });
  session.sample({ epoch: session.epoch, revision: 1, at: 0, text: 'Invented permitted reading about invented cell biology notes', textSource: 'native', status: 'native-text' });
  session.pause(20000); const visit = session.visits[0]!, deviceId = device.json.deviceId;
  const op: Operation = { id: randomUUID(), deviceId, recordingId: 'recording', visitId: visit.id, record: { schema: 'spindle-tracking/v1', deviceId, recordingId: 'recording', visitId: visit.id, revision: 1, consentRevision: 1, policyRevision: 1, wallAnchor: Date.now() - 100000, monotonicAnchor: 0, observedAt: 20000, expiresAt: Date.now() + 600000, labelRevision: 0, correctionRevision: 0, scopes: { recording: true, retention: true, upload: true, pixels: false }, activity: { awake: true, unlocked: true, inputAgeBucket: 'over-5m', heartbeatAt: 20000, coverage: 'observed' }, visit } };
  assert.equal((await call(origin, '/sync', { operations: [op] }, a)).status, 200);
  await call(origin, '/processing', { local: true }, a);
  assert.equal((await call(origin, '/classification/consent', { enabled: true, fields: ['appId', 'domain', 'title', 'text'] }, a)).status, 200);
  return op;
}
const classify = (origin: string, a: Auth, op: Operation, requestId = randomUUID()) => call(origin, '/classification/classify', { key: recordKey(op), evidenceRevision: 1, requestId, mode: 'text' }, a);
const editState = (dir: string, key: Buffer, fn: (c: ClassificationState) => void) => new EncryptedStore<{ accounts: { classification?: ClassificationState }[] }>(dir, key, () => ({ accounts: [] })).transaction(s => fn(s.accounts[0]!.classification!));

test('a 40-request loop from one account is admitted at the default 2/minute; replay never consumes or redispatches; another account is unaffected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-abuse-quota-')), script = scripted();
  const server = await startTrackingServer(dir, randomBytes(32), 0, undefined, undefined, undefined, undefined, undefined, script.config);
  try {
    const origin = server.origin, a = await owner(origin, 'quota-owner'), op = await ready(origin, a), first = randomUUID();
    assert.deepEqual((await call(origin, '/classification/config', {}, a)).json.quota, { perMinute: 2, perDay: 12, usedMinute: 0, usedDay: 0, clockTrusted: true });
    assert.equal((await classify(origin, a, op, first)).json.status, 'suggested');
    const codes: string[] = [];
    for (let i = 0; i < 39; i++) { const r = await classify(origin, a, op); codes.push(r.status === 200 ? r.json.status : r.json.code); }
    assert.equal(script.calls.length, 2, '40 new request ids -> 2 provider calls');
    assert.equal(codes.filter(c => c === 'CLASSIFICATION_QUOTA').length, 38);
    const replay = await classify(origin, a, op, first);
    assert.equal(replay.status, 200); assert.equal(replay.json.status, 'suggested'); assert.equal(script.calls.length, 2, 'replay is not another call');
    assert.deepEqual((await call(origin, '/classification/config', {}, a)).json.quota, { perMinute: 2, perDay: 12, usedMinute: 2, usedDay: 2, clockTrusted: true });
    const b = await owner(origin, 'quota-other'), opB = await ready(origin, b);
    assert.equal((await classify(origin, b, opB)).json.status, 'suggested'); assert.equal(script.calls.length, 3);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('admissions are durable, never refunded for unknown work, enforce the daily window and fail closed on clock rollback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-abuse-durable-')), key = randomBytes(32), script = scripted({ perMinute: 3, perDay: 3 });
  let server = await startTrackingServer(join(dir, 's'), key, 0, undefined, undefined, undefined, undefined, undefined, script.config);
  try {
    const origin = server.origin, port = Number(new URL(origin).port);
    let a = await owner(origin, 'durable-owner'); const op = await ready(origin, a);
    assert.equal((await classify(origin, a, op)).json.status, 'suggested');
    // Simulated crash after admission: an unknown pending request keeps its admission; restart keeps the count.
    await server.close();
    await editState(join(dir, 's'), key, c => { c.requests.push({ ...c.requests[0]!, requestId: randomUUID(), state: 'pending', result: undefined }); c.admissions!.push(Date.now() - 120000); });
    server = await startTrackingServer(join(dir, 's'), key, port, undefined, undefined, undefined, undefined, undefined, script.config);
    a = await owner(origin, 'durable-owner', false);
    assert.equal((await classify(origin, a, op)).json.status, 'suggested');
    assert.equal((await classify(origin, a, op)).json.code, 'CLASSIFICATION_QUOTA', 'daily window of 3 reached');
    assert.equal(script.calls.length, 2);
    // A recorded admission later than now (clock rolled back) denies admission instead of resetting.
    await server.close();
    await editState(join(dir, 's'), key, c => { c.admissions = [Date.now() + 3_600_000]; });
    server = await startTrackingServer(join(dir, 's'), key, port, undefined, undefined, undefined, undefined, undefined, script.config);
    a = await owner(origin, 'durable-owner', false);
    assert.equal((await classify(origin, a, op)).json.code, 'CLASSIFICATION_CLOCK_UNTRUSTED');
    assert.equal((await call(origin, '/classification/config', {}, a)).json.quota.clockTrusted, false);
    assert.equal(script.calls.length, 2);
    for (const quota of [{ perMinute: 0, perDay: 1 }, { perMinute: 3, perDay: 2 }, { perMinute: 1, perDay: 1001 }, { perMinute: 1.5, perDay: 2 }])
      await assert.rejects(startTrackingServer(join(dir, 'x'), key, 0, undefined, undefined, undefined, undefined, undefined, scripted(quota).config), /CLASSIFICATION_CONFIG_INVALID/);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
