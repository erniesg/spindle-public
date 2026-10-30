// Development-only build step. No runtime dependency or upload capability.
import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {buildPomodoroExtension} from './build-pomodoro-assets.js';
import {stageFocusDialFonts} from './focus-dial-fonts.js';
import {emitSharedUi} from '../core/ui/emit.js';
import {generatePreviewPdf} from './generate-preview-pdf.js';
import {portalWebFiles,portalBundleModules} from '../core/account/portal/web-manifest.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const file of [
  'tools/image-worker/worker.py',
  'core/assistant/index.html', 'core/assistant/style.css',
  'core/capture-check/index.html', 'core/capture-check/style.css', 'core/preview/index.html',
  'browser-extension/connection-probe/extension/index.html',
  'browser-extension/connection-probe/extension/style.css',
  'browser-extension/connection-probe/extension/manifest.json',
  'browser-extension/preview/manifest.json', 'browser-extension/preview/options.html', 'browser-extension/preview/extension.css',
  'core/pomodoro/index.html', 'core/pomodoro/style.css',
  'browser-extension/pomodoro/pomodoro.html',
]) {
  const output = resolve(root, 'build', file);
  await mkdir(dirname(output), { recursive: true });
  await cp(resolve(root, file), output);
}
// Explicit invented viewer fixture only; the generator is a build dependency, never shipped.
await generatePreviewPdf(resolve(root,'build/core/preview/sample.pdf'));
// MV3 extension imports cannot escape its installed root.
const preview = resolve(root, 'build/browser-extension/preview');
await cp(resolve(root, 'build/browser-extension/blocking'), resolve(preview, 'blocking'), { recursive: true });
await cp(resolve(root, 'browser-extension/blocking/blocking.html'), resolve(preview, 'blocking.html'));
// Only browser-safe contracts/policy, never host control/classifier/credentials.
const browserCore=resolve(preview,'blocking/core');await rm(browserCore,{recursive:true,force:true});await mkdir(browserCore,{recursive:true});
for(const name of ['admission.js','policy.js','purpose.js','jev.js','wire.js','earned-time.js'])await cp(resolve(root,'build/core/blocking',name),resolve(browserCore,name));
for(const name of await readdir(resolve(preview,'blocking'))){if(!name.endsWith('.js'))continue;const path=resolve(preview,'blocking',name);await writeFile(path,(await readFile(path,'utf8')).replace(/\.\.\/\.\.\/core\/blocking\//g,'./core/'));}
const guard=resolve(preview,'blocking/guard.js');
// Registered content scripts are classic scripts, not ES modules.
await writeFile(guard,(await readFile(guard,'utf8')).replace(/export \{\};?\s*$/, ''));
const worker = resolve(preview, 'worker.js');
await writeFile(worker, (await readFile(worker, 'utf8')).replace("'../blocking/worker.js'", "'./blocking/worker.js'"));
await buildPomodoroExtension(root);
// Browser-safe shared components must stay inside the installed extension root.
await emitSharedUi(preview);
// Source/bundle identity for the normal portal; no Git or build tools run in the installed app.
const portal=resolve(root,'build/core/account/portal');await mkdir(portal,{recursive:true});
let source='unbound',tree='unbound',sourceDirty=true;
try{
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 source=git('rev-parse','HEAD');tree=git('rev-parse','HEAD^{tree}');sourceDirty=git('status','--porcelain').length>0;
}catch{/* Copied fixture builds remain explicitly unbound, never clean-source acceptance. */}
// Approved focus-dial fonts: hash-verified input staged flat beside the portal modules; absent is recorded, never faked.
const fonts=await stageFocusDialFonts(root,portal);
if(fonts.status==='staged'){await mkdir(resolve(preview,'fonts'),{recursive:true});for(const font of fonts.files)await cp(resolve(portal,font.file),resolve(preview,'fonts',font.file));}
// Approved app-shell design files: vendored bytes must match their pinned SHA-256 before they are staged.
for(const file of portalWebFiles){
 const bytes=await readFile(resolve(root,'core/account/portal/web',file.path));
 if(file.sha256&&createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('PORTAL_WEB_HASH_MISMATCH: '+file.path);
 const output=resolve(portal,'web',file.path);await mkdir(dirname(output),{recursive:true});await writeFile(output,bytes);
}
const hash=createHash('sha256');
for(const file of portalBundleModules){
 hash.update(file+'\0').update(await readFile(resolve(root,'build/core',file)));
}
for(const font of fonts.files)hash.update(font.file+'\0'+font.sha256+'\0');
for(const file of portalWebFiles)hash.update('web/'+file.path+'\0').update(await readFile(resolve(portal,'web',file.path)));
await writeFile(resolve(portal,'build.json'),JSON.stringify({source,tree,sourceDirty,bundleSha256:hash.digest('hex'),fonts})+'\n');
