// Optional UI integration check. This injects invented provider events on every OS;
// screenshots/video are explicitly NOT evidence of native Mac/Windows capture.
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCheck } from '../../core/capture-check/app.js';
import type { NativeProcess, NativeLauncher, NativeMessage, NativeCommand } from '../../core/capture-check/types.js';
interface ReplayProcess extends NativeProcess { epoch: number; stopped: boolean; emit(event: NativeMessage): void }

const modulePath = process.env.SPINDLE_PLAYWRIGHT_PATH;
const { chromium }: typeof import('playwright-core') = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright-core');
const output = resolve(process.env.SPINDLE_CAPTURE_REVIEW_OUTPUT || '.local/capture-check-review');
await mkdir(output, { recursive: true });
const children: ReplayProcess[] = [];
const launch: NativeLauncher = (_root, fixture, emit, onExit) => {
  const child: ReplayProcess = { pid: fixture ? 202 : 101, epoch: 0, stopped: false, emit,
    send(command: NativeCommand) {
      if (command.action === 'start') {
        assert.equal(typeof command.epoch, 'number');
        if (command.epoch === undefined) throw new Error('MISSING_EPOCH');
        this.epoch = command.epoch;
        emit({ kind: 'focus', at: 0, epoch: this.epoch, revision: 1, key: 'fixture-A', title: 'Spindle Test A' });
        emit({ kind: 'text', at: 10, epoch: this.epoch, revision: 1, key: 'fixture-A', text: 'SPINDLE TEST A\nInvented learning example\nContent update: 1', status: 'ok' });
      }
    },
    stop() { if (!this.stopped) { this.stopped = true; onExit(); } },
  };
  children.push(child);
  queueMicrotask(() => emit({ kind: 'ready', at: 0, permission: true }));
  return child;
};
const check = await createCheck({ launch });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 980 }, recordVideo: { dir: output, size: { width: 1280, height: 980 } } });
const page = await context.newPage();
const video = page.video();
try {
  await page.goto(`${check.origin}/#${check.token}`);
  const environment = await page.locator('#environment').textContent();
  assert.match(environment ?? '', process.platform === 'linux' ? /NOT.*native|not a native/i : /Experimental native accessibility check/i);
  await page.locator('#manual').click();
  await page.waitForFunction(() => document.querySelector('#readable')?.textContent === '1');
  assert.match(await page.locator('#content').textContent() ?? '', /SPINDLE TEST A/);
  const helper = children[0];
  helper.emit({ kind: 'focus', at: 2000, epoch: helper.epoch, revision: 2, key: 'fixture-B', title: 'Spindle Test B' });
  helper.emit({ kind: 'text', at: 2010, epoch: helper.epoch, revision: 2, key: 'fixture-B', text: 'SPINDLE TEST B\nInvented leisure example', status: 'ok' });
  helper.emit({ kind: 'focus', at: 5000, epoch: helper.epoch, revision: 3, key: 'fixture-A', title: 'Spindle Test A' });
  const current = 'SPINDLE TEST A\nContent update: 2\n<script>window.untrustedCaptureExecuted = true</script>';
  helper.emit({ kind: 'text', at: 5010, epoch: helper.epoch, revision: 3, key: 'fixture-A', text: current, status: 'ok' });
  helper.emit({ kind: 'text', at: 5020, epoch: helper.epoch, revision: 1, key: 'fixture-A', text: 'STALE WRONG TEXT', status: 'ok' });
  await page.waitForFunction(() => document.querySelector('#visits')?.textContent === '3');
  await page.locator('.visit').first().click();
  assert.equal(await page.locator('#content').textContent(), current);
  assert.equal(await page.evaluate(() => 'untrustedCaptureExecuted' in window ? window.untrustedCaptureExecuted : undefined), undefined);
  const visible = 'SPINDLE TEST A\nInvented learning example\nContent update: 3\nThis text changes without switching windows.';
  helper.emit({ kind: 'text', at: 5030, epoch: helper.epoch, revision: 3, key: 'fixture-A', text: visible, status: 'ok' });
  await page.waitForFunction(() => document.querySelector('#content')?.textContent?.includes('Content update: 3'));
  await page.screenshot({ path: resolve(output, 'inspector-desktop-replay-not-native.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'inspector-mobile-replay-not-native.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 980 });
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Paused'));
  helper.emit({ kind: 'text', at: 5030, epoch: helper.epoch, revision: 3, key: 'fixture-A', text: 'AFTER PAUSE', status: 'ok' });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#content').textContent(), visible);
  await page.locator('#feedback').click();
  await page.locator('#feedback-dialog').waitFor({ state: 'visible' });
  const preview = await page.locator('#feedback-preview').inputValue();
  assert.ok(!preview.includes('SPINDLE TEST'));
  assert.ok(!preview.includes('fixture-A'));
  assert.equal(JSON.parse(preview).nativeAcceptance, 'not-validated');
  assert.equal(JSON.parse(preview).platform, process.platform);
  const download = page.waitForEvent('download');
  await page.locator('#save-feedback').click();
  assert.equal((await download).suggestedFilename(), `spindle-feedback-${process.platform}-${check.identity.fingerprint.slice(0, 12)}.json`);
  await page.locator('#close-feedback').click();
  await page.locator('#clear').click();
  await page.waitForFunction(() => document.querySelector('#visits')?.textContent === '0');
  assert.equal(children[1].stopped, true);
  await page.locator('#manual').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Recording'));
  helper.emit({ kind: 'coverageGap', at: 50, epoch: helper.epoch });
  await page.waitForFunction(() => document.querySelector('#help')?.textContent?.includes('last reliable observation'));
  assert.match(await page.locator('#status').textContent() ?? '', /^Paused/);
  await page.locator('#feedback').click();
  await page.locator('#feedback-dialog').waitFor({ state: 'visible' });
  assert.equal(JSON.parse(await page.locator('#feedback-preview').inputValue()).stage.code, 'WINDOWS_COVERAGE_GAP');
  await page.locator('#close-feedback').click();
  await page.locator('#manual').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Recording'));
  await page.locator('#quit').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Quit'));
  assert.equal(children[0].stopped, true);
  console.log(`Inspector journey passed: readback, rapid returns, inert text, pause, feedback, clear, coverage-gap explanation/retry and quit. Synthetic replay on ${process.platform} only; not native capture.`);
} finally {
  try {
    await context.close();
    assert.ok(video);
    const original = await video.path();
    await rename(original, resolve(output, 'inspector-replay-not-native.webm'));
  } finally { try { await browser.close(); } finally { check.close(); } }
}
