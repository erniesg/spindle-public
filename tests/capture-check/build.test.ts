import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCheck } from '../../core/capture-check/app.js';

test('built inspector serves generated browser JavaScript and static assets', async t => {
  const check = await createCheck({ launch: (_root, _fixture, onEvent) => {
    queueMicrotask(() => onEvent({ kind: 'error', code: 'NATIVE_UNAVAILABLE' }));
    return { pid: 0, send() {}, stop() {} };
  } });
  t.after(check.close);
  const index = await fetch(check.origin).then(r => r.text());
  assert.match(index, /src="\/ui\.js"/);
  const script = await fetch(check.origin + '/ui.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await script.text(), await readFile('build/core/capture-check/ui.js', 'utf8'));
  assert.equal((await fetch(check.origin + '/style.css')).status, 200);
  const extension = await readFile('build/browser-extension/connection-probe/extension/index.html', 'utf8');
  assert.match(extension, /src="page\.js"/);
  assert.ok((await readFile('build/browser-extension/connection-probe/extension/page.js', 'utf8')).includes('connectNative'));
});
