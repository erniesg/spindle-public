import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {DIAL, createFocusDial, dialOffset, formatClock, stateLabel} from '../../core/pomodoro/focus-dial.js';
import {focusDialCss, focusDialFontFaceCss} from '../../core/pomodoro/focus-dial-style.js';
import {tokens} from '../../core/ui/theme.js';
import {paletteLiterals} from '../ui/guards.js';

// Node has no DOM: this labelled double records exactly what the renderer asks of a document.
class Node_ {
  className = ''; textContent = ''; children: Node_[] = []; attributes = new Map<string, string>();
  constructor(readonly tag: string, readonly ns?: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: Node_[]) { this.children.push(...nodes); }
}
const fakeDocument = (namespaced: boolean) => ({
  createElement: (tag: string) => new Node_(tag),
  ...(namespaced ? {createElementNS: (ns: string, tag: string) => new Node_(tag, ns)} : {}),
}) as unknown as Document;
const find = (node: Node_, test: (n: Node_) => boolean): Node_ | undefined => test(node) ? node : node.children.map(c => find(c, test)).find(Boolean);

test('ring geometry is the approved lock-in.js circle, not a new generic ring', () => {
  assert.deepEqual({...DIAL}, {viewBox: 300, centre: 150, radius: 141, pathLength: 1});
  const dial = createFocusDial(fakeDocument(true));
  const root = dial.root as unknown as Node_;
  const svg = find(root, n => n.tag === 'svg')!;
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.get('viewBox'), '0 0 300 300');
  assert.equal(svg.attributes.get('aria-hidden'), 'true');
  const circles = svg.children;
  assert.equal(circles.length, 2);
  for (const c of circles) assert.deepEqual([c.attributes.get('cx'), c.attributes.get('cy'), c.attributes.get('r')], ['150', '150', '141']);
  const progress = circles[1]!;
  assert.equal(progress.attributes.get('class'), 'fd-progress');
  assert.equal(progress.attributes.get('pathLength'), '1');
  assert.equal(progress.attributes.get('stroke-dasharray'), '1');
  assert.equal(progress.attributes.get('stroke-dashoffset'), '1');
  // Classes on SVG nodes use the attribute (className is read-only there); no inline style anywhere.
  assert.ok(![svg, ...circles].some(n => n.className !== '' || n.attributes.has('style')));
});

test('progress is remaining/duration of the actual phase and never guessed', () => {
  assert.equal(dialOffset(25 * 60000, 25 * 60000), 1);
  assert.equal(dialOffset(0, 5 * 60000), 0);
  assert.equal(dialOffset(75000, 300000), 0.25);
  assert.equal(dialOffset(-5, 300000), 0);
  assert.equal(dialOffset(400000, 300000), 1);
  for (const [remaining, total] of [[undefined, 1000], [1000, undefined], [1000, 0], [1000, -1], [Number.NaN, 1000], [1000, Number.NaN]] as const) assert.equal(dialOffset(remaining, total), 1);
  assert.equal(formatClock(120000), '02:00');
  assert.equal(formatClock(1), '00:01');
  assert.equal(formatClock(-4), '00:00');
  assert.equal(formatClock(61000), '01:01');
});

test('update paints supplied values only, and an unloaded timer shows a dash, not 25:00', () => {
  for (const namespaced of [true, false]) {
    const dial = createFocusDial(fakeDocument(namespaced));
    const root = dial.root as unknown as Node_;
    const time = find(root, n => n.className.split(' ').includes('pomodoro-countdown'))!;
    const phase = find(root, n => n.className.split(' ').includes('pomodoro-phase'))!;
    const progress = find(root, n => n.attributes.get('class') === 'fd-progress')!;
    assert.equal(time.attributes.get('role'), 'timer');
    assert.equal(time.attributes.get('aria-label'), 'Remaining time');
    dial.update({});
    assert.deepEqual([time.textContent, phase.textContent, progress.attributes.get('stroke-dashoffset')], ['—', 'Focus', '1.0000']);
    dial.update({phase: 'break', status: 'running', remainingMs: 60000, totalMs: 240000});
    assert.deepEqual([time.textContent, phase.textContent, progress.attributes.get('stroke-dashoffset')], ['01:00', 'Break', '0.2500']);
  }
});

test('state labels follow the approved wording and never claim an automatic break', () => {
  assert.equal(stateLabel({}), 'Timer not loaded');
  assert.equal(stateLabel({status: 'idle', phase: 'focus'}), 'Ready when you are');
  assert.equal(stateLabel({status: 'running', phase: 'focus'}), 'In focus');
  assert.equal(stateLabel({status: 'running', phase: 'break'}), 'Take a breather');
  assert.equal(stateLabel({status: 'paused', phase: 'focus'}), 'Paused');
  assert.equal(stateLabel({status: 'completed', phase: 'focus'}), 'Phase complete');
  assert.doesNotMatch(focusDialCss + stateLabel({status: 'completed'}), /automatic/i);
});

test('dial styles use shared tokens only: no palette, no token override, every var is defined', () => {
  assert.deepEqual(paletteLiterals(focusDialCss), []);
  const defined = new Set(Object.keys(tokens));
  const used = new Set([...focusDialCss.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]!));
  assert.ok(used.size > 10);
  for (const name of used) assert.ok(defined.has(name), `${name} is not a shared token`);
  assert.doesNotMatch(focusDialCss, /style=|@import|url\(/);
});

test('font-face rules serve only the two local approved files', () => {
  assert.deepEqual([...focusDialFontFaceCss.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]), ['/portal/fonts/instrument.woff2', '/portal/fonts/dm-sans-normal.woff2']);
  // The token stacks name exactly these families.
  assert.match(tokens['--sp-font'], /^'DM Sans'/);
  assert.match(tokens['--sp-display-font'], /^'Instrument Serif'/);
});

test('renderer is browser-safe and pure: no timers, storage, network, HTML sinks or host imports', async () => {
  for (const name of ['focus-dial.ts', 'focus-dial-style.ts']) {
    const code = await readFile(new URL(`../../../core/pomodoro/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|\.style\b|setInterval|setTimeout|requestAnimationFrame|localStorage|sessionStorage|\bfetch\(|XMLHttpRequest|WebSocket|Date\.now|performance\.now|node:|\/home\/|\.local\//, name);
    assert.doesNotMatch(code, /^import /m, name);
  }
});

// Optional provenance check against the retained export: set SPINDLE_FOCUS_DIAL_FONT_SOURCE to its dist directory.
const source = process.env.SPINDLE_FOCUS_DIAL_FONT_SOURCE;
test('geometry and wording match the retained export files by hash', {skip: source ? false : 'retained export not provided (SPINDLE_FOCUS_DIAL_FONT_SOURCE)'}, async () => {
  const read = (name: string) => readFile(join(source!, name));
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const js = await read('lock-in.js'), css = await read('lock-in.css');
  assert.equal(sha(js), '3375ae0811c064994250cfa17ecd18ceba72392b4b1f6a7b875e8fbbd6c50de7');
  assert.equal(sha(css), 'fde2f0fd34c236aea8ba3d24709fc394e54013aff9519cd764385523b3224cf2');
  const text = js.toString();
  assert.ok(text.includes(`viewBox="0 0 ${DIAL.viewBox} ${DIAL.viewBox}"`));
  assert.equal(text.match(new RegExp(`cx="${DIAL.centre}" cy="${DIAL.centre}" r="${DIAL.radius}"`, 'g'))?.length, 2);
  assert.ok(text.includes('pathLength="1" stroke-dasharray="1"'));
  assert.ok(text.includes('M.remaining(s)/s.durationMs'));
  for (const label of ['Ready when you are', 'In focus', 'Take a breather', 'Paused']) assert.ok(text.includes(label), label);
  assert.match(css.toString(), /\.li-clock\{height:236px;width:236px/);
  assert.match(css.toString(), /\.li-timer-ring\{[^}]*stroke-width:\.8/);
  assert.match(css.toString(), /\.li-timer-progress\{stroke:var\(--sp-action\);stroke-width:2;stroke-linecap:round/);
});
