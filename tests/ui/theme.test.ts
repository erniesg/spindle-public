import assert from 'node:assert/strict';
import test from 'node:test';
import {themeCss, tokens, type Token} from '../../core/ui/theme.js';
import {primitiveCss, spindleUiCss} from '../../core/ui/styles.js';
import {paletteLiterals} from './guards.js';

// Independently pinned from the approved export (palette.js goldgraphite roles and
// statusColours, evaluated with a fresh profile). A drift here is a design change.
const approved: Partial<Record<Token, string>> = {
  '--sp-ink': '#23272f', '--sp-muted': '#5d6471', '--sp-paper': '#ffffff', '--sp-surface': '#f7f7f7', '--sp-line': '#e1e3e1',
  '--sp-action': '#303642', '--sp-action-hover': '#282d37', '--sp-action-pressed': '#22262e', '--sp-action-tint': '#e2e3e5',
  '--sp-action-soft': '#f1f1f2', '--sp-on-action': '#ffffff', '--sp-focus': '#303642', '--sp-border-hover': '#72767e',
  '--sp-accent': '#f3ce36', '--sp-accent-ink': '#7c6200',
  '--sp-status-working-ink': '#315f93', '--sp-status-working-surface': '#eef4fb',
  '--sp-status-success-ink': '#24613f', '--sp-status-success-surface': '#edf6ef',
  '--sp-status-error-ink': '#a73535', '--sp-status-error-surface': '#fff0ee',
  '--sp-font': "'DM Sans', Arial, sans-serif", '--sp-display-font': "'Instrument Serif', Georgia, serif",
  '--sp-control-size': '14px', '--sp-body-size': '16px', '--sp-radius-sm': '7px', '--sp-radius-md': '12px', '--sp-control-height': '38px',
};

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * r! + .7152 * g! + .0722 * b!;
};
const contrast = (a: Token, b: Token) => {
  const [x, y] = [luminance(tokens[a]), luminance(tokens[b])].sort((p, q) => q - p);
  return (x! + .05) / (y! + .05);
};

test('theme keeps the owner-approved graphite/lemon-gold palette and app typography', () => {
  for (const [name, value] of Object.entries(approved)) assert.equal(tokens[name as Token], value, name);
});

test('text, action and status pairs meet WCAG AA contrast; focus ring is visible', () => {
  for (const [text, surface] of [
    ['--sp-ink', '--sp-paper'], ['--sp-muted', '--sp-paper'], ['--sp-ink', '--sp-surface'], ['--sp-action', '--sp-paper'],
    ['--sp-on-action', '--sp-action'], ['--sp-on-action', '--sp-action-hover'], ['--sp-accent-ink', '--sp-paper'],
    ['--sp-status-neutral-ink', '--sp-status-neutral-surface'], ['--sp-status-working-ink', '--sp-status-working-surface'],
    ['--sp-status-success-ink', '--sp-status-success-surface'], ['--sp-status-error-ink', '--sp-status-error-surface'],
  ] as const) assert.ok(contrast(text, surface) >= 4.5, `${text} on ${surface}: ${contrast(text, surface).toFixed(2)}`);
  assert.ok(contrast('--sp-focus', '--sp-paper') >= 3);
});

test('every token is one inert declaration in the shared :root block', () => {
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(name, /^--sp-[a-z0-9-]+$/);
    assert.doesNotMatch(value, /[;{}<>\\]|url\(|@import/i, name);
    assert.equal(themeCss.split(`${name}:`).length, 2, `${name} declared once`);
  }
  assert.ok(spindleUiCss.startsWith(themeCss));
  assert.doesNotMatch(spindleUiCss, /url\(|@import|@font-face|https?:/i, 'no fonts or network fetches');
});

test('primitives reference only defined theme tokens and carry no second palette', () => {
  assert.deepEqual(paletteLiterals(primitiveCss), []);
  const used = new Set([...primitiveCss.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]!));
  for (const name of used) assert.ok(Object.hasOwn(tokens, name), `${name} is a theme token`);
  for (const name of ['--sp-action', '--sp-focus', '--sp-disabled-opacity', '--sp-status-error-ink', '--sp-status-working-ink']) assert.ok(used.has(name), name);
});

test('the palette guard catches a primitive that hard-codes its own colours or fonts', () => {
  assert.deepEqual(paletteLiterals('.x{color:#283b35;background:rgb(1,2,3);border-color:white;font-family:Georgia}'), ['#283b35', 'rgb(', 'white', 'Georgia']);
  assert.deepEqual(paletteLiterals('.x{color:var(--sp-ink);border-right-color:transparent;content:""}'), []);
  // Representative causal cases: a property name is not a colour; ordinary names, a bare quoted family and a token override are.
  assert.deepEqual(paletteLiterals('.x{white-space:pre-wrap;border-color:var(--sp-line)}'), []);
  assert.deepEqual(paletteLiterals('.x{color:teal;border-color:navy;font-family:\'DM Sans\'}'), ['teal', 'navy', "font-family:'"]);
  assert.deepEqual(paletteLiterals('.x{--sp-accent:var(--sp-ink)}'), ['--sp-accent:']);
});
