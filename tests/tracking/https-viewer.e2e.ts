// Real local HTTPS proxy + Chromium + account API/store. Empty viewer document,
// no presentation UI/native capture/deployment claim. The disposable self-signed
// certificate is ignored ONLY in this test browser, not production TLS proof.
import assert from 'node:assert/strict';
import {createServer as httpsServer} from 'node:https';
import {request} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';

await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/https-viewer-')),key=randomBytes(32);
let backend:Awaited<ReturnType<typeof startTrackingServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,publicOrigin='',foreignDenied=false,foreignCookiePresent=false,deviceEnrollments=0;
let proxy:ReturnType<typeof httpsServer>|undefined,foreignServer:ReturnType<typeof httpsServer>|undefined;
try{
 proxy=httpsServer({key:await certificate('key'),cert:await readFile(join(dir,'cert.pem'))},(req,res)=>{
 if(req.url==='/viewer'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><title>Invented HTTPS API viewer</title>');return;}
 if(!backend){res.writeHead(503);res.end();return;}
 if(req.url==='/devices'&&req.method==='POST')deviceEnrollments++;
 // Preserve Host and Origin unchanged, like a same-origin trusted TLS proxy.
 const upstream=request(backend.listenOrigin+(req.url??'/'),{method:req.method,headers:req.headers},reply=>{
  if(req.headers.origin&&req.headers.origin!==publicOrigin&&reply.statusCode===403){foreignDenied=true;foreignCookiePresent=!!req.headers.cookie?.includes('spindle_session=');}
  res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);
 });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
 await new Promise<void>((resolve,reject)=>{proxy!.once('error',reject);proxy!.listen(0,'127.0.0.1',resolve);});publicOrigin='https://localhost:'+(proxy.address() as AddressInfo).port;
 backend=await startTrackingServer(join(dir,'server'),key,0,publicOrigin);assert.match(backend.listenOrigin,/^http:\/\/127\.0\.0\.1:/);
 browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE,headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 const call=(path:string,body?:unknown,csrf?:string)=>page.evaluate(async({path,body,csrf})=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};},{path,body,csrf});
 await page.goto(publicOrigin+'/viewer');assert.equal((await call('/session')).status,401);
 const signed=await call('/register',{name:'invented-tls-viewer',password:'invented-password-123'});assert.equal(signed.status,200);let csrf=signed.data.csrf as string;
 const cookie=(await context.cookies(publicOrigin)).find(c=>c.name==='spindle_session')!;assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');assert.equal(await page.evaluate(()=>document.cookie.includes('spindle_session')),false);
 assert.equal((await call('/session')).data.deviceId,null);assert.equal((await call('/devices')).data.devices.length,0);assert.equal((await call('/history')).status,200);
 assert.equal((await call('/processing',{local:true})).status,403);assert.equal((await call('/processing',{local:true},csrf)).status,200);
 const port=Number(new URL(backend.listenOrigin).port);await backend.close();backend=await startTrackingServer(join(dir,'server'),key,port,publicOrigin);
 await page.reload();const session=await call('/session');assert.equal(session.status,200);assert.equal(session.data.account.name,'invented-tls-viewer');csrf=session.data.csrf;
 // Use a real loopback document: synthetic route fulfillment has public/unknown
 // address space and Chrome blocks the fetch before it can test backend Origin.
 foreignServer=httpsServer({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))},(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html>');});
 await new Promise<void>((resolve,reject)=>{foreignServer!.once('error',reject);foreignServer!.listen(0,'127.0.0.1',resolve);});const foreign='https://localhost:'+(foreignServer.address() as AddressInfo).port;
 const adversary=await context.newPage(),errors:string[]=[];adversary.on('console',m=>{if(m.type()==='error'&&errors.length<8)errors.push(m.text().slice(0,1000));});await adversary.goto(foreign+'/adversary');
 assert.equal(await adversary.evaluate(async origin=>{try{await fetch(origin+'/history',{credentials:'include'});return 'read';}catch{return 'blocked';}},publicOrigin),'blocked');assert.equal(foreignDenied,true,JSON.stringify(errors));assert.equal(foreignCookiePresent,true,'Origin guard denies even a same-site credentialled foreign-port fetch');await adversary.close();
 assert.equal((await call('/logout',{},csrf)).status,200);assert.equal((await call('/history')).status,401);assert.equal(deviceEnrollments,0);
 await context.close();console.log('PASS actual HTTPS same-origin proxy preserves Host/Origin; Secure/HttpOnly/Strict cookie browser signin/reload/server restart/read/CSRF/credentialled foreign-origin denial/signout without collector enrollment. Loopback only; self-signed test certificate ignored, no production TLS/native/UI acceptance.');
}finally{await browser?.close();await backend?.close().catch(e=>{if(e.code!=='ERR_SERVER_NOT_RUNNING')throw e;});if(foreignServer){foreignServer.closeAllConnections();await new Promise<void>(resolve=>foreignServer!.close(()=>resolve()));}if(proxy){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()));}await rm(dir,{recursive:true,force:true});}
async function certificate(part:'key'){
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 return readFile(join(dir,part+'.pem'));
}
