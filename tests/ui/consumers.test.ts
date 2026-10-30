import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {sharedUiStylesheet} from '../../core/ui/emit.js';
import {spindleUiCss} from '../../core/ui/styles.js';
import {paletteLiterals} from './guards.js';

// Desktop preview, Chrome options and blocking page checks are enforced (#134).
// Each check runs against the real build output and reports as `todo` until the
// consumer integrator migrates that surface and removes its `todo` option.
const build = new URL('../../', import.meta.url);
const pending = {todo: 'pending shared-UI consumer migration (#134)'};
const linksShared = async (page: string) => {
  const html = await readFile(new URL(page, build), 'utf8');
  const href = new RegExp(`<link rel="stylesheet" href="([^"]*${sharedUiStylesheet})">`).exec(html)?.[1];
  assert.ok(href, `${page} links the shared stylesheet`);
  assert.ok(!/<style[\s>]/.test(html), `${page} has no private inline palette`);
  // A packaged page bundles the file beside it; a root-relative href is a served route.
  if (!href.startsWith('/')) assert.equal(await readFile(new URL(href, new URL(page, build)), 'utf8'), spindleUiCss);
};

test('portal serves shared CSS, imports real shared primitives and has no private palette', async () => {
  const {portalCss} = await import('../../core/account/portal/page.js');
  assert.ok(portalCss.startsWith(spindleUiCss), 'portal CSS starts with the canonical theme and primitives');
  const {portalAsset} = await import('../../core/account/portal/assets.js');
  const asset = await portalAsset('/portal/code/ui/dom.js');
  assert.equal(asset?.type, 'text/javascript; charset=utf-8');
  assert.match(String(asset?.body), /export function button/);
  const consumer = await readFile(new URL('core/account/portal/pomodoro.js', build), 'utf8');
  assert.match(consumer, /from ['"]\.\.\/\.\.\/ui\/dom\.js['"]/);
  const literals = paletteLiterals(portalCss.replace(spindleUiCss, ''));
  assert.ok(literals.length === 0, `portal-only rules carry ${literals.length} palette/font literals`);
});

test('desktop preview controls link the shared stylesheet', () => linksShared('core/preview/index.html'));
test('Chrome extension options page links the bundled shared stylesheet', () => linksShared('browser-extension/preview/options.html'));
test('Chrome extension blocking page links the bundled shared stylesheet', () => linksShared('browser-extension/preview/blocking.html'));
