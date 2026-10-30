// Development build helper, Node only and never shipped to a browser. Writes the one
// shared stylesheet and the browser modules into a surface's own asset root, so web,
// desktop WKWebView and MV3 extension builds include the same bytes.
import {copyFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spindleUiCss} from './styles.js';

export const sharedUiStylesheet = 'spindle-ui.css';
/** Self-contained browser module set: every import resolves within this list. */
export const sharedUiModules = ['theme.js', 'styles.js', 'dom.js'] as const;

export async function emitSharedUi(destination: string): Promise<string[]> {
  await mkdir(destination, {recursive: true});
  await writeFile(resolve(destination, sharedUiStylesheet), spindleUiCss);
  for (const name of sharedUiModules) await copyFile(new URL(`./${name}`, import.meta.url), resolve(destination, name));
  return [sharedUiStylesheet, ...sharedUiModules];
}
