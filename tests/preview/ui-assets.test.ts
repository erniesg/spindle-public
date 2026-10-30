import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {previewUiAsset} from '../../core/preview/ui-assets.js';
import {previewCss} from '../../core/preview/preview-style.js';
import {spindleUiCss} from '../../core/ui/styles.js';
import {focusDialFonts} from '../../tools/focus-dial-fonts.js';
import {paletteLiterals} from '../ui/guards.js';
const build=new URL('../../',import.meta.url);
const withoutFontFaces=(css:string)=>css.replace(/@font-face\{[^}]*\}/g,'');

test('local desktop routes serve only the shared presentation allowlist',async()=>{
 assert.equal((await previewUiAsset('/spindle-ui.css'))?.body,spindleUiCss);
 assert.equal((await previewUiAsset('/preview.css'))?.body,previewCss);
 for(const path of ['/ui/dom.js','/pomodoro/focus-dial.js','/focus-dial.css','/portal/fonts.css'])assert.ok(await previewUiAsset(path),path);
 for(const path of ['/ui/emit.js','/ui/../tracking/client.js','/pomodoro/../preview/app.js','/portal/fonts/../build.json','/portal/build','/portal/fonts/x.woff2','/spindle-ui.css?x','/','/tracking.enc'])assert.equal(await previewUiAsset(path),undefined,path);
 // Served browser modules import nothing outside the served set.
 for(const path of ['/ui/dom.js','/pomodoro/focus-dial.js'])assert.doesNotMatch(String((await previewUiAsset(path))!.body),/^\s*import\s/m,path);
});

test('local layout sheets add no palette or font literals over the shared tokens',async()=>{
 assert.deepEqual(paletteLiterals(previewCss),[]);
 assert.deepEqual(paletteLiterals(withoutFontFaces(await readFile(new URL('browser-extension/preview/extension.css',build),'utf8'))),[]);
 assert.doesNotMatch(previewCss+await readFile(new URL('browser-extension/preview/extension.css',build),'utf8'),/https?:|@import/);
});

test('extension bundle is self-contained: earned page imports resolve inside its root and fonts are the verified files',async()=>{
 const root=new URL('browser-extension/preview/',build);
 const earned=await readFile(new URL('blocking/earned.js',root),'utf8');
 assert.match(earned,/from '\.\/core\/earned-time\.js'/);
 assert.match(await readFile(new URL('blocking/core/earned-time.js',root),'utf8'),/function leasePauseMessage/);
 assert.match(await readFile(new URL('blocking/earned-page.js',root),'utf8'),/from '\.\/earned\.js'/);
 assert.match(await readFile(new URL('blocking.html',root),'utf8'),/<script type="module" src="blocking\/earned-page\.js"><\/script>/);
 for(const name of ['dom.js','theme.js','styles.js'])assert.ok((await readdir(root)).includes(name),name);
 let fonts:string[]=[];try{fonts=await readdir(new URL('fonts/',root));}catch{/* Unstaged build: system-font fallback, nothing to verify. */}
 const expected=new Map(focusDialFonts.map(font=>[font.file,font.sha256]));
 for(const file of fonts){if(!expected.has(file)){assert.equal(file,'Instrument-Serif-OFL.txt');continue;}assert.equal(createHash('sha256').update(await readFile(new URL('fonts/'+file,root))).digest('hex'),expected.get(file),file);}
 if(fonts.length)assert.ok(fonts.includes('dm-sans-OFL.txt')&&fonts.includes('Instrument-Serif-OFL.txt'),'licences ship with the fonts');
});
