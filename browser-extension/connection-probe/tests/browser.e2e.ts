// Actual Linux Chromium Native Messaging; never opens/enrolls a personal profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'linux') throw new Error('This disposable registration probe currently supports Linux only.');
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.SPINDLE_PLAYWRIGHT_PATH;
const { chromium }: typeof import('playwright-core') = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright-core');
await mkdir('.local', { recursive: true });
const output = await mkdtemp(resolve('.local/browser-connection-'));
const extension = join(output, 'extension'), profile = join(output, 'profile'), xdg = join(output, 'xdg-config');
const launcher = join(output, 'native-host'), pidsFile = join(output, 'host-pids.txt');
const registration = join(profile, 'NativeMessagingHosts', 'ai.berlayar.spindle.connection_probe.json');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const record = process.env.SPINDLE_PROBE_RECORD === '1';
let context, receipt;
try {
  await cp(join(base, 'extension'), extension, { recursive: true });
  const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
  const extensionId = createHash('sha256').update(publicKey).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ ...manifest, key: publicKey.toString('base64') }));
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(pidsFile)}\nexec ${quote(process.execPath)} ${quote(join(base, 'host.js'))} "$@"\n`, { mode: 0o700 });
  await mkdir(dirname(registration), { recursive: true });
  const registrationBytes = JSON.stringify({ name: 'ai.berlayar.spindle.connection_probe', description: 'Disposable Spindle connection probe', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] });
  await writeFile(registration, registrationBytes);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.SPINDLE_CHROMIUM_EXECUTABLE || undefined,
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
    viewport: { width: 1100, height: 820 },
    ...(record ? { recordVideo: { dir: join(output, 'media'), size: { width: 1100, height: 820 } } } : {}),
  });
  const page = context.pages()[0] || await context.newPage();
  const hold = () => page.waitForTimeout(record ? 4500 : 0);
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await hold();
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Local round trip verified');
  await page.screenshot({ path: join(output, 'connected.png') }); await hold();
  await page.locator('#reject').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Incompatible version rejected');
  await page.screenshot({ path: join(output, 'rejected.png') }); await hold();
  await page.locator('#disconnect').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Local connection closed');
  await hold();
  const startsBeforeDenied = (await readFile(pidsFile, 'utf8')).trim().split('\n').length;
  await writeFile(registration, JSON.stringify({ ...JSON.parse(registrationBytes), allowed_origins: [`chrome-extension://${'b'.repeat(32)}/`] }));
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Local host unavailable');
  assert.equal((await readFile(pidsFile, 'utf8')).trim().split('\n').length, startsBeforeDenied, 'Chromium must reject an unlisted extension before starting the host');
  await hold();
  await rm(registration);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Local host unavailable');
  await page.screenshot({ path: join(output, 'unavailable.png') }); await hold();
  await writeFile(registration, registrationBytes);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Local round trip verified');
  await hold();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'phone.png') });
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.locator('#disconnect').click(); await hold();
  const browser = context.browser(); assert.ok(browser);
  receipt = { cleanupVerified: false, schema: 'spindle-browser-probe-receipt/v1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), platform: process.platform, arch: process.arch, browser: browser.version(), node: process.versions.node, scope: 'real disposable Chromium-to-local-process Native Messaging; no capture', checks: ['handshake', 'unsupported-version rejection', 'disconnect', 'extension allowlist rejection', 'missing registration', 'reconnect', '390px layout'], nativeMacWindowsAcceptance: false, recorded: record };
} finally {
  const failures = [];
  try { await context?.close(); } catch { failures.push('browser close'); }
  const pids = (await readFile(pidsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  let live = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    live = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!live.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (live.length) failures.push('native host exit');
  // Attempt every cleanup even if browser close or another removal fails.
  const removed = await Promise.allSettled([profile, extension, launcher, xdg, ...(live.length ? [] : [pidsFile])].map(path => rm(path, { recursive: true, force: true })));
  if (removed.some(result => result.status === 'rejected')) failures.push('task file cleanup');
  if (failures.length) throw new Error(`Probe cleanup incomplete: ${failures.join(', ')}. Inspect the bounded task directory.`);
}
receipt.cleanupVerified = true;
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log('Real Native Messaging journey and cleanup passed. Local output:', output);
