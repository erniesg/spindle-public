import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromePaths, hostName, inspectChromeNativeHost, installChromeNativeHost, removeChromeNativeHost, stageChromeExtension } from '../../core/preview/chrome-install.js';
const hash=(b:string)=>createHash('sha256').update(b).digest('hex');
const id='a'.repeat(32);
// Synthetic package only: invented bytes, temp home, darwin passed as test context.
async function fixture(rootName='Spindle.app/Contents/Resources'){
 const base=await mkdtemp(join(tmpdir(),'spindle-chrome-')),home=join(base,'home'),root=join(base,rootName);
 const files:Record<string,string>={'package.json':'{"type":"module"}','runtime/node':'node','build/core/preview/browser-host.js':'host','build/browser-extension/preview/manifest.json':'{"manifest_version":3}','build/browser-extension/preview/worker.js':'worker'};
 for(const [p,b] of Object.entries(files)){await mkdir(join(root,p,'..'),{recursive:true});await writeFile(join(root,p),b);}
 const identity=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,hash(b)]));
 const fingerprint=hash('{'+Object.keys(identity).sort().map(k=>JSON.stringify(k)+': '+JSON.stringify(identity[k])).join(', ')+'}');
 await writeFile(join(root,'preview-build.json'),JSON.stringify({schema:'spindle-preview-package/v1',source:'b'.repeat(40),sourceDirty:false,target:'macos-arm64',fingerprint,files:identity}));
 await mkdir(home);
 return {base,home,root,context:{home,platform:'darwin' as const},paths:chromePaths(home)};
}

test('install points at bundled node and existing host entry; registration is never readiness',async()=>{const f=await fixture();try{
 assert.equal((await inspectChromeNativeHost(id,f.root,f.context)).registration,'absent');
 const staged=await stageChromeExtension(f.root,f.context);assert.equal(staged.directory,f.paths.extension);
 assert.equal(await readFile(join(f.paths.extension,'worker.js'),'utf8'),'worker');
 const status=await installChromeNativeHost(id,f.root,f.context);
 assert.deepEqual([status.registration,status.extension,status.connection],['registered','current','unverified']);
 const manifest=JSON.parse(await readFile(f.paths.manifest,'utf8'));
 assert.deepEqual([manifest.name,manifest.path,manifest.allowed_origins],[hostName,f.paths.launcher,[`chrome-extension://${id}/`]]);
 const launcher=await readFile(f.paths.launcher,'utf8');
 assert.ok(launcher.includes(`'${f.root}/runtime/node' '${f.root}/build/core/preview/browser-host.js'`));assert.ok(!/python/i.test(launcher));
 assert.equal(await readFile(join(f.root,'runtime/node'),'utf8'),'node');
}finally{await rm(f.base,{recursive:true,force:true});}});

test('invalid IDs, quoted roots, symlinks and stale bundles fail before any write',async()=>{const f=await fixture(),q=await fixture("Spindle's.app");try{
 for(const bad of ['A'.repeat(32),'q'.repeat(32),'a'.repeat(31)])await assert.rejects(installChromeNativeHost(bad,f.root,f.context),/INVALID_EXTENSION_ID/);
 await assert.rejects(installChromeNativeHost(id,q.root,q.context),/ROOT_INVALID/);
 await assert.rejects(installChromeNativeHost(id,f.root,{home:f.home,platform:'win32'}),/PLATFORM/);
 await writeFile(join(f.root,'runtime/node'),'tampered');await assert.rejects(installChromeNativeHost(id,f.root,f.context),/STALE/);
 await rm(join(f.root,'runtime/node'));await assert.rejects(installChromeNativeHost(id,f.root,f.context),/STALE/);
 await symlink(join(f.root,'package.json'),join(f.root,'runtime/node'));await assert.rejects(installChromeNativeHost(id,f.root,f.context),/SYMLINK/);
 await assert.rejects(access(f.paths.manifest));await assert.rejects(access(f.paths.bridge));
}finally{await rm(f.base,{recursive:true,force:true});await rm(q.base,{recursive:true,force:true});}});

test('foreign manifest, launcher or extension folder is preserved and refused',async()=>{const f=await fixture();try{
 await mkdir(join(f.paths.manifest,'..'),{recursive:true});await writeFile(f.paths.manifest,'{"name":"legacy"}');
 assert.equal((await inspectChromeNativeHost(id,f.root,f.context)).registration,'conflict');
 await assert.rejects(installChromeNativeHost(id,f.root,f.context),/CONFLICT/);assert.equal(await readFile(f.paths.manifest,'utf8'),'{"name":"legacy"}');
 await assert.rejects(removeChromeNativeHost(f.context),/NOT_OWNED/);assert.equal(await readFile(f.paths.manifest,'utf8'),'{"name":"legacy"}');
 await mkdir(f.paths.extension,{recursive:true});await writeFile(join(f.paths.extension,'mine'),'keep');
 await assert.rejects(stageChromeExtension(f.root,f.context),/CONFLICT/);assert.equal(await readFile(join(f.paths.extension,'mine'),'utf8'),'keep');
}finally{await rm(f.base,{recursive:true,force:true});}});

test('owned reinstall and removal touch only exact owned files',async()=>{const f=await fixture();try{
 await stageChromeExtension(f.root,f.context);await installChromeNativeHost(id,f.root,f.context);
 assert.equal((await installChromeNativeHost('b'.repeat(32),f.root,f.context)).registration,'registered');
 const unrelated=join(f.paths.manifest,'..','com.example.other.json');await writeFile(unrelated,'other');
 const data=join(f.home,'Library/Application Support/SpindlePreview/connection.json');await writeFile(data,'keep');
 await writeFile(join(f.paths.extension,'worker.js'),'edited');
 await assert.rejects(removeChromeNativeHost(f.context),/CONFLICT/);await access(f.paths.manifest);await access(f.paths.launcher);
 await writeFile(join(f.paths.extension,'worker.js'),'worker');await removeChromeNativeHost(f.context);
 for(const p of [f.paths.manifest,f.paths.launcher,f.paths.receipt,f.paths.extension])await assert.rejects(access(p));
 assert.equal(await readFile(unrelated,'utf8'),'other');assert.equal(await readFile(data,'utf8'),'keep');
}finally{await rm(f.base,{recursive:true,force:true});}});
