// Explicit, receipt-bound Mac native host installation. No recording or OS-policy changes.
import { lstat, mkdir, readFile, writeFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join, resolve, parse, posix } from "node:path";
import { createHash } from "node:crypto";
const launcherName="Preview Native Host.command",receiptName="install-receipt.json";
const launcher=Buffer.from("#!/bin/bash\nset -euo pipefail\nhere=$(cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$here/runtime/node\" \"$here/build/core/preview/browser-host.js\" \"$@\"\n");
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const missing=(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&e.code==="ENOENT";
export const stageDirectory=(home:string,fingerprint:string)=>join(home,"Library/Application Support/SpindlePreview/native-host",fingerprint);
// Check every segment, including pre-existing parent directories; never follow a symlink.
export async function safePath(path:string,create=false){
 const absolute=resolve(path),root=parse(absolute).root;let current=root;
 for(const segment of absolute.slice(root.length).split("/").filter(Boolean)){
  current=join(current,segment);let stat;
  try{stat=await lstat(current);}catch(e){if(!missing(e))throw e;if(!create)throw e;await mkdir(current,{mode:0o700});stat=await lstat(current);}
  if(stat.isSymbolicLink())throw new Error("HOST_SYMLINK");
  if(current!==absolute&&!stat.isDirectory())throw new Error("HOST_PATH_CONFLICT");
 }
}
async function asset(root:string,path:string){const full=join(root,path);await safePath(full);const stat=await lstat(full);if(!stat.isFile()||stat.size>160*1024*1024)throw new Error("HOST_FILE_CONFLICT");return readFile(full);}
type Plan={source:string;fingerprint:string;files:Record<string,Buffer>;receipt:Buffer};
async function plan(root:string):Promise<Plan>{
 const manifest=JSON.parse((await asset(root,"preview-build.json")).toString());
 if(manifest.schema!=="spindle-preview-package/v1"||manifest.sourceDirty!==false||manifest.target!=="macos-arm64"||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.source??"")||!/^[a-f0-9]{64}$/.test(manifest.fingerprint??"")||!manifest.files||typeof manifest.files!=="object"||Array.isArray(manifest.files))throw new Error("HOST_MANIFEST_INVALID");
 const entries=Object.entries(manifest.files) as [string,unknown][];
 if(!entries.length||entries.length>2000||entries.some(([p,h])=>!p||p.startsWith("/")||p.split("/").some(s=>!s||s==="."||s===".."||! /^[A-Za-z0-9_. -]+$/.test(s))||typeof h!=="string"||!/^[a-f0-9]{64}$/.test(h)))throw new Error("HOST_MANIFEST_INVALID");
 const identity="{"+Object.keys(manifest.files).sort().map(k=>JSON.stringify(k)+": "+JSON.stringify(manifest.files[k])).join(", ")+"}";
 if(hash(identity)!==manifest.fingerprint)throw new Error("HOST_MANIFEST_HASH");
 const files:Record<string,Buffer>={};
 async function add(p:string){if(!Object.hasOwn(manifest.files,p))throw new Error("HOST_ASSET_UNLISTED");const bytes=await asset(root,p);if(hash(bytes)!==manifest.files[p])throw new Error("HOST_ASSET_HASH");files[p]=bytes;}
 await add("package.json");if(JSON.parse(files["package.json"].toString()).type!=="module")throw new Error("HOST_PACKAGE_INVALID");await add("runtime/node");
 const pending=["build/core/preview/browser-host.js"];
 while(pending.length){const p=pending.pop()!;if(Object.hasOwn(files,p))continue;if(!/^build\/core\/[A-Za-z0-9_/-]+\.js$/.test(p))throw new Error("HOST_IMPORT_INVALID");await add(p);
  // Packaged TypeScript emits static ESM imports. Follow only their explicit relative dependencies.
  for(const match of files[p].toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["\x27]([^"\x27]+)["\x27]/g)){
   const spec=match[1];if(spec.startsWith("node:"))continue;if(!spec.startsWith("./")&&!spec.startsWith("../"))throw new Error("HOST_IMPORT_INVALID");const next=posix.normalize(posix.join(posix.dirname(p),spec));if(!/^build\/core\/[A-Za-z0-9_/-]+\.js$/.test(next))throw new Error("HOST_IMPORT_INVALID");pending.push(next);
  }
 }
 files[launcherName]=launcher;
 const receipt=Buffer.from(JSON.stringify({schema:"spindle-native-host-install/v1",source:manifest.source,fingerprint:manifest.fingerprint,files:Object.fromEntries(Object.keys(files).sort().map(p=>[p,hash(files[p])]))}));
 return {source:manifest.source,fingerprint:manifest.fingerprint,files,receipt};
}
async function verify(target:string,p:Plan){
 await safePath(target);
 let receipt:Buffer;try{receipt=await asset(target,receiptName);}catch(e){if(String(e).includes("SYMLINK"))throw e;throw new Error("HOST_INSTALL_CONFLICT");}
 if(!receipt.equals(p.receipt))throw new Error("HOST_INSTALL_CONFLICT");
 const expected=new Set([...Object.keys(p.files),receiptName]);const directories=new Set<string>();for(const name of expected){let dir=posix.dirname(name);while(dir!=="."){directories.add(dir);dir=posix.dirname(dir);}}
 async function walk(relative=""){for(const name of await readdir(join(target,relative))){const path=relative?relative+"/"+name:name;await safePath(join(target,path));const stat=await lstat(join(target,path));if(stat.isDirectory()){if(!directories.has(path))throw new Error("HOST_INSTALL_CONFLICT");await walk(path);}else if(!expected.has(path))throw new Error("HOST_INSTALL_CONFLICT");}}
 await walk();for(const [path,bytes] of Object.entries(p.files)){let actual;try{actual=await asset(target,path);}catch{throw new Error("HOST_INSTALL_CONFLICT");}if(!actual.equals(bytes))throw new Error("HOST_INSTALL_CONFLICT");}
}
export async function nativeHostPath(sourceRoot:string,home:string){const p=await plan(sourceRoot);return join(stageDirectory(home,p.fingerprint),launcherName);}
export async function verifyNativeHost(sourceRoot:string,home:string){const p=await plan(sourceRoot);await verify(stageDirectory(home,p.fingerprint),p);}
export async function stageNativeHost(sourceRoot:string,home:string){
 const p=await plan(sourceRoot),target=stageDirectory(home,p.fingerprint);await safePath(join(target,".."),true);
 try{await lstat(target);await verify(target,p);return join(target,launcherName);}catch(e){if(!missing(e))throw e;}
 await mkdir(target,{mode:0o700});
 for(const [path,bytes] of Object.entries(p.files)){await safePath(join(target,posix.dirname(path)),true);await writeFile(join(target,path),bytes,{flag:"wx",mode:path==="runtime/node"||path===launcherName?0o700:0o600});}
 await writeFile(join(target,receiptName),p.receipt,{flag:"wx",mode:0o600});await verify(target,p);return join(target,launcherName);
}
export async function removeNativeHost(sourceRoot:string,home:string){
 const p=await plan(sourceRoot),target=stageDirectory(home,p.fingerprint);await verify(target,p);
 const directories=new Set<string>();for(const path of [...Object.keys(p.files),receiptName]){await unlink(join(target,path));let dir=posix.dirname(path);while(dir!=="."){directories.add(dir);dir=posix.dirname(dir);}}
 for(const dir of [...directories].sort((a,b)=>b.split("/").length-a.split("/").length))await rmdir(join(target,dir));await rmdir(target);
}
