// DESIGN/COMPONENT PROOF, not authenticated product, extension install or native Mac acceptance.
// Serves the built primitives under a strict CSP with every other request blocked, checks
// real-browser semantics at workspace, desktop-window and compact-extension widths, and
// writes screenshots. Run after `npm run build`: node build/tests/ui/gallery.e2e.js
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {sharedUiStylesheet} from '../../core/ui/emit.js';
import {spindleUiCss} from '../../core/ui/styles.js';
import {tokens} from '../../core/ui/theme.js';

const origin = 'https://spindle-ui.invalid';
const output = resolve(process.env.SPINDLE_UI_GALLERY_OUTPUT ?? '.local/shared-ui134/gallery');
const executablePath = process.env.SPINDLE_CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`;
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Gallery-only layout adapter: placement and spacing tokens, never visual values.
const layoutCss = 'body{margin:0}main{display:grid;gap:var(--sp-space-4);padding:var(--sp-space-6)}.gallery-grid{display:grid;gap:var(--sp-space-4);grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start}.gallery-form{display:grid;gap:var(--sp-space-4)}';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spindle shared UI gallery</title><link rel="stylesheet" href="/${sharedUiStylesheet}"><link rel="stylesheet" href="/gallery.css"><body class="sp-theme"><main></main><script type="module" src="/tests/ui/gallery.js"></script></body></html>`;
const containers = [
  {name: 'workspace', width: 1280, height: 900},
  {name: 'desktop-window', width: 960, height: 760},
  {name: 'compact-extension', width: 380, height: 760},
];
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const build = new URL('../../', import.meta.url);

await mkdir(output, {recursive: true});
const browser = await chromium.launch({executablePath, headless: true});
const blocked: string[] = [], problems: string[] = [];
try {
  // Reduced motion keeps computed colours/screenshots free of in-flight transitions.
  const context = await browser.newContext({deviceScaleFactor: 1, reducedMotion: 'reduce'});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {blocked.push(url.href); return route.abort();}
    const headers = {'content-security-policy': csp, 'x-content-type-options': 'nosniff'};
    if (url.pathname === '/') return route.fulfill({status: 200, headers, contentType: 'text/html; charset=utf-8', body: html});
    if (url.pathname === `/${sharedUiStylesheet}`) return route.fulfill({status: 200, headers, contentType: 'text/css', body: spindleUiCss});
    if (url.pathname === '/gallery.css') return route.fulfill({status: 200, headers, contentType: 'text/css', body: layoutCss});
    if (/^\/(?:core\/ui|tests\/ui)\/[a-z]+\.js$/.test(url.pathname)) return route.fulfill({status: 200, headers, contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice(1), build))});
    blocked.push(url.href); return route.abort();
  });
  const page = await context.newPage();
  page.on('console', message => {if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text());});
  page.on('pageerror', error => problems.push(String(error)));

  for (const container of containers) {
    await page.setViewportSize({width: container.width, height: container.height});
    await page.goto(`${origin}/`);
    await page.waitForSelector('body[data-ready=true]');
    await page.mouse.move(0, 0);

    const name = page.getByLabel('Account name'), password = page.getByLabel('Password');
    assert.equal(await name.getAttribute('type'), 'text');
    assert.equal(await password.getAttribute('type'), 'password');
    assert.equal(await password.evaluate(input => document.getElementById(input.getAttribute('aria-describedby')!)?.textContent), 'At least 12 characters.');
    assert.equal(await page.getByRole('button', {name: 'Sign in'}).getAttribute('type'), 'submit');
    assert.equal(await page.getByRole('button', {name: 'Create account'}).getAttribute('type'), 'button');
    assert.equal(await page.getByRole('region', {name: 'Sync'}).count(), 1);
    assert.equal(await page.getByRole('status').count(), 4);
    assert.ok(await page.getByLabel('Device name').isDisabled());
    assert.ok(await page.getByRole('button', {name: 'Continue'}).isDisabled());

    // Provider text is shown literally; nothing was parsed into an element.
    assert.match(await page.locator('.sp-status[data-state=error]').textContent() ?? '', /<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('img').count(), 0);

    // The rendered values are the single theme source, not a per-surface palette.
    const primary = page.getByRole('button', {name: 'Sign in'});
    assert.equal(await primary.evaluate(node => getComputedStyle(node).backgroundColor), rgb(tokens['--sp-action']));
    assert.equal(await primary.evaluate(node => getComputedStyle(node).color), rgb(tokens['--sp-on-action']));
    assert.equal(await page.locator('.sp-card').first().evaluate(node => getComputedStyle(node).borderTopColor), rgb(tokens['--sp-line']));
    assert.equal(await page.locator('.sp-card-title').first().evaluate(node => getComputedStyle(node).fontWeight), '500', 'card title keeps its primitive weight inside .sp-theme');
    assert.equal(await page.locator('.sp-status[data-state=error]').evaluate(node => getComputedStyle(node).color), rgb(tokens['--sp-status-error-ink']));
    assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /^"DM Sans", Arial, sans-serif$/);

    // Keyboard order skips disabled controls and shows the shared focus ring.
    await page.locator('body').click({position: {x: 1, y: 1}});
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => {const node = document.activeElement as HTMLElement; return node === document.body ? 'BODY' : node.getAttribute('name') ?? node.textContent!;}));
    }
    assert.deepEqual(order, ['name', 'password', 'Sign in', 'Create account', 'Sync now', 'Details', 'BODY']);
    await page.keyboard.press('Shift+Tab');
    const ring = await page.evaluate(() => {const style = getComputedStyle(document.activeElement!); return [style.outlineStyle, style.outlineWidth, style.outlineColor];});
    assert.deepEqual(ring, ['solid', tokens['--sp-focus-width'], rgb(tokens['--sp-focus'])]);

    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${container.name} has no horizontal overflow`);
    await page.screenshot({path: resolve(output, `${container.name}-${container.width}.png`), fullPage: true});

    // A surface adapter drives loading/disabled through the same primitives.
    await page.getByLabel('Account name').fill('invented-tester');
    await page.getByLabel('Password').fill('invented-password-only');
    await page.getByRole('button', {name: 'Sign in'}).click();
    const status = page.getByRole('region', {name: 'Sign in'}).getByRole('status');
    assert.equal(await status.getAttribute('data-state'), 'loading');
    assert.equal(await status.textContent(), 'Signing in…');
    assert.ok(await page.getByRole('button', {name: 'Sign in'}).isDisabled());
    await page.getByRole('region', {name: 'Sign in'}).screenshot({path: resolve(output, `${container.name}-${container.width}-signing-in.png`)});
  }
  assert.deepEqual(blocked, [], 'no request left the gallery origin');
  assert.deepEqual(problems, [], 'no CSP violation or page error');
  let source = 'unbound', dirty = true;
  try {source = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); dirty = execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).length > 0;} catch {/* copied build */}
  const record = {label: 'DESIGN/COMPONENT PROOF: invented data; not authenticated product, extension install or native Mac acceptance', source, sourceDirty: dirty, browser: `Chromium ${browser.version()} headless (Linux)`, csp, containers, capturedAt: new Date().toISOString()};
  await writeFile(resolve(output, 'record.json'), JSON.stringify(record, null, 1) + '\n');
  console.log(JSON.stringify({result: 'gallery semantics passed at every width', output, ...record}));
} finally {await browser.close();}
