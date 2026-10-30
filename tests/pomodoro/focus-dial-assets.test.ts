import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {portalCss, portalHtml} from '../../core/account/portal/page.js';
import {focusDialCss} from '../../core/pomodoro/focus-dial-style.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {spindleUiCss} from '../../core/ui/styles.js';
import {focusDialFonts} from '../../tools/focus-dial-fonts.js';
import {portalBundleModules, portalWebFiles} from '../../core/account/portal/web-manifest.js';

// Actual served portal assets over HTTP from the compiled build. Linux/Node structural proof only.
const build = new URL('../../', import.meta.url);
async function served<T>(run: (origin: string) => Promise<T>): Promise<T> {
  const scratch = resolve('.local/portal-tests');
  mkdirSync(scratch, {recursive: true});
  const directory = mkdtempSync(join(scratch, 'focus-dial-')), key = Buffer.alloc(32, 134);
  const server = await startTrackingServer(directory, key);
  try { return await run(server.origin); } finally { await server.close(); key.fill(0); rmSync(directory, {recursive: true, force: true}); }
}

test('portal CSS is the shared UI, then legacy rules, then the dial, and links the font sheet', () => {
  assert.ok(portalCss.startsWith(spindleUiCss));
  assert.ok(portalCss.endsWith(focusDialCss + '\n'));
  assert.ok(portalCss.indexOf(spindleUiCss) < portalCss.indexOf('.portal-shell{') && portalCss.indexOf('.portal-shell{') < portalCss.indexOf(focusDialCss));
  // The app shell now links the approved design files; the legacy sheet stays served for the older view modules.
  assert.match(portalHtml, /<link rel="stylesheet" href="\/portal\/web\/fonts\.css"><link rel="stylesheet" href="\/portal\/web\/spindle\.css">/);
});

test('served: shared UI + renderer modules, font sheet, fonts allowlist, font-src CSP', async () => {
  await served(async origin => {
    for (const path of ['/portal/code/pomodoro/focus-dial.js', '/portal/code/ui/dom.js']) {
      const r = await fetch(origin + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type')!, /javascript/);
      assert.match(r.headers.get('content-security-policy')!, /font-src 'self'/);
    }
    // Node-only modules stay unreachable; only browser modules are allowlisted.
    for (const path of ['/portal/code/pomodoro/focus-dial-style.js', '/portal/code/ui/emit.js', '/portal/code/ui/styles.js', '/portal/code/ui/theme.js', '/portal/fonts/../build.json', '/portal/fonts/nothing.woff2']) assert.equal((await fetch(origin + path)).status, 404, path);
    const sheet = await (await fetch(origin + '/portal/fonts.css')).text();
    assert.equal([...sheet.matchAll(/@font-face/g)].length, 2);
    const build = await (await fetch(origin + '/portal/build')).json() as {fonts?: {status: string; files: {file: string; sha256: string}[]}};
    assert.ok(build.fonts, 'build identity records font staging');
    for (const font of focusDialFonts) {
      const r = await fetch(origin + '/portal/fonts/' + font.file);
      if (build.fonts.status === 'staged') {
        assert.equal(r.status, 200, font.file);
        assert.equal(r.headers.get('content-type'), font.type);
        assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'), font.sha256, font.file);
        assert.ok(build.fonts.files.some(f => f.file === font.file && f.sha256 === font.sha256));
      } else assert.equal(r.status, 404, font.file); // honest fallback: no font bytes, no fake claim
    }
  });
});

test('bundle fingerprint covers the shared UI, the dial renderer/styles, the allowlist and the fonts', async () => {
  const dir = new URL('core/', build);
  const record = JSON.parse(await readFile(new URL('account/portal/build.json', dir), 'utf8')) as {bundleSha256: string; fonts: {files: {file: string; sha256: string}[]}};
  const files = portalBundleModules;
  const hash = async (omit?: string) => {
    const h = createHash('sha256');
    for (const file of files) if (file !== omit) h.update(file + '\0').update(await readFile(new URL(file, dir)));
    for (const font of record.fonts.files) h.update(font.file + '\0' + font.sha256 + '\0');
    for (const file of portalWebFiles) h.update('web/' + file.path + '\0').update(await readFile(new URL('account/portal/web/' + file.path, dir)));
    return h.digest('hex');
  };
  assert.equal(await hash(), record.bundleSha256);
  for (const file of ['pomodoro/focus-dial.js', 'pomodoro/focus-dial-style.js', 'ui/theme.js', 'ui/styles.js', 'ui/dom.js']) assert.notEqual(await hash(file), record.bundleSha256, `${file} changes the displayed UI hash`);
});
