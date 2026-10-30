// Development-only helper (Node, never shipped). Stages the two approved font files the focus dial
// needs from an explicit, hash-bound input: no network, no CDN, no binary in Git. Input is the
// `dist` directory of the retained owner-approved export (ui/prototype at 6a86395, export ba2f72a002,
// Sites v85), passed as SPINDLE_FOCUS_DIAL_FONT_SOURCE. Verified copies are kept in the ignored
// .local/focus-dial-fonts and emitted flat beside the portal modules. See docs/FOCUS_DIAL_UI.md.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

export interface FocusDialFont {file: string; member: string; sha256: string; type: string}
export const focusDialFonts: readonly FocusDialFont[] = [
  {file: 'instrument.woff2', member: 'instrument.woff2', sha256: '5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31', type: 'font/woff2'},
  {file: 'dm-sans-normal.woff2', member: 'fonts/dm-sans-normal.woff2', sha256: '9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543', type: 'font/woff2'},
  {file: 'dm-sans-OFL.txt', member: 'fonts/dm-sans-OFL.txt', sha256: '9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1', type: 'text/plain; charset=utf-8'},
];
export const focusDialFontSourceVariable = 'SPINDLE_FOCUS_DIAL_FONT_SOURCE';
export const focusDialFontStage = '.local/focus-dial-fonts';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface StagedFonts {status: 'staged' | 'absent'; files: {file: string; sha256: string}[]}

/** Verify (from the explicit source, else a previous local stage) and copy into `destination`. A wrong hash throws. */
export async function stageFocusDialFonts(root: string, destination: string, source = process.env[focusDialFontSourceVariable]): Promise<StagedFonts> {
  const stage = resolve(root, focusDialFontStage);
  const from = source ? resolve(source) : stage;
  const verified: {font: FocusDialFont; bytes: Buffer}[] = [];
  for (const font of focusDialFonts) {
    let bytes: Buffer;
    try {bytes = await readFile(source ? resolve(from, font.member) : resolve(from, font.file));}
    catch (error) {
      if (!source && (error as NodeJS.ErrnoException).code === 'ENOENT') return {status: 'absent', files: []};
      throw error;
    }
    if (sha256(bytes) !== font.sha256) throw new Error(`FOCUS_DIAL_FONT_HASH_MISMATCH: ${font.file}`);
    verified.push({font, bytes});
  }
  // The export omitted Instrument Serif's licence. Bundle the upstream OFL
  // notice from the repository; no font or licence is fetched at build time.
  const licence = await readFile(resolve(root, 'assets/licenses/Instrument-Serif-OFL.txt'));
  if (sha256(licence) !== 'b6b2292aa580937fb63796878d65a027a27f8c3db2d97601d0c34d9031f4ca17') throw new Error('FOCUS_DIAL_LICENCE_HASH_MISMATCH');
  verified.push({font: {file: 'Instrument-Serif-OFL.txt', member: 'assets/licenses/Instrument-Serif-OFL.txt', sha256: sha256(licence), type: 'text/plain; charset=utf-8'}, bytes: licence});
  await mkdir(stage, {recursive: true});
  await mkdir(destination, {recursive: true});
  for (const {font, bytes} of verified) {
    if (source) await writeFile(resolve(stage, font.file), bytes);
    await writeFile(resolve(destination, font.file), bytes);
  }
  return {status: 'staged', files: verified.map(({font}) => ({file: font.file, sha256: font.sha256}))};
}
