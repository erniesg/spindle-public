// Explicit per-user Chrome bridge for an installed, signed Spindle bundle. The bundle is
// verified and read only: a per-user launcher and the existing host manifest point at its
// bundled runtime/node and compiled browser-host.js. No Python, network, secrets or new host ID.
// Registration files are never proof that Chrome connected or that a profile is enrolled.
import { lstat, mkdir, readFile, writeFile, readdir, unlink, rmdir, rename } from 'node:fs/promises';
import { join, resolve, parse, posix, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const hostName='ai.berlayar.spindle.preview';
const hostEntry='build/core/preview/browser-host.js',extensionPrefix='build/browser-extension/preview/';
const receiptName='chrome-bridge-receipt.json',launcherName='Spindle Chrome Host';
export type ChromeContext={home:string;platform?:NodeJS.Platform};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const missing=(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT';
const validId=(id:string)=>/^[a-p]{32}$/.test(id);

export function chromePaths(home:string){
 const support=join(home,'Library/Application Support');
 return {
  manifest:join(support,'Google/Chrome/NativeMessagingHosts',hostName+'.json'),
  bridge:join(support,'SpindlePreview/chrome-bridge'),
  launcher:join(support,'SpindlePreview/chrome-bridge',launcherName),
  receipt:join(support,'SpindlePreview/chrome-bridge',receiptName),
  // Stable across versions so Chrome's unpacked extension ID does not change on update.
  extension:join(support,'SpindlePreview/chrome-extension'),
 };
}

// Every segment, including existing parents, must be a real directory; never follow a symlink.
async function safePath(path:string,create=false){
 const absolute=resolve(path),root=parse(absolute).root;let current=root;
 for(const segment of absolute.slice(root.length).split('/').filter(Boolean)){
  current=join(current,segment);let stat;
  try{stat=await lstat(current);}catch(e){if(!missing(e)||!create)throw e;await mkdir(current,{mode:0o700});stat=await lstat(current);}
  if(stat.isSymbolicLink())throw new Error('CHROME_SYMLINK');
  if(current!==absolute&&!stat.isDirectory())throw new Error('CHROME_PATH_CONFLICT');
 }
}
async function readOwned(path:string,limit=160*1024*1024){await safePath(path);const stat=await lstat(path);if(!stat.isFile()||stat.size>limit)throw new Error('CHROME_FILE_CONFLICT');return readFile(path);}
async function readOptional(path:string){try{return await readOwned(path,1024*1024);}catch(e){if(missing(e))return null;throw e;}}

function checkContext(context:ChromeContext){
 if((context.platform??process.platform)!=='darwin')throw new Error('CHROME_PLATFORM_UNSUPPORTED');
 if(!isAbsolute(context.home))throw new Error('CHROME_HOME_INVALID');
}
// The root is embedded in a bash launcher. Refuse anything that could escape single quotes.
function checkRoot(root:string){if(!isAbsolute(root)||root!==resolve(root)||/['"`$\\\x00-\x1f\x7f]/.test(root))throw new Error('CHROME_ROOT_INVALID');}

type Bundle={source:string;fingerprint:string;extension:Record<string,Buffer>};
// Verify the trusted app resources against their own packaged preview-build.json.
async function bundle(root:string):Promise<Bundle>{
 checkRoot(root);
 let manifest:any;try{manifest=JSON.parse((await readOwned(join(root,'preview-build.json'),4*1024*1024)).toString());}catch(e){if(String(e).includes('SYMLINK'))throw e;throw new Error('CHROME_BUNDLE_MISSING');}
 if(manifest.schema!=='spindle-preview-package/v1'||manifest.sourceDirty!==false||!String(manifest.target??'').startsWith('macos')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.source??'')||!/^[a-f0-9]{64}$/.test(manifest.fingerprint??'')||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('CHROME_BUNDLE_INVALID');
 const entries=Object.entries(manifest.files) as [string,unknown][];
 if(!entries.length||entries.length>5000||entries.some(([p,h])=>p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..'||!/^[A-Za-z0-9_. -]+$/.test(s))||typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))throw new Error('CHROME_BUNDLE_INVALID');
 const identity='{'+Object.keys(manifest.files).sort().map(k=>JSON.stringify(k)+': '+JSON.stringify(manifest.files[k])).join(', ')+'}';
 if(hash(identity)!==manifest.fingerprint)throw new Error('CHROME_BUNDLE_HASH');
 async function check(p:string){if(!Object.hasOwn(manifest.files,p))throw new Error('CHROME_BUNDLE_UNLISTED');let bytes;try{bytes=await readOwned(join(root,p));}catch(e){if(String(e).includes('SYMLINK'))throw e;throw new Error('CHROME_BUNDLE_STALE');}if(hash(bytes)!==manifest.files[p])throw new Error('CHROME_BUNDLE_STALE');return bytes;}
 await check('package.json');await check('runtime/node');
 for(const p of Object.keys(manifest.files))if(p.startsWith('build/core/'))await check(p);
 if(!Object.hasOwn(manifest.files,hostEntry))throw new Error('CHROME_BUNDLE_UNLISTED');
 const extension:Record<string,Buffer>={};
 for(const p of Object.keys(manifest.files))if(p.startsWith(extensionPrefix))extension[p.slice(extensionPrefix.length)]=await check(p);
 if(!extension['manifest.json'])throw new Error('CHROME_BUNDLE_UNLISTED');
 return {source:manifest.source,fingerprint:manifest.fingerprint,extension};
}

function desired(root:string,id:string){
 const launcherBytes=Buffer.from(`#!/bin/bash\nexec '${root}/runtime/node' '${root}/${hostEntry}' "$@"\n`);
 return {launcherBytes,manifestBytes:(paths:ReturnType<typeof chromePaths>)=>Buffer.from(JSON.stringify({name:hostName,description:'Explicitly enrolled Spindle capture preview',path:paths.launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}))};
}
type Receipt={schema:'spindle-chrome-bridge/v1';extensionId:string;resourceRoot:string;source:string;fingerprint:string;manifest:string;launcher:string;extension:Record<string,string>};
async function loadReceipt(paths:ReturnType<typeof chromePaths>):Promise<Receipt|null>{
 const bytes=await readOptional(paths.receipt);if(!bytes)return null;
 const r=JSON.parse(bytes.toString());if(r?.schema!=='spindle-chrome-bridge/v1'||typeof r.extension!=='object')throw new Error('CHROME_RECEIPT_INVALID');return r;
}
// Owned means: byte-identical to what our receipt says we wrote. Anything else is preserved.
async function ownedFile(path:string,expected:string|undefined){const bytes=await readOptional(path);if(!bytes)return 'absent';return expected&&hash(bytes)===expected?'owned':'foreign';}
async function extensionState(dir:string,files:Record<string,string>|undefined){
 try{await lstat(dir);}catch(e){if(missing(e))return 'absent';throw e;}
 if(!files)return 'foreign';await safePath(dir);
 const dirs=new Set<string>();for(const p of Object.keys(files)){let d=posix.dirname(p);while(d!=='.'){dirs.add(d);d=posix.dirname(d);}}
 let state:'owned'|'foreign'='owned';
 async function walk(rel=''){for(const name of await readdir(join(dir,rel))){const p=rel?rel+'/'+name:name,stat=await lstat(join(dir,p));if(stat.isSymbolicLink())throw new Error('CHROME_SYMLINK');if(stat.isDirectory()){if(!dirs.has(p))state='foreign';else await walk(p);}else if(!Object.hasOwn(files!,p)||hash(await readFile(join(dir,p)))!==files![p])state='foreign';}}
 await walk();for(const p of Object.keys(files))if(!(await readOptional(join(dir,p))))state='foreign';
 return state;
}

export type ChromeStatus={
 hostName:string;source:string;fingerprint:string;extensionDirectory:string;
 registration:'absent'|'registered'|'stale'|'conflict';extension:'absent'|'current'|'stale'|'conflict';
 // Files cannot show a live Chrome connection or profile enrollment; the app must observe IPC.
 connection:'unverified';
};
export async function inspectChromeNativeHost(extensionId:string,resourceRoot:string,context:ChromeContext):Promise<ChromeStatus>{
 checkContext(context);if(!validId(extensionId))throw new Error('INVALID_EXTENSION_ID');
 const b=await bundle(resourceRoot),paths=chromePaths(context.home),r=await loadReceipt(paths),want=desired(resourceRoot,extensionId);
 const manifest=await ownedFile(paths.manifest,r?.manifest),launcher=await ownedFile(paths.launcher,r?.launcher),ext=await extensionState(paths.extension,r?.extension);
 const current=!!r&&r.manifest===hash(want.manifestBytes(paths))&&r.launcher===hash(want.launcherBytes)&&r.fingerprint===b.fingerprint;
 const registration=manifest==='absent'&&launcher==='absent'?'absent':manifest==='foreign'||launcher==='foreign'?'conflict':manifest==='owned'&&launcher==='owned'&&current?'registered':'stale';
 const extCurrent=!!r&&JSON.stringify(r.extension)===JSON.stringify(hashes(b.extension));
 const extension=ext==='absent'?'absent':ext==='foreign'?'conflict':extCurrent?'current':'stale';
 return {hostName,source:b.source,fingerprint:b.fingerprint,extensionDirectory:paths.extension,registration,extension,connection:'unverified'};
}
const hashes=(files:Record<string,Buffer>)=>Object.fromEntries(Object.keys(files).sort().map(p=>[p,hash(files[p])]));

// Stage the bundle's compiled extension to the stable folder for Load unpacked.
export async function stageChromeExtension(resourceRoot:string,context:ChromeContext){
 checkContext(context);const b=await bundle(resourceRoot),paths=chromePaths(context.home),r=await loadReceipt(paths);
 const state=await extensionState(paths.extension,r?.extension);if(state==='foreign')throw new Error('CHROME_EXTENSION_CONFLICT; existing folder preserved.');
 const next=hashes(b.extension);
 if(state==='owned'&&JSON.stringify(r!.extension)===JSON.stringify(next))return {directory:paths.extension,source:b.source,fingerprint:b.fingerprint};
 if(state==='owned')await removeTree(paths.extension,r!.extension);
 await safePath(paths.extension,true);
 for(const [p,bytes] of Object.entries(b.extension)){await safePath(join(paths.extension,posix.dirname(p)),true);await writeFile(join(paths.extension,p),bytes,{flag:'wx',mode:0o600});}
 await writeReceipt(paths,{...(r??{schema:'spindle-chrome-bridge/v1',extensionId:'',resourceRoot,manifest:'',launcher:''}),source:b.source,fingerprint:b.fingerprint,extension:next} as Receipt);
 return {directory:paths.extension,source:b.source,fingerprint:b.fingerprint};
}

export async function installChromeNativeHost(extensionId:string,resourceRoot:string,context:ChromeContext):Promise<ChromeStatus>{
 checkContext(context);if(!validId(extensionId))throw new Error('INVALID_EXTENSION_ID');
 const b=await bundle(resourceRoot),paths=chromePaths(context.home),r=await loadReceipt(paths),want=desired(resourceRoot,extensionId),manifestBytes=want.manifestBytes(paths);
 const manifest=await ownedFile(paths.manifest,r?.manifest),launcher=await ownedFile(paths.launcher,r?.launcher);
 // A byte-identical manifest written by the older Enroll Browser tool would still be foreign here.
 if(manifest==='foreign'||launcher==='foreign')throw new Error('REGISTRATION_CONFLICT; existing host preserved.');
 await safePath(paths.bridge,true);await safePath(join(paths.manifest,'..'),true);
 if(launcher==='owned')await unlink(paths.launcher);
 await writeFile(paths.launcher,want.launcherBytes,{flag:'wx',mode:0o700});
 if(manifest==='owned')await unlink(paths.manifest);
 await writeFile(paths.manifest,manifestBytes,{flag:'wx',mode:0o600});
 await writeReceipt(paths,{schema:'spindle-chrome-bridge/v1',extensionId,resourceRoot,source:b.source,fingerprint:b.fingerprint,manifest:hash(manifestBytes),launcher:hash(want.launcherBytes),extension:r?.extension??{}});
 return inspectChromeNativeHost(extensionId,resourceRoot,context);
}

// Remove only exact files this module recorded. Verify everything before deleting anything.
export async function removeChromeNativeHost(context:ChromeContext){
 checkContext(context);const paths=chromePaths(context.home),r=await loadReceipt(paths);if(!r)throw new Error('REGISTRATION_NOT_OWNED');
 const manifest=await ownedFile(paths.manifest,r.manifest),launcher=await ownedFile(paths.launcher,r.launcher),ext=await extensionState(paths.extension,r.extension);
 if(manifest==='foreign'||launcher==='foreign'||ext==='foreign')throw new Error('REGISTRATION_CONFLICT; nothing removed.');
 if(manifest==='owned')await unlink(paths.manifest);if(launcher==='owned')await unlink(paths.launcher);
 if(ext==='owned')await removeTree(paths.extension,r.extension);
 await unlink(paths.receipt);try{await rmdir(paths.bridge);}catch{/* unrelated files stay */}
}

async function removeTree(dir:string,files:Record<string,string>){
 const dirs=new Set<string>();for(const p of Object.keys(files)){await unlink(join(dir,p));let d=posix.dirname(p);while(d!=='.'){dirs.add(d);d=posix.dirname(d);}}
 for(const d of [...dirs].sort((a,b)=>b.split('/').length-a.split('/').length))await rmdir(join(dir,d));await rmdir(dir);
}
async function writeReceipt(paths:ReturnType<typeof chromePaths>,r:Receipt){
 await safePath(paths.bridge,true);const temp=paths.receipt+'.tmp';
 try{await unlink(temp);}catch(e){if(!missing(e))throw e;}
 await writeFile(temp,JSON.stringify(r),{flag:'wx',mode:0o600});await rename(temp,paths.receipt);
}
