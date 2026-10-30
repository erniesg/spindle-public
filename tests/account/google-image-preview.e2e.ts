import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,type Browser,type BrowserContext} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';

// Cheapest real-browser boundary for the Blob URLs used by preparationArtifact.
// This is invented PNG/CSP machinery, not an authenticated model/Google journey.
const executable=process.env.SPINDLE_REVIEW_CHROMIUM;
if(!executable)throw Error('SPINDLE_REVIEW_CHROMIUM required; no download');
const directory=await mkdtemp(join(tmpdir(),'gimg-')),key=Buffer.alloc(32,23);
const app=await startTrackingServer(directory,key,0);
let browser:Browser|undefined,context:BrowserContext|undefined,outsideRequests=0;
try{
 browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});
 context=await browser.newContext();
 await context.route('**/*',route=>{
  if(new URL(route.request().url()).origin===app.origin)return route.continue();
  outsideRequests++;return route.abort();
 });
 const page=await context.newPage(),response=await page.goto(app.origin+'/connections');
 const policy=response!.headers()['content-security-policy'];
 assert.match(policy,/(?:^|;)\s*default-src 'none'(?:;|$)/);
 const result=await page.evaluate(async()=>{
  const violations:{directive:string;blocked:string}[]=[];
  document.addEventListener('securitypolicyviolation',e=>violations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
  canvas.getContext('2d')!.fillRect(0,0,8,8);
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
  const url=URL.createObjectURL(blob),image=new Image();
  document.getElementById('preparation-task')!.append(image);image.src=url;
  let error:string|undefined;
  try{await image.decode();}catch(failure){error=(failure as Error).name;}
  URL.revokeObjectURL(url);
  const external=new Image();
  await new Promise<void>(resolve=>{external.onerror=()=>resolve();external.onload=()=>resolve();external.src='https://unrelated.example.invalid/not-a-source.png';});
  await new Promise(resolve=>setTimeout(resolve,10));
  return {width:image.naturalWidth,error,violations};
 });
 assert.equal(result.width,8,'Retained local artifact PNG must decode under actual served CSP');
 assert.equal(result.error,undefined);
 assert.ok(result.violations.some(v=>v.directive==='img-src'&&v.blocked==='https://unrelated.example.invalid/not-a-source.png'));
 assert.equal(outsideRequests,0,'External image denied before browser dispatch');
 console.log(JSON.stringify({result:'PASS',localBlobWidth:result.width,externalImageDenied:true,outsideRequests,sandbox:true,proof:'Invented PNG in actual connections preparation panel; not actual task/model/Google acceptance'}));
}finally{await context?.close();await browser?.close();await app.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
