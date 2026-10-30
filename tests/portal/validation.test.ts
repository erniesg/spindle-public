import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectUpload } from '../../examples/application-portal/validation.js';
import { startPortal } from '../../examples/application-portal/server.js';
import { inventedPdf } from './fixtures.js';

test('rejects signature-only PDF, mislabelled MIME and malformed image metadata', () => {
  assert.deepEqual(inspectUpload(Buffer.from(inventedPdf()), 'application/pdf'), {});
  for (const [bytes, type] of [[Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf'], [Buffer.from(inventedPdf()), 'image/jpeg'], [Buffer.from([255,216,255,192,0,255,255,217]), 'image/jpeg'], [Buffer.from([137,80,78,71,13,10,26,10]), 'image/png']] as const) assert.throws(() => inspectUpload(bytes, type));
});

test('HTTP enforces configurable length/pattern and rejects malformed bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portal-validation-'));
  const portal = await startPortal(dir, { title: 'Invented', fields: [{ name: 'name', label: 'Name', required: true, minLength: 3, maxLength: 8, pattern: '[A-Z]+' }], attachments: [{ name: 'statement', label: 'PDF', required: true, type: 'application/pdf', maxBytes: 10000 }] });
  try {
    assert.match(await (await fetch(portal.origin)).text(), /minlength="3"/);
    for (const [name, bytes, status] of [['AB', inventedPdf(), 422], ['ABCDEFGHI', inventedPdf(), 422], ['abc', inventedPdf(), 422], ['ABC', '%PDF-1.4', 422], ['ABC', inventedPdf(), 303]] as const) {
      const body = new FormData(); body.set('name', name); body.set('idempotencyKey', name + bytes.length); body.set('statement', new Blob([bytes], { type: 'application/pdf' }), 'invented.pdf');
      assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body, redirect: 'manual' })).status, status);
    }
  } finally { await portal.close(); await rm(dir, { recursive: true, force: true }); }
});
