// Account-hosted remote classification. The server keeps the provider and its
// credential; native/web clients only name an owned record. No automatic dispatch.
import { createHash } from 'node:crypto';
import { ModelOperations, RemoteConsent, type ClassificationResult, type RemoteField } from '../models/operations.js';
import { validateModel, type ModelDeclaration, type TextProvider } from '../models/provider.js';
import type { Labels } from '../classification/types.js';
import { assignment, labelEngine, type LabelState } from '../tracking/session.js';
import { evidenceRevision, identifier, type Entry, type HistoryRecord } from '../tracking/types.js';

export interface ClassificationConfig {
  /** Operator-chosen public declaration. The created provider must match it. */
  model: ModelDeclaration;
  /** Invoked only after authentication, consent and currentness admission; owns credential and budget. */
  createProvider(context: { current(): boolean; signal: AbortSignal }): TextProvider;
  /** Operator remote-processing pause, checked at admission, dispatch and persistence. */
  paused?(): boolean;
  /** Per-account admissions per rolling minute and day. Absent means the preview default. */
  quota?: ClassificationQuota;
}
export interface ClassificationQuota { perMinute: number; perDay: number }
/** Conservative initial developer-preview default; the shared FileCallBudget remains the final cap. */
export const DEFAULT_CLASSIFICATION_QUOTA: Readonly<ClassificationQuota> = Object.freeze({ perMinute: 2, perDay: 12 });
const MINUTE = 60_000, DAY = 86_400_000;
export interface ClassificationConsent { revision: number; provider: string; modelId: string; fields: RemoteField[] }
interface StoredResult { status: string; labels?: Labels; description?: string; provider?: string; model?: string }
export interface ClassificationRequest {
  requestId: string; key: string; evidenceRevision: number; mode: 'text' | 'image'; session: string;
  consentRevision: number; correctionRevision: number; imageDigest: string | null; state: 'pending' | 'done'; result?: StoredResult;
}
/** `admissions`: durable times of every admitted (possibly dispatched) request in the last day. Never refunded. */
export interface ClassificationState { revision: number; consent: ClassificationConsent | null; requests: ClassificationRequest[]; admissions?: number[] }
interface HostAccount { id: string; entries: Entry[]; labels?: LabelState; classification?: ClassificationState }
interface HostState { accounts: HostAccount[]; sessions: Record<string, { account: string; expires: number }> }
interface Job { request: ClassificationRequest; account: string; record: HistoryRecord; history: Labels[]; fields: RemoteField[]; expires: number; controller: AbortController }
export class ClassificationFailure extends Error { constructor(readonly status: number, code: string) { super(code); } }
const fail = (status: number, code: string): never => { throw new ClassificationFailure(status, code); };
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const keys = (data: Record<string, unknown>, expected: string[]) => Object.keys(data).sort().join(',') === [...expected].sort().join(',');
const remoteFields = ['appId', 'domain', 'title', 'text', 'image'] as const;
const correctionRevision = (a: HostAccount, key: string, revision: number) => { const c = a.labels?.corrections[key]; return c?.evidenceRevision === revision ? c.revision : 0; };

/** Processing off revokes remote consent and discards stored inference. */
export function revokeClassification(a: HostAccount) {
  if (a.labels) delete a.labels.inferences;
  if (a.classification?.consent) { a.classification.consent = null; a.classification.revision++; }
}

export class ClassificationHost {
  readonly #model: ModelDeclaration;
  readonly #quota: ClassificationQuota;
  // At most one in-memory job per account; durable request metadata lives in the account.
  readonly #jobs = new Map<string, Job>();
  #closed = false;
  constructor(private readonly config: ClassificationConfig) {
    validateModel(config.model);
    if (typeof config.createProvider !== 'function' || config.paused !== undefined && typeof config.paused !== 'function') throw Error('CLASSIFICATION_CONFIG_INVALID');
    const q = config.quota ?? DEFAULT_CLASSIFICATION_QUOTA;
    if (!q || typeof q !== 'object' || Object.keys(q).sort().join(',') !== 'perDay,perMinute' || !Number.isSafeInteger(q.perMinute) || !Number.isSafeInteger(q.perDay) || q.perMinute < 1 || q.perDay < q.perMinute || q.perDay > 1000) throw Error('CLASSIFICATION_CONFIG_INVALID');
    this.#model = structuredClone(config.model);
    this.#quota = { perMinute: q.perMinute, perDay: q.perDay };
  }
  /** Rolling usage. A recorded admission later than now means the clock went back: fail closed. */
  #usage(a: HostAccount, now: number) {
    const admissions = a.classification?.admissions ?? [];
    const untrusted = admissions.some(t => t > now);
    return { untrusted, minute: admissions.filter(t => t > now - MINUTE).length, day: admissions.filter(t => t > now - DAY).length };
  }
  #paused() { try { return this.config.paused?.() === true; } catch { return true; } }
  #state(a: HostAccount) { return a.classification ??= { revision: 0, consent: null, requests: [] }; }
  #consent(a: HostAccount) { const c = a.classification?.consent; return c && c.provider === this.#model.provider && c.modelId === this.#model.id ? c : null; }
  #view(a: HostAccount, request: ClassificationRequest) {
    const { requestId, key, evidenceRevision, mode } = request;
    if (request.state === 'done') return { requestId, key, evidenceRevision, mode, state: 'done', ...request.result };
    // A pending record without a live job means dispatch may have happened: never redispatch.
    return { requestId, key, evidenceRevision, mode, state: this.#jobs.get(a.id)?.request.requestId === requestId ? 'inflight' : 'unknown' };
  }
  #configuration(a: HostAccount) {
    const c = this.#consent(a);
    const usage = this.#usage(a, Date.now());
    return { configured: true, model: { provider: this.#model.provider, id: this.#model.id, vision: !!this.#model.images }, paused: this.#paused(), processing: a.labels?.local === true, consent: c ? { revision: c.revision, fields: [...c.fields] } : null, automatic: false, quota: { ...this.#quota, usedMinute: usage.minute, usedDay: usage.day, clockTrusted: !usage.untrusted } };
  }
  /** Runs inside the authenticated account transaction. Returns a value or an admitted job. */
  handle(state: HostState, a: HostAccount, session: string, path: string, data: Record<string, unknown>): { value: unknown; job?: never } | { job: Job; value?: never } {
    if (path === '/classification/config') { if (Object.keys(data).length) fail(400, 'INVALID_CLASSIFICATION_QUERY'); return { value: this.#configuration(a) }; }
    if (path === '/classification/consent') {
      // Revocation cancels live work via observe(); completed inference remains until processing is off.
      if (data.enabled === false && keys(data, ['enabled'])) { const s = this.#state(a); if (s.consent) { s.consent = null; s.revision++; } return { value: this.#configuration(a) }; }
      const fields = data.fields;
      if (data.enabled !== true || !keys(data, ['enabled', 'fields']) || !Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length || fields.some(f => !(remoteFields as readonly unknown[]).includes(f))) fail(400, 'INVALID_CONSENT');
      if (a.labels?.local !== true) fail(403, 'PROCESSING_OFF');
      if ((fields as RemoteField[]).includes('image') && !this.#model.images) fail(400, 'UNSUPPORTED_CAPABILITY');
      const s = this.#state(a);
      s.consent = { revision: ++s.revision, provider: this.#model.provider, modelId: this.#model.id, fields: [...fields as RemoteField[]] };
      return { value: this.#configuration(a) };
    }
    if (path === '/classification/status') {
      if (!keys(data, ['requestId']) || !identifier(data.requestId)) fail(400, 'INVALID_CLASSIFICATION_REQUEST');
      const request = a.classification?.requests.find(r => r.requestId === data.requestId);
      if (!request) fail(404, 'CLASSIFICATION_REQUEST_NOT_FOUND');
      return { value: this.#view(a, request!) };
    }
    if (path !== '/classification/classify') fail(404, 'NOT_FOUND');
    if (!keys(data, ['key', 'evidenceRevision', 'requestId', 'mode']) || typeof data.key !== 'string' || data.key.length > 400 || !Number.isSafeInteger(data.evidenceRevision) || !identifier(data.requestId) || !['text', 'image'].includes(data.mode as string)) fail(400, 'INVALID_CLASSIFICATION_REQUEST');
    const previous = a.classification?.requests.find(r => r.requestId === data.requestId);
    if (previous) {
      if (previous.key !== data.key || previous.evidenceRevision !== data.evidenceRevision || previous.mode !== data.mode) fail(409, 'REQUEST_ID_REUSED');
      return { value: this.#view(a, previous) };
    }
    if (this.#closed) fail(503, 'CLASSIFICATION_CLOSED');
    if (this.#paused()) fail(503, 'CLASSIFICATION_PAUSED');
    if (a.labels?.local !== true) fail(403, 'PROCESSING_OFF');
    const consent = this.#consent(a);
    if (!consent) fail(403, 'REMOTE_DISABLED');
    // Only the authenticated account's own retained evidence; no request-supplied context.
    const r = a.entries.find(e => e.key === data.key && !e.deleted && e.record)?.record;
    if (!r) fail(404, 'EVIDENCE_NOT_FOUND');
    const now = Date.now(), mode = data.mode as 'text' | 'image';
    if (r!.expiresAt <= now || r!.visit.expiresAt <= now) fail(410, 'CONTEXT_EXPIRED');
    if (evidenceRevision(r!) !== data.evidenceRevision) fail(409, 'STALE_EVIDENCE');
    if (mode === 'image' ? !consent!.fields.includes('image') : !consent!.fields.some(f => f !== 'image')) fail(403, 'FIELDS_DENIED');
    let imageDigest: string | null = null;
    if (mode === 'image') {
      if (!r!.scopes.pixels || !r!.visit.image || (r!.visit.imageExpiresAt ?? r!.visit.expiresAt) <= now) fail(409, 'IMAGE_UNAVAILABLE');
      imageDigest = digest(r!.visit.image);
    }
    if (this.#jobs.has(a.id)) fail(409, 'CLASSIFIER_BUSY');
    // Same-requestId replay returned above and never reaches the quota.
    const usage = this.#usage(a, now);
    if (usage.untrusted) fail(503, 'CLASSIFICATION_CLOCK_UNTRUSTED');
    if (usage.minute >= this.#quota.perMinute || usage.day >= this.#quota.perDay) fail(429, 'CLASSIFICATION_QUOTA');
    const s = this.#state(a);
    if (s.requests.length >= 32) { const done = s.requests.findIndex(v => v.state === 'done'); if (done < 0) fail(507, 'CLASSIFICATION_REQUEST_BOUND'); s.requests.splice(done, 1); }
    // Counted in the same committed transaction as the pending request, before any provider exists.
    s.admissions = [...(s.admissions ?? []).filter(t => t > now - DAY), now];
    const request: ClassificationRequest = { requestId: data.requestId as string, key: data.key as string, evidenceRevision: data.evidenceRevision as number, mode, session, consentRevision: consent!.revision, correctionRevision: correctionRevision(a, data.key as string, data.evidenceRevision as number), imageDigest, state: 'pending' };
    s.requests.push(request);
    const c = a.labels!.corrections[request.key];
    const job: Job = { request: structuredClone(request), account: a.id, record: structuredClone(r!), history: c?.evidenceRevision === request.evidenceRevision ? structuredClone(c.history) : [], fields: mode === 'image' ? [...consent!.fields] : consent!.fields.filter(f => f !== 'image'), expires: Math.min(state.sessions[session]!.expires, r!.expiresAt, r!.visit.expiresAt, mode === 'image' ? r!.visit.imageExpiresAt ?? r!.visit.expiresAt : Infinity), controller: new AbortController() };
    // Registered before commit; an uncommitted job fails the next observe/persist fence.
    this.#jobs.set(a.id, job);
    return { job };
  }
  #valid(state: HostState, job: Job, now = Date.now()) {
    const q = job.request, session = state.sessions[q.session];
    if (this.#closed || this.#paused() || job.controller.signal.aborted || this.#jobs.get(job.account) !== job || !session || session.account !== job.account || session.expires <= now) return false;
    const a = state.accounts.find(v => v.id === job.account);
    if (!a || a.labels?.local !== true || this.#consent(a)?.revision !== q.consentRevision || !a.classification!.requests.some(v => v.requestId === q.requestId && v.state === 'pending')) return false;
    const r = a.entries.find(e => e.key === q.key && !e.deleted)?.record;
    if (!r || evidenceRevision(r) !== q.evidenceRevision || r.expiresAt <= now || r.visit.expiresAt <= now) return false;
    if (q.imageDigest !== null && (!r.scopes.pixels || !r.visit.image || digest(r.visit.image) !== q.imageDigest || (r.visit.imageExpiresAt ?? r.visit.expiresAt) <= now)) return false;
    return correctionRevision(a, q.key, q.evidenceRevision) === q.correctionRevision;
  }
  /** After every committed account write: cancel jobs whose session, consent or evidence changed. */
  observe(state: HostState) { for (const job of this.#jobs.values()) if (!this.#valid(state, job)) job.controller.abort(); }
  /** Outside the encrypted FIFO. One bounded owned record per call; no retry. */
  async run(job: Job): Promise<ClassificationResult> {
    const current = () => !this.#closed && !this.#paused() && !job.controller.signal.aborted && Date.now() < job.expires;
    try {
      if (!current()) return { status: 'STALE_REQUEST' };
      const provider = this.config.createProvider({ current, signal: job.controller.signal });
      const declared = provider.model;
      if (declared.provider !== this.#model.provider || declared.id !== this.#model.id) return { status: 'INVALID_MODEL' };
      const engine = labelEngine(job.account, job.record), r = job.record;
      // Existing user corrections are frozen: ModelOperations preserves them without dispatch.
      for (const labels of job.history) engine.correct(r.recordingId, r.visitId, labels);
      const consent = new RemoteConsent();
      consent.grant({ provider: declared.provider, modelId: declared.id, operations: ['classify'], fields: job.fields });
      return await new ModelOperations(consent, provider).classify(engine, r.recordingId, r.visitId, { current, signal: job.controller.signal, ...(job.request.mode === 'image' ? { image: r.visit.image } : {}) });
    } catch { return { status: 'LOCAL_STATE_UNAVAILABLE' }; }
  }
  /** Final transaction: persist only a still-current inference, separate from corrections. */
  persist(state: HostState, job: Job, result: ClassificationResult) {
    const a = state.accounts.find(v => v.id === job.account), q = job.request;
    const request = a?.classification?.requests.find(v => v.requestId === q.requestId && v.state === 'pending');
    if (!a || !request) return { requestId: q.requestId, key: q.key, evidenceRevision: q.evidenceRevision, mode: q.mode, state: 'done', status: 'STALE_RESULT' };
    const current = this.#valid(state, job);
    let stored: StoredResult = { status: result.status };
    if (result.status === 'suggested' || result.status === 'abstained') {
      const remote = { provider: this.#model.provider, model: result.model ?? this.#model.id };
      if (!current) stored = { status: 'STALE_RESULT' };
      else if (result.status === 'abstained') { delete a.labels!.inferences?.[q.key]; stored = { status: 'abstained', ...remote }; }
      else {
        const source = result.assignment.inferenceSource!, description = result.assignment.description ? { description: result.assignment.description } : {};
        (a.labels!.inferences ??= {})[q.key] = { evidenceRevision: q.evidenceRevision, labels: structuredClone(result.assignment.labels), source: { engine: source.engine, version: source.version, promptDigest: source.promptDigest }, ...remote, requestId: q.requestId, ...description };
        stored = { status: 'suggested', labels: structuredClone(result.assignment.labels), ...description, ...remote };
      }
    }
    request.state = 'done'; request.result = stored;
    const r = a.entries.find(e => e.key === q.key && !e.deleted)?.record;
    return { ...this.#view(a, request), label: current && r ? assignment(a.id, r, a.labels!, q.key) : null };
  }
  release(job: Job) { job.controller.abort(); if (this.#jobs.get(job.account) === job) this.#jobs.delete(job.account); }
  close() { this.#closed = true; for (const job of this.#jobs.values()) job.controller.abort(); }
}
