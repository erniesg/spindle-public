import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCheck } from '../../core/capture-check/app.js';

for (const packaged of [false, true]) {
  test(`Windows feedback hashes the ${packaged ? 'bundled reader ahead of the source fallback' : 'source reader when no bundled reader exists'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'spindle-helper-hash-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.local/native-windows'), { recursive: true });
    await writeFile(join(root, '.local/native-windows/SpindleCaptureCheck.exe'), 'synthetic source binary');
    await writeFile(join(root, 'capture-check.build.json'), JSON.stringify({ fingerprint: 'a'.repeat(64) }));
    if (packaged) {
      await mkdir(join(root, 'runtime'));
      await writeFile(join(root, 'runtime/SpindleCaptureCheck.exe'), 'synthetic bundled binary');
    }
    // Simulate path selection only. No Windows binary or native API is executed.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(platform);
    let check;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      check = await createCheck({ root, launch: (_root, _fixture, emit) => {
        queueMicrotask(() => emit({ kind: 'ready', permission: true }));
        return { pid: 0, send() {}, stop() {} };
      } });
    } finally { Object.defineProperty(process, 'platform', platform); }
    t.after(() => check.close());
    const response = await fetch(check.origin + '/api/feedback', { headers: { Authorization: `Bearer ${check.token}` } });
    const report = await response.json();
    const expected = createHash('sha256').update(packaged ? 'synthetic bundled binary' : 'synthetic source binary').digest('hex');
    assert.equal(report.nativeHelperSha256, expected);
  });
}
