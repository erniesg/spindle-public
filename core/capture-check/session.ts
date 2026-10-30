// Memory-only capture-check state. Native producers own source timestamps;
// this shared consumer owns visit boundaries and rejects stale enrichment.
import { record, type Visit, type Counts, type Diagnostic } from './types.js';
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const allowed = (values: string[], value: unknown) => typeof value === 'string' && values.includes(value);
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);

export class CaptureSession {
  recording = false;
  epoch: number | null = null;
  active: Visit | null = null;
  visits: Visit[] = [];
  lastAt = 0;
  revision = -1;
  counts: Counts = { rejected: 0, textUpdates: 0, evictedVisits: 0, unavailable: 0 };
  maxVisits: number;
  maxSamples: number;
  lastEpoch: number;
  constructor({ maxVisits = 300, maxSamples = 4 } = {}) {
    this.maxVisits = maxVisits;
    this.maxSamples = maxSamples;
    this.lastEpoch = 0;
    this.clear();
  }

  clear() {
    this.recording = false;
    this.epoch = null;
    this.active = null;
    this.visits = [];
    this.lastAt = 0;
    this.revision = -1;
    this.counts = { rejected: 0, textUpdates: 0, evictedVisits: 0, unavailable: 0 };
  }

  start(epoch: number) {
    if (this.recording || !integer(epoch) || epoch <= this.lastEpoch) throw new Error('INVALID_EPOCH');
    this.lastEpoch = this.epoch = epoch;
    this.recording = true;
    this.revision = -1;
  }

  stop(at = this.lastAt) {
    if (this.active) this.active.end = Math.max(this.active.start, this.lastAt, finiteTime(at) ? at : 0);
    this.active = null;
    this.recording = false;
  }

  loseCoverage(epoch: unknown, at: unknown) {
    if (epoch !== this.epoch || !finiteTime(at)) return false;
    this.recording = false;
    this.active = null;
    // Extraction counters are cumulative (also across ordinary sample/visit
    // eviction), not retained-snapshot counts. Preserve them for diagnostics.
    this.visits = this.visits.filter(visit => visit.start < at);
    for (const visit of this.visits) {
      if (visit.end === null || visit.end > at) visit.end = at;
      visit.samples = visit.samples.filter(sample => sample.at < at);
    }
    this.lastAt = Math.min(this.lastAt, at);
    return true;
  }

  accept(event: unknown) {
    const reject = () => { this.counts.rejected++; return false; };
    if (!record(event) || !this.recording || event.epoch !== this.epoch || !finiteTime(event.at) || !integer(event.revision)) return reject();
    if (event.kind === 'focus') {
      if (event.at < this.lastAt || event.revision <= this.revision) return reject();
      if (event.key !== null && (!bounded(event.key, 128) || !bounded(event.title, 256))) return reject();
      if (this.active) this.active.end = event.at;
      this.active = null;
      this.lastAt = event.at;
      this.revision = event.revision;
      if (typeof event.key === 'string' && typeof event.title === 'string') {
        this.active = { id: `${this.epoch}:${event.revision}`, key: event.key, title: event.title, start: event.at, end: null, samples: [] };
        this.visits.push(this.active);
        if (this.visits.length > this.maxVisits) { this.visits.shift(); this.counts.evictedVisits++; }
      }
      return true;
    }
    const visit = this.active;
    if (event.kind !== 'text' || !visit || event.revision !== this.revision || event.key !== visit.key || event.at < this.lastAt) return reject();
    if (event.status !== 'ok') { this.counts.unavailable++; return true; }
    if (!bounded(event.text, 4096)) return reject();
    const previous = visit.samples.at(-1);
    if (previous && event.at < previous.at) return reject();
    if (!event.text || previous?.text === event.text) return true;
    visit.samples.push({ at: event.at, text: event.text });
    if (visit.samples.length > this.maxSamples) visit.samples.shift();
    this.counts.textUpdates++;
    return true;
  }

  snapshot() {
    return { recording: this.recording, visits: this.visits, counts: this.counts };
  }
}

export function diagnosticLocations(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  const result: Diagnostic[] = [];
  for (const item of value.slice(0, 20)) {
    if (record(item) && integer(item.line) && item.line > 0 && item.line < 10000 && integer(item.column) && item.column > 0 && item.column < 10000 && matches(/^(CS\d{4}|SWIFT_ERROR)$/, item.code)) result.push({ line: item.line, column: item.column, code: item.code });
  }
  return result;
}

const codes = new Set(['OK', 'STARTING', 'MAC_ACCESSIBILITY_REQUIRED', 'MAC_TOOLS_REQUIRED', 'MAC_BUILD_FAILED', 'WINDOWS_HELPER_MISSING', 'HELPER_EXITED', 'HELPER_TIMEOUT', 'WINDOWS_COVERAGE_GAP', 'MAC_COVERAGE_GAP', 'FIXTURE_FAILED', 'NATIVE_UNAVAILABLE', 'EMPTY_TEXT', 'SHUTDOWN']);
export function feedback(session: CaptureSession, info: Record<string, unknown> = {}) {
  // Construct, don't redact: arbitrary native/error/session properties never cross
  // this export boundary. In particular, no IDs, titles, content or raw paths.
  return {
    schema: 'spindle-capture-check-feedback/v1',
    nativeAcceptance: 'not-validated',
    scope: 'native-accessibility-smoke-test',
    build: matches(/^[a-f0-9]{64}$/, info.build) ? info.build : 'development',
    sourceCommit: matches(/^[a-f0-9]{40}$/, info.sourceCommit) ? info.sourceCommit : 'development',
    sourceDirty: info.sourceDirty !== false,
    nativeHelperSha256: matches(/^[a-f0-9]{64}$/, info.nativeHash) ? info.nativeHash : 'not-built',
    osRelease: matches(/^\d+(\.\d+){1,3}$/, info.osRelease) ? info.osRelease : 'unknown',
    nodeVersion: matches(/^\d+\.\d+\.\d+$/, info.nodeVersion) ? info.nodeVersion : 'unknown',
    fixtureVersion: 'native-static-text/v1',
    scenario: allowed(['normal', 'fast', 'manual'], info.scenario) ? info.scenario : 'none',
    fixtureFocusEvents: integer(info.fixtureFocusEvents) && info.fixtureFocusEvents >= 0 && info.fixtureFocusEvents <= 100 ? info.fixtureFocusEvents : 0,
    buildDiagnostics: diagnosticLocations(info.diagnostics),
    platform: allowed(['darwin', 'win32', 'linux'], info.platform) ? info.platform : 'unknown',
    arch: allowed(['arm64', 'x64'], info.arch) ? info.arch : 'unknown',
    stage: {
      helper: allowed(['ready', 'starting', 'failed', 'stopped'], info.helper) ? info.helper : 'unknown',
      code: typeof info.code === 'string' && codes.has(info.code) ? info.code : 'UNKNOWN',
    },
    capabilities: { nativeText: info.helper === 'ready' && info.permission !== false, browser: false, ocr: false, screenshots: false, diskRetention: false },
    counts: {
      visits: session.visits.length,
      withText: session.visits.filter(v => v.samples.length > 0).length,
      textUpdates: session.counts.textUpdates,
      rejected: session.counts.rejected,
      unavailable: session.counts.unavailable,
      evictedVisits: session.counts.evictedVisits,
    },
    closedVisitDurationsMs: session.visits.filter(v => v.end !== null).map(v => Math.round((v.end ?? v.start) - v.start)),
  };
}
