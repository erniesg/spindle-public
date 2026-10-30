import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {focusDialFonts, stageFocusDialFonts} from '../../tools/focus-dial-fonts.js';

const scratch = () => { const base = resolve('.local/portal-tests'); mkdirSync(base, {recursive: true}); return mkdtempSync(join(base, 'fonts-')); };

test('font staging refuses wrong bytes and a missing explicit input, and reports absent without one', async () => {
  const root = scratch();
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'fonts'), {recursive: true});
    for (const font of focusDialFonts) writeFileSync(join(source, font.member), 'not the approved font');
    await assert.rejects(stageFocusDialFonts(root, join(root, 'out'), source), /FOCUS_DIAL_FONT_HASH_MISMATCH: instrument\.woff2/);
    await assert.rejects(stageFocusDialFonts(root, join(root, 'out'), join(root, 'nowhere')), /ENOENT/);
    assert.deepEqual(await stageFocusDialFonts(root, join(root, 'out'), ''), {status: 'absent', files: []});
    assert.throws(() => readFileSync(join(root, 'out/instrument.woff2')));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('the manifest names only the two approved faces plus the DM Sans licence', () => {
  assert.deepEqual(focusDialFonts.map(f => f.file), ['instrument.woff2', 'dm-sans-normal.woff2', 'dm-sans-OFL.txt']);
  assert.ok(focusDialFonts.every(f => /^[a-f0-9]{64}$/.test(f.sha256) && !f.member.startsWith('/')));
});
