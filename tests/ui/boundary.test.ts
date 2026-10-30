import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {emitSharedUi, sharedUiModules, sharedUiStylesheet} from '../../core/ui/emit.js';
import {spindleUiCss} from '../../core/ui/styles.js';

const source = new URL('../../../core/ui/', import.meta.url);
const nodeOnly = new Set(['emit.ts']);
// from-imports, dynamic imports and bare side-effect imports (`import 'x';`).
const imports = (code: string) => [...code.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map(match => match[1] ?? match[2] ?? match[3]!);
// Effects and HTML sinks that a visual primitive must never own.
const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|srcdoc|\beval\(|new Function|\.style\b|setAttribute\(\s*['"](?:style|on)|\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|\bchrome\.|\bwebkit\.|setTimeout|setInterval|\bprocess\.|\brequire\(/;

test('browser primitives import only each other and own no effects or HTML sinks', async () => {
  const files = (await readdir(source)).filter(name => name.endsWith('.ts'));
  // Life dial is a separately mounted canvas component, not part of the emitted primitive bundle.
  const canvas = new Set(['life-dial.ts', 'life-dial-geometry.ts', 'life-dial-style.ts']);
  const browser = files.filter(name => !nodeOnly.has(name) && !canvas.has(name));
  assert.deepEqual(browser.sort(), ['dom.ts', 'styles.ts', 'theme.ts']);
  for (const name of browser) {
    const code = await readFile(new URL(name, source), 'utf8');
    for (const specifier of imports(code)) assert.ok(/^\.\/[a-z]+\.js$/.test(specifier) && browser.includes(specifier.slice(2, -3) + '.ts'), `${name} imports ${specifier}`);
    assert.doesNotMatch(code, forbidden, name);
  }
});

test('the emitted surface bundle is the shared stylesheet plus a self-contained module set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spindle-ui-emit-'));
  try {
    assert.deepEqual(await emitSharedUi(directory), [sharedUiStylesheet, ...sharedUiModules]);
    assert.equal(await readFile(join(directory, sharedUiStylesheet), 'utf8'), spindleUiCss);
    for (const name of sharedUiModules) {
      for (const specifier of imports(await readFile(join(directory, name), 'utf8'))) assert.ok((sharedUiModules as readonly string[]).includes(specifier.slice(2)), `${name} -> ${specifier}`);
    }
    // The copied modules load from the surface root alone, before any DOM exists.
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const styles = await import(pathToFileURL(join(directory, 'styles.js')).href) as typeof import('../../core/ui/styles.js');
    const dom = await import(pathToFileURL(join(directory, 'dom.js')).href) as typeof import('../../core/ui/dom.js');
    assert.equal(styles.spindleUiCss, spindleUiCss);
    assert.deepEqual(Object.keys(dom).sort(), ['button', 'card', 'setStatus', 'statusRegion', 'textField']);
  } finally {await rm(directory, {recursive: true, force: true});}
});
