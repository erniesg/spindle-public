import { readFile, stat, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type {WorkOSConfig} from '../account/workos-provider.js';
import type {SharedGoogleConfig} from './google.js';
import { startTrackingServer } from './server.js';
// Explicit CLI paths only. No environment/legacy credential discovery.
const [directory,keyPath,portText='0',originText,googleConfigPath,workosConfigPath]=process.argv.slice(2);
if(!directory||!keyPath||!/^\d{1,5}$/.test(portText)||Number(portText)>65535||process.argv.length>8)throw Error('Usage: node build/core/tracking/run.js DATA_DIRECTORY KEY_FILE [PORT] [PUBLIC_ORIGIN_OR_LOOPBACK_DASH] [PRIVATE_GOOGLE_WEB_JSON_OR_DASH] [WORKOS_PUBLIC_CONFIG_JSON]');
const publicOrigin=originText==='-'?undefined:originText;
let google:SharedGoogleConfig|undefined;
if(googleConfigPath&&googleConfigPath!=='-'){
 const path=resolve(googleConfigPath),info=await lstat(path),parent=await lstat(dirname(path));
 if(info.isSymbolicLink()||!info.isFile()||info.size>65536||parent.isSymbolicLink()||!parent.isDirectory()||process.platform!=='win32'&&((info.mode&0o077)!==0||(parent.mode&0o077)!==0||info.uid!==process.getuid?.()||parent.uid!==process.getuid?.()))throw Error('GOOGLE_CONFIG_MUST_BE_PRIVATE');
 let web;try{web=JSON.parse(await readFile(path,'utf8')).web;}catch{throw Error('GOOGLE_WEB_CONFIG_REQUIRED');}
 const origin=publicOrigin??(Number(portText)>0?`http://127.0.0.1:${Number(portText)}`:undefined);
 if(!origin||!web||!Array.isArray(web.redirect_uris)||!web.redirect_uris.includes(origin+'/oauth/callback'))throw Error('GOOGLE_EXACT_CALLBACK_REGISTRATION_REQUIRED');
 google={clientId:web.client_id,clientSecret:web.client_secret,telemetry:event=>console.log(JSON.stringify({operation:event.operation,stage:event.stage,code:event.code,status:event.status,correlation:event.correlation,...(event.reason?{reason:event.reason}:{})}))};
}
let workos:WorkOSConfig|undefined;
if(workosConfigPath){
 const path=resolve(workosConfigPath),info=await lstat(path);
 if(info.isSymbolicLink()||!info.isFile()||info.size>16384)throw Error('WORKOS_CONFIG_INVALID');
 const parsed:unknown=JSON.parse(await readFile(path,'utf8'));
 if(!parsed||typeof parsed!=='object'||Object.keys(parsed).sort().join(',')!=='clientId,issuer,jwksUri,webRedirectUri')throw Error('WORKOS_PUBLIC_CONFIG_ONLY');
 workos=parsed as WorkOSConfig;
}
const info=await stat(keyPath);if(process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('KEY_FILE_MUST_BE_PRIVATE');
const key=await readFile(keyPath);if(key.length!==32)throw Error('KEY_FILE_MUST_BE_32_BYTES');
const runtime=await startTrackingServer(resolve(directory),key,Number(portText),publicOrigin,google,undefined,undefined,workos);
console.log(`Tracking invented-data loopback listener: ${runtime.listenOrigin}`);
if(publicOrigin)console.log(`Configured HTTPS origin (trusted TLS proxy required): ${runtime.origin}`);
let closing=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{if(!closing){closing=true;void runtime.close().finally(()=>key.fill(0));}});
