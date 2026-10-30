import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';
import { spawn } from 'node:child_process';
import { CaptureSession, feedback, diagnosticLocations } from './session.js';
import { launchNative, nativeExecutable } from './native.js';
import type { NativeLauncher, NativeProcess, Stage, BuildIdentity } from './types.js';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildIdentity(root: string): Promise<BuildIdentity> {
  try { return JSON.parse(await readFile(join(root, 'capture-check.build.json'), 'utf8')); } catch { /* Development checkout. */ }
  const hash = createHash('sha256');
  const manifest = JSON.parse(await readFile(join(root, 'contracts/capture-check.package.json'), 'utf8'));
  for (const path of manifest.files) {
    hash.update(path + '\0'); hash.update(await readFile(join(root, path))); hash.update('\0');
  }
  return { fingerprint: hash.digest('hex'), sourceCommit: 'development', dirty: true };
}

export async function createCheck({ root = resolve(here, '../../..'), launch = launchNative, onQuit = () => {} }: { root?: string; launch?: NativeLauncher; onQuit?: () => void } = {}) {
  const identity = await buildIdentity(root);
  let nativeHash = 'not-built';
  const binaryPath = nativeExecutable(root);
  try { if (binaryPath) nativeHash = createHash('sha256').update(await readFile(binaryPath)).digest('hex'); } catch { /* Source fallback/build-failure mode. */ }
  const session = new CaptureSession();
  const token = randomBytes(32).toString('hex');
  const stage: Stage = { helper: 'starting', code: 'STARTING', permission: null, fixture: 'closed', diagnostics: [] };
  const info = () => ({ build: identity.fingerprint, sourceCommit: identity.sourceCommit, sourceDirty: identity.dirty, nativeHash, platform: process.platform, arch: process.arch, osRelease: release(), nodeVersion: process.versions.node, scenario: lastScenario, fixtureFocusEvents: oracle.length, ...stage });
  let helper: NativeProcess, fixture: NativeProcess | null, fixtureReady: Promise<NativeProcess> | null, cancelFixtureStart: (() => void) | null;
  let epoch = 0, operation = 0, closed = false;
  let nativeAt = 0, nativeReceived = performance.now();
  let sequence = 'idle', lastScenario = 'none';
  let timers: NodeJS.Timeout[] = [];
  let oracle: { target: string; at: number }[] = [];
  const cancelTimers = () => { for (const timer of timers) clearTimeout(timer); timers = []; sequence = 'idle'; };
  const nativeNow = () => nativeAt + (performance.now() - nativeReceived);
  const pause = () => {
    operation++;
    cancelTimers();
    session.stop(nativeNow()); // Producer stop also fences all optional results.
    helper?.send({ action: 'stop' });
  };
  const clear = () => {
    pause(); session.clear(); oracle = []; lastScenario = 'none';
    cancelFixtureStart?.(); cancelFixtureStart = null;
    const old = fixture; fixture = null; fixtureReady = null;
    old?.stop(); stage.fixture = 'closed';
  };
  helper = launch(root, false, event => {
    if (closed || !event || typeof event !== 'object') return;
    if (typeof event.at === 'number' && Number.isFinite(event.at) && event.at >= nativeAt) { nativeAt = event.at; nativeReceived = performance.now(); }
    if (event.kind === 'ready') { stage.helper = 'ready'; stage.permission = event.permission === true; stage.code = stage.permission ? 'OK' : 'MAC_ACCESSIBILITY_REQUIRED'; }
    else if (event.kind === 'permission') {
      stage.permission = event.granted === true;
      // Permission status can recover; missing coverage for this run cannot.
      if (!['MAC_COVERAGE_GAP', 'WINDOWS_COVERAGE_GAP'].includes(stage.code)) stage.code = stage.permission ? 'OK' : 'MAC_ACCESSIBILITY_REQUIRED';
      if (!stage.permission) pause();
    }
    else if (event.kind === 'error') { stage.helper = 'failed'; stage.diagnostics = diagnosticLocations(event.diagnostics); stage.code = typeof event.code === 'string' && ['MAC_BUILD_FAILED', 'MAC_TOOLS_REQUIRED', 'WINDOWS_HELPER_MISSING', 'NATIVE_UNAVAILABLE'].includes(event.code) ? event.code : 'HELPER_EXITED'; pause(); }
    else if (event.kind === 'coverageGap') {
      if (!session.loseCoverage(event.epoch, event.at)) return;
      pause(); // Also cancel switches; a late gap can invalidate an already-paused run.
      stage.code = event.code === 'MAC_COVERAGE_GAP' ? 'MAC_COVERAGE_GAP' : 'WINDOWS_COVERAGE_GAP';
    }
    else if (event.kind === 'focus' || event.kind === 'text') session.accept(event);
  }, () => {
    if (closed) return;
    const prior = stage.code;
    pause(); stage.helper = 'failed';
    stage.code = ['NATIVE_UNAVAILABLE', 'WINDOWS_HELPER_MISSING', 'MAC_BUILD_FAILED', 'MAC_TOOLS_REQUIRED'].includes(prior) ? prior : 'HELPER_EXITED';
  });

  async function openFixtures() {
    if (fixture && fixtureReady) return fixtureReady;
    stage.fixture = 'starting';
    let resolveReady!: (child: NativeProcess) => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<NativeProcess>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    fixtureReady = ready;
    const cancelReady = () => rejectReady(new Error('CANCELLED'));
    cancelFixtureStart = cancelReady;
    let child: NativeProcess;
    const fail = () => {
      if (closed || fixture !== child) return;
      clearTimeout(timeout);
      pause(); // Close the visit, cancel activations and fence late text before cleanup.
      fixture = null; fixtureReady = null;
      stage.fixture = 'failed'; stage.code = 'FIXTURE_FAILED';
      rejectReady(new Error('FIXTURE_FAILED'));
      child.stop(); // Detach first: its exit callback must not overwrite the failure.
    };
    const timeout = setTimeout(fail, 30000);
    timeout.unref();
    child = launch(root, true, event => {
      if (closed || fixture !== child) return;
      if (event.kind === 'ready') { clearTimeout(timeout); stage.fixture = 'ready'; resolveReady(child); }
      if (event.kind === 'fixtureFocus' && typeof event.target === 'string' && ['A', 'B'].includes(event.target) && oracle.length < 100) oracle.push({ target: event.target, at: Math.round(performance.now()) });
      if (event.kind === 'activationDenied' || event.kind === 'error') fail();
    }, fail);
    fixture = child;
    try { return await ready; }
    finally {
      clearTimeout(timeout);
      if (cancelFixtureStart === cancelReady) cancelFixtureStart = null;
    }
  }

  async function start(speed: string) {
    if (stage.helper !== 'ready') throw new Error(stage.code);
    if (stage.permission !== true) throw new Error('MAC_ACCESSIBILITY_REQUIRED');
    pause();
    const op = operation;
    const child = await openFixtures();
    if (op !== operation || closed) throw new Error('CANCELLED');
    session.clear(); oracle = [];
    session.start(++epoch);
    lastScenario = speed;
    helper.send({ action: 'start', epoch, pids: [child.pid] });
    stage.code = 'OK';
    if (speed === 'manual') { sequence = 'manual'; return; }
    const durations = speed === 'fast' ? [250, 250, 250, 250, 250, 250, 250, 250] : [2000, 3000, 1000, 4000];
    sequence = speed === 'fast' ? 'fast: 250 ms visits' : 'normal: 2s / 3s / 1s / 4s';
    let delay = 200; // Give the provider its start message before the first activation.
    for (const [index, duration] of durations.entries()) {
      timers.push(setTimeout(() => { if (op === operation) child.send({ action: 'activate', target: index % 2 ? 'B' : 'A' }); }, delay));
      delay += duration;
    }
    timers.push(setTimeout(() => { if (op === operation) pause(); }, delay));
  }

  let origin = '';
  const server = createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const send = (status: number, value: unknown, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
      res.end(type === 'application/json' ? JSON.stringify(value) : String(value));
    };
    if (!origin || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { send(403, { code: 'FORBIDDEN' }); return; }
    if (req.method === 'GET' && ['/', '/ui.js', '/style.css'].includes(req.url ?? '')) {
      const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/ui.js': ['ui.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const [file, type] = assets[req.url ?? ''];
      try { send(200, await readFile(join(here, file), 'utf8'), type); } catch { send(500, { code: 'ASSET_UNAVAILABLE' }); }
      return;
    }
    const expected = `Bearer ${token}`;
    const auth = req.headers.authorization ?? '';
    if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { send(401, { code: 'UNAUTHORIZED' }); return; }
    if (req.method === 'GET' && req.url === '/api/state') {
      send(200, { ...session.snapshot(), stage, sequence, oracle, build: identity.fingerprint, sourceCommit: identity.sourceCommit, platform: process.platform, scope: 'Supplied native fixture windows only. No browser, OCR or screenshots.', nativeNow: nativeNow() }); return;
    }
    if (req.method === 'GET' && req.url === '/api/feedback') {
      send(200, feedback(session, info())); return;
    }
    if (req.method !== 'POST' || !['/api/manual', '/api/normal', '/api/fast', '/api/pause', '/api/clear', '/api/permission', '/api/quit'].includes(req.url ?? '')) { send(404, { code: 'NOT_FOUND' }); return; }
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) { send(413, { code: 'TOO_LARGE' }); return; } }
      const data = JSON.parse(body || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) { send(400, { code: 'INVALID_REQUEST' }); return; }
    } catch { send(400, { code: 'INVALID_REQUEST' }); return; }
    try {
      if (req.url === '/api/manual') await start('manual');
      if (req.url === '/api/normal') await start('normal');
      if (req.url === '/api/fast') await start('fast');
      if (req.url === '/api/pause') pause();
      if (req.url === '/api/clear') clear();
      if (req.url === '/api/permission') helper.send({ action: 'permission' });
      send(200, { ok: true });
      if (req.url === '/api/quit') setImmediate(() => { close(); onQuit(); });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // Only protocol codes, never arbitrary native error text.
      send(409, { code: ['MAC_ACCESSIBILITY_REQUIRED', 'FIXTURE_FAILED', 'CANCELLED', 'STARTING', 'HELPER_EXITED', 'NATIVE_UNAVAILABLE', 'WINDOWS_HELPER_MISSING'].includes(message) ? message : 'HELPER_EXITED' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function close() {
    if (closed) return;
    closed = true; clear(); helper.stop();
    server.close(); server.closeAllConnections();
  }
  return { origin, token, close, identity };
}

export function openInspector(url: string) {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe') : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', () => { console.log('Browser did not open. Paste the local URL above into your browser.'); });
  child.unref();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = await createCheck();
  const url = `${check.origin}/#${check.token}`;
  console.log('Spindle Capture Check — experimental native text smoke test. No recording until you click Start.');
  console.log(`Open locally: ${url}`);
  openInspector(url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => check.close());
}
