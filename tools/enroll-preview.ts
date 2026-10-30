// Explicit local user command only. No auto-enrollment, startup hook or global host API.
import { mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { nativeHostPath, stageNativeHost, verifyNativeHost, removeNativeHost, safePath } from './preview-host-stage.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const hostName='ai.berlayar.spindle.preview';
export async function enrollMacPreview(id:string,remove:boolean,sourceRoot:string,home:string){
 if(!/^[a-p]{32}$/.test(id))throw new Error('INVALID_EXTENSION_ID');
 const directory=join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts'),manifest=join(directory,hostName+'.json');
 const launcher=await nativeHostPath(sourceRoot,home);
 const desired={name:hostName,description:'Explicitly enrolled Spindle capture preview',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
 let existing:unknown;
 try{await safePath(manifest);existing=JSON.parse(await readFile(manifest,'utf8'));}catch(e){if(!e||typeof e!=='object'||!('code' in e)||e.code!=='ENOENT')throw new Error('REGISTRATION_CONFLICT');}
 if(existing&&JSON.stringify(existing)!==JSON.stringify(desired))throw new Error('REGISTRATION_CONFLICT; existing host preserved.');
 if(remove){
  if(!existing)throw new Error('REGISTRATION_NOT_OWNED');
  await verifyNativeHost(sourceRoot,home);await rm(manifest);await removeNativeHost(sourceRoot,home);
  console.log('Exact package host registration and verified installed runtime removed.');
 }else{
  await stageNativeHost(sourceRoot,home);await safePath(directory,true);
  if(!existing)await writeFile(manifest,JSON.stringify(desired),{flag:'wx',mode:0o600});
  console.log('Verified host installed and registered for the supplied extension ID. Pair this profile explicitly, then Start in the local app.');
 }
}
async function main(){
const id=process.argv[2],remove=process.argv[3]==='--remove';
if(process.platform==='darwin'){await enrollMacPreview(id??'',remove,root,homedir());return;}
if(!id||!/^[a-p]{32}$/.test(id)||!['darwin','win32'].includes(process.platform))throw new Error('Use the loaded extension ID on Mac/Windows; no registration changed.');
const directory=join(process.env.LOCALAPPDATA??homedir(),'SpindlePreview','registration');
const manifest=join(directory,'ai.berlayar.spindle.preview.json');
const launcher=join(root,'Preview Native Host.cmd');
const desired={name:'ai.berlayar.spindle.preview',description:'Explicitly enrolled Spindle capture preview',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
let existing:unknown;try{existing=JSON.parse(await readFile(manifest,'utf8'));}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='ENOENT')throw new Error('REGISTRATION_CONFLICT');}
if(existing&&JSON.stringify(existing)!==JSON.stringify(desired))throw new Error('REGISTRATION_CONFLICT; existing host preserved.');
const reg='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\ai.berlayar.spindle.preview';
if(remove){if(!existing)throw new Error('REGISTRATION_NOT_OWNED');if(process.platform==='win32'){const current=execFileSync('reg.exe',['query',reg,'/ve'],{encoding:'utf8'});if(!current.includes(manifest))throw new Error('REGISTRATION_NOT_OWNED');execFileSync('reg.exe',['delete',reg,'/f'],{stdio:'ignore'});}await rm(manifest);console.log('Run-owned host registration removed; remove the unpacked extension and its local enrollment in Chrome.');}
else{if(process.platform==='win32'){let current='';try{current=execFileSync('reg.exe',['query',reg,'/ve'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{/* missing user key; subsequent write can still fail closed */}if(current&&!current.includes(manifest))throw new Error('REGISTRATION_CONFLICT');}await mkdir(directory,{recursive:true,mode:0o700});await writeFile(manifest,JSON.stringify(desired),{mode:0o600});if(process.platform==='win32')execFileSync('reg.exe',['add',reg,'/ve','/t','REG_SZ','/d',manifest,'/f'],{stdio:'ignore'});console.log('Host registered for the one supplied extension ID. Pair this ordinary profile explicitly in the extension, then Start in the local app.');}

}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
