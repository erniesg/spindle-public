// Run after npx tsc: node tests/portal/browser.mjs. Uses existing playwright-core only.
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startPortal } from '../../build/examples/application-portal/server.js';
import { inventedPdf } from '../../build/tests/portal/fixtures.js';
const root = new URL('../../.local/portal-browser/', import.meta.url).pathname;
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'portal-browser-'));
const portal = await startPortal(directory);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(portal.origin);
  await page.getByLabel('Applicant name').fill('Invented Browser Applicant');
  await page.getByLabel('Fictional statement').setInputFiles({ name: 'invented.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inventedPdf()) });
  await page.screenshot({ path: join(root, 'filled-form.png'), fullPage: true });
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.waitForURL('**/receipts/**');
  const receipt = page.url(); const before = await page.locator('pre').textContent();
  assert.match(before, /Invented Browser Applicant/);
  await page.goto(portal.origin); await page.goto(receipt);
  assert.equal(await page.locator('pre').textContent(), before);
  await page.screenshot({ path: join(root, 'revisited-receipt.png'), fullPage: true });
  console.log(JSON.stringify({ receipt, artifacts: root, result: 'labelled fill, PDF upload, submit and receipt revisit passed' }));
} finally { await browser.close(); await portal.close(); await rm(directory, { recursive: true, force: true }); }
