import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createCheck } from '../../core/capture-check/app.js';
import type { NativeProcess, NativeCommand, NativeMessage, Visit } from '../../core/capture-check/types.js';
interface FakeProcess extends NativeProcess { commands: NativeCommand[]; stopped: boolean; emit(event: NativeMessage): void }
function startCommand(child: FakeProcess) { const command = child.commands.find(c => c.action === 'start'); assert.ok(command); return command; }

function fakeNative() {
  const processes: FakeProcess[] = [];
  const launch = (_root: string, fixture: boolean, onEvent: (event: NativeMessage) => void, onExit: () => void) => {
    const child: FakeProcess = { pid: fixture ? 202 : 101, commands: [], stopped: false,
      send(command) { this.commands.push(command); },
      stop() { this.stopped = true; onExit(); },
      emit: onEvent,
    };
    processes.push(child);
    queueMicrotask(() => onEvent({ kind: 'ready', permission: true, at: 0 }));
    return child;
  };
  return { launch, processes };
}

async function setup(t: TestContext) {
  const fake = fakeNative();
  const check = await createCheck({ root: process.cwd(), launch: fake.launch });
  t.after(() => check.close());
  const request = (path: string, options: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}) => fetch(check.origin + path, {
    ...options,
    headers: { Authorization: `Bearer ${check.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  return { check, fake, request };
}

test('loopback inspector rejects missing tokens, foreign origins, rebinding and unknown actions', async t => {
  const { check, request } = await setup(t);
  assert.equal((await fetch(check.origin + '/api/state')).status, 401);
  assert.equal((await request('/api/state', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(check.origin + '/api/state', { headers: { Host: 'foreign.invalid', Authorization: `Bearer ${check.token}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await request('/api/run', { method: 'POST', body: '{"action":"arbitrary-command"}' })).status, 404);
  assert.equal((await request('/api/manual', { method: 'POST', body: 'not JSON' })).status, 400);
  assert.equal((await request('/api/manual', { method: 'POST', body: '{"pids":[999]}' })).status, 400);
  assert.equal((await request('/api/manual', { method: 'POST', body: ' '.repeat(9000) })).status, 413);
});

test('explicit start captures only fixture PID; pause and clear reject in-flight results', async t => {
  const { fake, request } = await setup(t);
  assert.equal(fake.processes.length, 1); // Launch alone does not create fixtures or record.
  assert.equal((await (await request('/api/state')).json()).recording, false);
  const response = await request('/api/manual', { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  const helper = fake.processes[0];
  const start = startCommand(helper);
  assert.deepEqual(start.pids, [202]);
  helper.emit({ kind: 'focus', at: 10, epoch: start.epoch, revision: 1, key: 'fixture-A', title: 'LOCAL_SECRET_TITLE' });
  helper.emit({ kind: 'text', at: 20, epoch: start.epoch, revision: 1, key: 'fixture-A', text: 'LOCAL_SECRET_TEXT', status: 'ok' });
  assert.equal((await (await request('/api/state')).json()).visits[0].samples[0].text, 'LOCAL_SECRET_TEXT');
  const feedback = await (await request('/api/feedback')).text();
  assert.ok(!feedback.includes('LOCAL_SECRET'));
  assert.ok(!feedback.includes('fixture-A'));
  assert.equal(JSON.parse(feedback).scenario, 'manual');
  await request('/api/pause', { method: 'POST', body: '{}' });
  helper.emit({ kind: 'text', at: 30, epoch: start.epoch, revision: 1, key: 'fixture-A', text: 'AFTER_PAUSE', status: 'ok' });
  assert.ok(!JSON.stringify(await (await request('/api/state')).json()).includes('AFTER_PAUSE'));
  await request('/api/clear', { method: 'POST', body: '{}' });
  assert.equal((await (await request('/api/state')).json()).visits.length, 0);
  assert.equal(fake.processes[1].stopped, true);
});

for (const code of [undefined, 'MAC_COVERAGE_GAP']) {
 for (const alreadyPaused of [false, true]) {
 test(`${code || 'WINDOWS_COVERAGE_GAP'} ${alreadyPaused ? 'after pause' : 'while recording'} truncates time, stops switches and permits retry`, async t => {
  const { fake, request } = await setup(t);
  await request('/api/normal', { method: 'POST', body: '{}' });
  const helper = fake.processes[0];
  const start = startCommand(helper);
  helper.emit({ kind: 'focus', at: 10, epoch: start.epoch, revision: 1, key: 'fixture-A', title: 'Sample A' });
  helper.emit({ kind: 'text', at: 20, epoch: start.epoch, revision: 1, key: 'fixture-A', status: 'ok', text: 'BEFORE_GAP' });
  if (alreadyPaused) {
    helper.emit({ kind: 'text', at: 4550, epoch: start.epoch, revision: 1, key: 'fixture-A', status: 'ok', text: 'INVALIDATED_LATER' });
    await request('/api/pause', { method: 'POST', body: '{}' });
  }
  helper.emit({ kind: 'coverageGap', at: 50, epoch: start.epoch, code });
  helper.emit({ kind: 'text', at: 4550, epoch: start.epoch, revision: 1, key: 'fixture-A', status: 'ok', text: 'AFTER_GAP' });
  const state = await (await request('/api/state')).json();
  assert.equal(state.recording, false);
  assert.equal(state.sequence, 'idle');
  assert.equal(state.stage.helper, 'ready');
  assert.equal(state.stage.code, code || 'WINDOWS_COVERAGE_GAP');
  assert.equal(state.visits[0].end, 50);
  assert.deepEqual(state.visits[0].samples.map((sample: Visit['samples'][number]) => sample.text), ['BEFORE_GAP']);
  helper.emit({ kind: 'permission', granted: false });
  const denied = await (await request('/api/state')).json();
  assert.equal(denied.stage.permission, false);
  assert.equal(denied.stage.code, code || 'WINDOWS_COVERAGE_GAP');
  assert.equal((await request('/api/manual', { method: 'POST', body: '{}' })).status, 409);
  helper.emit({ kind: 'permission', granted: true });
  const restored = await (await request('/api/state')).json();
  assert.equal(restored.stage.permission, true);
  assert.equal(restored.stage.code, code || 'WINDOWS_COVERAGE_GAP');
  const report = await (await request('/api/feedback')).json();
  assert.equal(report.stage.code, code || 'WINDOWS_COVERAGE_GAP');
  assert.deepEqual(report.closedVisitDurationsMs, [40]);
  await request('/api/pause', { method: 'POST', body: '{}' });
  assert.equal((await (await request('/api/feedback')).json()).stage.code, code || 'WINDOWS_COVERAGE_GAP');
  assert.equal((await request('/api/manual', { method: 'POST', body: '{}' })).status, 200);
  // Queued reports from a stopped epoch cannot stop the retry.
  helper.emit({ kind: 'coverageGap', at: 50, epoch: start.epoch });
  const retried = await (await request('/api/state')).json();
  assert.equal(retried.recording, true);
  assert.equal(retried.stage.code, 'OK');
 });
 }
}

test('malformed native error codes still stop recording without coercing untrusted objects', async t => {
  const { fake, request } = await setup(t);
  await request('/api/manual', { method: 'POST', body: '{}' });
  assert.doesNotThrow(() => fake.processes[0].emit({ kind: 'error', code: { toString: null } }));
  const state = await (await request('/api/state')).json();
  assert.equal(state.recording, false);
  assert.equal(state.sequence, 'idle');
  assert.equal(state.stage.helper, 'failed');
  assert.equal(state.stage.code, 'HELPER_EXITED');
});

test('helper exit stops recording and returns only a stable error code', async t => {
  const { fake, request } = await setup(t);
  await request('/api/manual', { method: 'POST', body: '{}' });
  fake.processes[0].stop();
  const state = await (await request('/api/state')).json();
  assert.equal(state.recording, false);
  assert.equal(state.stage.code, 'HELPER_EXITED');
  assert.equal(state.stage.helper, 'failed');
});

for (const failure of [{ kind: 'error', code: 'FIXTURE_FAILED' }, { kind: 'activationDenied' }]) {
  test(`fixture ${failure.kind} after readiness stops the run, preserves failure and allows retry`, async t => {
    const { fake, request } = await setup(t);
    assert.equal((await request('/api/normal', { method: 'POST', body: '{}' })).status, 200);
    const [helper, fixture] = fake.processes;
    const start = startCommand(helper);
    helper.emit({ kind: 'focus', at: 10, epoch: start.epoch, revision: 1, key: 'fixture-A', title: 'Sample A' });
    helper.emit({ kind: 'text', at: 11, epoch: start.epoch, revision: 1, key: 'fixture-A', text: 'BEFORE_FAILURE', status: 'ok' });
    const commandsBeforeFailure = helper.commands.length;

    fixture.emit(failure);
    const failed = await (await request('/api/state')).json();
    assert.equal(failed.recording, false);
    assert.equal(failed.sequence, 'idle');
    assert.equal(failed.stage.fixture, 'failed');
    assert.equal(failed.stage.code, 'FIXTURE_FAILED');
    assert.notEqual(failed.visits[0].end, null);
    assert.deepEqual(helper.commands.slice(commandsBeforeFailure), [{ action: 'stop' }]);
    assert.equal(fixture.stopped, true);

    helper.emit({ kind: 'text', at: 20, epoch: start.epoch, revision: 1, key: 'fixture-A', text: 'AFTER_FAILURE', status: 'ok' });
    const stopped = await (await request('/api/state')).json();
    assert.equal(stopped.visits[0].samples.length, 1);
    assert.equal(stopped.visits[0].samples[0].text, 'BEFORE_FAILURE');
    const report = await (await request('/api/feedback')).json();
    assert.equal(report.stage.code, 'FIXTURE_FAILED');
    assert.equal(report.counts.withText, 1);
    assert.ok(!JSON.stringify(report).includes('BEFORE_FAILURE'));

    assert.equal((await request('/api/manual', { method: 'POST', body: '{}' })).status, 200);
    assert.equal(fake.processes.length, 3); // A fresh fixture process, not the failed one.
    fixture.emit({ kind: 'ready' });
    fixture.emit(failure); // Late callbacks from the old process cannot fail the retry.
    const retried = await (await request('/api/state')).json();
    assert.equal(retried.recording, true);
    assert.equal(retried.stage.fixture, 'ready');
    assert.equal(retried.stage.code, 'OK');
  });
}

test('clear during fixture startup cancels the pending request and permits a fresh retry', async t => {
  const fake = fakeNative();
  let fixtureLaunched!: (child: FakeProcess) => void;
  const launched = new Promise<FakeProcess>(resolve => { fixtureLaunched = resolve; });
  let holdFirstFixture = true;
  const check = await createCheck({ launch: (root, fixture, onEvent, onExit) => {
    const hold = fixture && holdFirstFixture;
    if (hold) holdFirstFixture = false;
    const child = fake.launch(root, fixture, event => {
      if (!hold) onEvent(event);
    }, onExit);
    if (hold) fixtureLaunched(child);
    return child;
  } });
  t.after(() => check.close());
  const request = (path: string) => fetch(check.origin + path, {
    method: 'POST', headers: { Authorization: `Bearer ${check.token}` }, body: '{}',
    signal: AbortSignal.timeout(2000),
  });
  // Attach a rejection handler immediately, including on the unfixed controller.
  const pending = request('/api/manual').then(response => response, error => error);
  const oldFixture = await launched;
  assert.equal((await request('/api/clear')).status, 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, 409, 'Clear must settle the pending start, not leave it hanging');
  assert.equal((await cancelled.json()).code, 'CANCELLED');
  assert.equal(oldFixture.stopped, true);
  assert.ok(!fake.processes[0].commands.some(command => command.action === 'start'));
  assert.equal((await request('/api/manual')).status, 200);
  const state = await fetch(check.origin + '/api/state', { headers: { Authorization: `Bearer ${check.token}` } }).then(response => response.json());
  assert.equal(state.recording, true);
  assert.equal(state.stage.fixture, 'ready');
});

test('fixture failure before readiness returns an error without recording and allows retry', async t => {
  const fake = fakeNative();
  let failFirstFixture = true;
  const check = await createCheck({ launch: (root, fixture, onEvent, onExit) => fake.launch(root, fixture, event => {
    if (fixture && failFirstFixture && event.kind === 'ready') {
      failFirstFixture = false;
      onEvent({ kind: 'error', code: 'FIXTURE_FAILED' });
    } else onEvent(event);
  }, onExit) });
  t.after(() => check.close());
  const request = (path: string) => fetch(check.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${check.token}` }, body: '{}' });
  const response = await request('/api/manual');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'FIXTURE_FAILED');
  assert.equal(fake.processes[1].stopped, true);
  assert.ok(!fake.processes[0].commands.some(command => command.action === 'start'));
  assert.equal((await request('/api/manual')).status, 200);
});
