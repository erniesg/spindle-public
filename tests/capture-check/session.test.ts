import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession, feedback } from '../../core/capture-check/session.js';

const focus = (at: number, revision: number, key: string | null) => ({ kind: 'focus', at, revision, key, title: key, epoch: 1 });
const text = (at: number, revision: number, key: string, value: string) => ({ kind: 'text', at, revision, key, text: value, epoch: 1, status: 'ok' });

test('rapid returns keep four visits and ten seconds, independent of slow text', () => {
  const s = new CaptureSession(); s.start(1);
  for (const e of [focus(0, 1, 'A'), focus(2000, 2, 'B'), focus(5000, 3, 'A'), focus(6000, 4, 'B')]) s.accept(e);
  s.accept(text(100, 1, 'A', 'late text from first A'));
  s.stop(10000);
  assert.deepEqual(s.visits.map(v => { assert.ok(v.end !== null); return [v.title, v.end - v.start]; }), [['A', 2000], ['B', 3000], ['A', 1000], ['B', 4000]]);
  assert.equal(s.visits.flatMap(v => v.samples).length, 0);
  assert.equal(s.counts.rejected, 1);
});

test('same-window changes update readback, but stale return visits cannot contaminate it', () => {
  const s = new CaptureSession(); s.start(1);
  s.accept(focus(0, 1, 'A'));
  s.accept(text(10, 1, 'A', 'one'));
  s.accept(text(200, 1, 'A', 'two'));
  s.accept(focus(300, 2, 'B'));
  s.accept(focus(400, 3, 'A'));
  s.accept(text(420, 1, 'A', 'old A'));
  s.accept(text(430, 3, 'A', 'new A'));
  assert.deepEqual(s.visits.map(v => v.samples.map(c => c.text)), [['one', 'two'], [], ['new A']]);
});

test('pause, clear and new recording fence old in-flight context', () => {
  const s = new CaptureSession(); s.start(1); s.accept(focus(0, 1, 'A'));
  s.stop(100); s.accept(text(90, 1, 'A', 'after pause'));
  assert.equal(s.visits[0].samples.length, 0);
  s.clear(); s.start(2);
  s.accept({ ...focus(200, 1, 'A'), epoch: 2 });
  s.accept(text(210, 1, 'A', 'replayed previous session'));
  assert.equal(s.visits[0].samples.length, 0);
  assert.equal(s.counts.rejected, 1);
});

test('unpermitted focus closes the visit without persisting the foreign title', () => {
  const s = new CaptureSession(); s.start(1); s.accept(focus(0, 1, 'A'));
  s.accept({ ...focus(50, 2, null), title: 'SECRET foreign window' });
  assert.equal(s.visits[0].end, 50);
  assert.equal(s.visits.length, 1);
  assert.ok(!JSON.stringify(s.snapshot()).includes('SECRET'));
});

test('bad timestamps, revisions, and oversized frames do not extend or corrupt a visit', () => {
  const s = new CaptureSession(); s.start(1); s.accept(focus(10, 1, 'A'));
  s.accept(focus(5, 2, 'B'));
  s.accept(text(0, 1, 'A', 'before visit'));
  s.accept(text(Infinity, 1, 'A', 'not finite'));
  s.accept(text(20, 1, 'A', 'x'.repeat(5000)));
  assert.equal(s.visits.length, 1);
  assert.equal(s.visits[0].samples.length, 0);
  assert.equal(s.counts.rejected, 4);
});

test('readback is bounded, duplicate text is coalesced, and restart does not accumulate gaps as time', () => {
  const s = new CaptureSession({ maxVisits: 2, maxSamples: 2 }); s.start(1);
  s.accept(focus(0, 1, 'A'));
  for (let i = 1; i <= 4; i++) s.accept(text(i, 1, 'A', String(i)));
  s.accept(text(5, 1, 'A', '4'));
  assert.deepEqual(s.visits[0].samples.map(c => c.text), ['3', '4']);
  s.accept(focus(10, 2, 'B')); s.stop(20); s.start(2);
  s.accept({ ...focus(100, 1, 'C'), epoch: 2 });
  assert.deepEqual(s.visits.map(v => v.title), ['B', 'C']);
  assert.equal(s.visits[0].end, 20);
});

test('late coverage gaps discard later visits and samples even after pause, without crossing epochs', () => {
  const s = new CaptureSession(); s.start(1);
  s.accept(focus(0, 1, 'A'));
  s.accept(text(10, 1, 'A', 'reliable'));
  s.accept(text(800, 1, 'A', 'unreliable'));
  s.accept(focus(1000, 2, 'B'));
  s.stop(5000);
  assert.equal(s.loseCoverage(1, 750), true);
  assert.deepEqual(s.visits.map(v => [v.title, v.end, v.samples.map(sample => sample.text)]), [['A', 750, ['reliable']]]);
  assert.equal(s.recording, false);
  assert.equal(s.counts.textUpdates, 2); // Cumulative extraction count, not retained samples.
  assert.equal(feedback(s).counts.withText, 1);
  s.clear(); s.start(2); s.accept({ ...focus(6000, 1, 'B'), epoch: 2 });
  assert.equal(s.loseCoverage(1, 750), false);
  assert.equal(s.recording, true);
  assert.equal(s.visits[0].end, null);
});

test('feedback is an allowlisted summary, never a dump of session/native/error state', () => {
  const s = new CaptureSession(); s.start(1);
  s.accept({ ...focus(0, 1, 'PRIVATE_ID'), title: 'SECRET TITLE' });
  s.accept(text(1, 1, 'PRIVATE_ID', 'SECRET TEXT https://private.invalid'));
  const f = feedback(s, { build: 'a'.repeat(64), platform: 'darwin', arch: 'arm64', helper: 'ready', code: 'OK', secret: 'SECRET TOKEN', diagnostics: [
    { line: 12, column: 4, code: 'CS0103', message: 'SECRET compiler path' },
    { line: 7, column: 2, code: 'SECRET error content' },
    { line: 9, column: 1, code: { toString: 'SECRET malformed code' } },
  ] });
  const serialized = JSON.stringify(f);
  assert.ok(!serialized.includes('SECRET'));
  assert.ok(!serialized.includes('PRIVATE_ID'));
  assert.deepEqual(f.buildDiagnostics, [{ line: 12, column: 4, code: 'CS0103' }]);
  assert.equal(f.counts.visits, 1);
  assert.equal(f.counts.withText, 1);
  assert.equal(f.nativeAcceptance, 'not-validated');
  assert.equal(feedback(s, { code: '/Users/SECRET/crash.log' }).stage.code, 'UNKNOWN');
});
