import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inventedPdf, inventedPng } from './fixtures.js';
import { startPortal } from '../../examples/application-portal/server.js';

test('PNG survives multipart unchanged; corrupt and mislabelled PNG never create receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portal-png-'));
  const portal = await startPortal(dir, { title: 'Invented PNG destination', fields: [], attachments: [{ name: 'image', label: 'Image', required: true, type: 'image/png', maxBytes: 10000 }] });
  try {
    const png = inventedPng(); const corrupt = Buffer.from(png); corrupt[45] = corrupt[45]! ^ 1;
    for (const [key, bytes, type, expected] of [['valid', png, 'image/png', 303], ['corrupt', corrupt, 'image/png', 422], ['mime', png, 'image/jpeg', 422], ['signature-only', png.subarray(0, 8), 'image/png', 422]] as const) {
      const body = new FormData(); body.set('idempotencyKey', key);
      body.set('image', new Blob([new Uint8Array(bytes)], { type }), 'invented.png');
      assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body, redirect: 'manual' })).status, expected);
      const id = createHash('sha256').update(key).digest('hex');
      assert.equal((await fetch(portal.origin + '/receipts/' + id)).status, expected === 303 ? 200 : 404);
      if (expected === 303) {
        const record = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'));
        assert.equal(record.files[0].sha256, createHash('sha256').update(png).digest('hex'));
        assert.deepEqual(await readFile(join(dir, record.files[0].sha256 + '.upload')), png);
      }
    }
  } finally { await portal.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real multipart persists bytes and receipt; lost response reconciles after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fictional-portal-'));
  let portal = await startPortal(dir, undefined, { loseResponseOnce: true });
  const form = (name = 'Invented Applicant') => {
    const body = new FormData(); body.set('name', name); body.set('idempotencyKey', 'invented-request-1');
    body.set('statement', new Blob([inventedPdf()], { type: 'application/pdf' }), 'fictional.pdf'); return body;
  };
  try {
    assert.match(await (await fetch(portal.origin)).text(), /multipart\/form-data/);
    assert.equal((await fetch(portal.origin, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
    const invalid = new FormData(); invalid.set('idempotencyKey', 'bad');
    assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body: invalid })).status, 422);
    await assert.rejects(fetch(portal.origin + '/applications', { method: 'POST', body: form() }));
    const id = createHash('sha256').update('invented-request-1').digest('hex');
    const before = await (await fetch(portal.origin + '/receipts/' + id)).text();
    assert.match(before, /Invented Applicant/);
    const record = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'));
    assert.equal(await readFile(join(dir, record.files[0].sha256 + '.upload'), 'utf8'), inventedPdf());
    await portal.close(); portal = await startPortal(dir);
    assert.equal(await (await fetch(portal.origin + '/receipts/' + id)).text(), before);
    assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body: form(), redirect: 'manual' })).status, 303);
    assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body: form('Different'), redirect: 'manual' })).status, 409);
  } finally { await portal.close(); await rm(dir, { recursive: true, force: true }); }
});


test('configured RGB PNG photo persists; dimension, RGBA and photo byte failures have no receipt', async () => {
  const png = inventedPng();
  for (const scenario of [
    { key: 'rgb', bytes: png, width: 1, maxBytes: 10000, status: 303 },
    { key: 'dimensions', bytes: png, width: 2, maxBytes: 10000, status: 422 },
    { key: 'rgba', bytes: inventedPng(true), width: 1, maxBytes: 10000, status: 422 },
    { key: 'photo-bytes', bytes: png, width: 1, maxBytes: png.length - 1, status: 422 }
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'portal-photo-'));
    const portal = await startPortal(dir, { title: 'Configured photo', fields: [],
      attachments: [{ name: 'portrait', label: 'Portrait', required: true, type: 'image/png', maxBytes: 10000, photo: true }],
      photo: { width: scenario.width, height: 1, background: 'white (not verified)', maxBytes: scenario.maxBytes } });
    try {
      const body = new FormData(); body.set('idempotencyKey', scenario.key);
      body.set('portrait', new Blob([new Uint8Array(scenario.bytes)], { type: 'image/png' }), 'portrait.png');
      assert.equal((await fetch(portal.origin + '/applications', { method: 'POST', body, redirect: 'manual' })).status, scenario.status);
      const id = createHash('sha256').update(scenario.key).digest('hex');
      assert.equal((await fetch(portal.origin + '/receipts/' + id)).status, scenario.status === 303 ? 200 : 404);
      if (scenario.status === 303) {
        const record = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'));
        assert.equal(record.files[0].sha256, createHash('sha256').update(png).digest('hex'));
        assert.deepEqual(await readFile(join(dir, record.files[0].sha256 + '.upload')), png);
      } else await assert.rejects(readFile(join(dir, id + '.json')), { code: 'ENOENT' });
    } finally { await portal.close(); await rm(dir, { recursive: true, force: true }); }
  }
});
