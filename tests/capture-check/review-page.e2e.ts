// Optional operator check against an explicitly shared private saved-media page.
// No capture app/device connection or upload is performed. Never print signed URLs.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium }: typeof import('playwright-core') = await import(process.env.SPINDLE_PLAYWRIGHT_PATH ? pathToFileURL(resolve(process.env.SPINDLE_PLAYWRIGHT_PATH)).href : 'playwright-core');
const share: { viewer: string } = JSON.parse(await readFile(process.env.SPINDLE_REVIEW_SHARE || '.local/capture-check-review/private-review-share.json', 'utf8'));
const output = resolve('.local/private-viewer-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let step = 'open review page';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(share.viewer, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('.note').textContent() ?? '', /sample data.*Mac or Windows/i);
  assert.equal(await page.locator('details').evaluate(el => { if (!(el instanceof HTMLDetailsElement)) throw new Error('EXPECTED_DETAILS'); return el.open; }), false);
  step = 'play saved recording inline';
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await page.locator('video').evaluate(video => { if (!(video instanceof HTMLVideoElement)) throw new Error('EXPECTED_VIDEO'); video.muted = true; return video.play(); });
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.1);
  await page.locator('video').evaluate(video => { if (!(video instanceof HTMLVideoElement)) throw new Error('EXPECTED_VIDEO'); video.pause(); });
  await page.screenshot({ path: resolve(output, 'recording-view.png'), fullPage: true });
  step = 'switch to desktop screenshot';
  await page.getByRole('button', { name: 'Desktop screenshot' }).click();
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('#screen')?.naturalWidth ?? 0) > 0);
  assert.equal(await page.locator('video').isVisible(), false);
  step = 'switch to phone screenshot without overflow';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Phone layout' }).click();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('#screen')?.naturalWidth === 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.downloads a').count(), 5);
  await page.screenshot({ path: resolve(output, 'phone-view.png'), fullPage: true });
  step = 'return to recording and open technical details';
  await page.getByRole('button', { name: 'Watch walkthrough' }).click();
  assert.equal(await page.locator('video').isVisible(), true);
  await page.getByText('Technical details', { exact: true }).click();
  assert.equal(await page.locator('details').evaluate(el => { if (!(el instanceof HTMLDetailsElement)) throw new Error('EXPECTED_DETAILS'); return el.open; }), true);
  console.log('Private review page passed: inline video playback, screenshot switches, phone layout, downloads and collapsed technical details. Saved media only, not native capture.');
} catch {
  console.error(`Private viewer check failed at: ${step}. No signed URL printed.`);
  process.exitCode = 1;
} finally { await browser.close(); }
