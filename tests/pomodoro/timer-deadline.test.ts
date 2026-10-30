import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {PomodoroControl} from '../../core/preview/pomodoro-control.js';
import {AccountClient} from '../../core/account/client.js';
import type {DesktopIdentity} from '../../core/pomodoro/desktop.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';

test('dedicated host deadline aborts actual HTTP work; no slot borrowing, late response or automatic command replay',async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/pm-deadline-'));
 const backend=await startTrackingServer(directory,randomBytes(32));
 let mode:'normal'|'hold-read'|'hold-committed-command'='normal',active=0,aborts=0,entered:()=>void=()=>{},aborted:()=>void=()=>{};
 // Fault proxy only: auth/identity/state remain in the ACTUAL existing account
 // service. The profile callback below is a unit seam, not browser enrollment proof.
 const proxy=createServer(async(req,res)=>{
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  const hold=async()=>{active++;entered();await new Promise<void>(resolve=>{const done=()=>{active--;aborts++;aborted();resolve();};if(controller.signal.aborted)done();else controller.signal.addEventListener('abort',done,{once:true});});};
  try{
   if(mode==='hold-read'&&req.url==='/pomodoro'){await hold();return;}
   let raw='';for await(const chunk of req)raw+=chunk;
   const headers:Record<string,string>={Origin:backend.origin};for(const key of ['cookie','x-csrf-token','content-type'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key] as string;
   const upstream=await fetch(backend.origin+req.url,{method:req.method,headers,...(raw?{body:raw}:{}),signal:controller.signal});
   const body=await upstream.text();
   if(mode==='hold-committed-command'&&req.url==='/pomodoro/command'){await hold();return;}
   res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(body);
  }catch{if(!res.destroyed){res.writeHead(503);res.end('{}');}}
 });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
 const profile=randomBytes(32).toString('hex'),control=new PomodoroControl(()=>profile);
 try{
  await control.route('signin',{origin,name:'invented-deadline',password:'invented-only-password',register:true});
  const identity=await control.route('session',{}) as DesktopIdentity;await control.route('access',{binding:identity.binding,enabled:true});
  mode='hold-read';let enteredPromise=new Promise<void>(r=>{entered=r;}),abortPromise=new Promise<void>(r=>{aborted=r;});
  const started=performance.now(),pending=control.extension({action:'read',binding:identity.binding},profile);await enteredPromise;
  assert.equal((await control.extension({action:'read',binding:identity.binding},profile)).code,'POMODORO_BUSY');
  assert.equal((await pending).ok,false);await abortPromise;assert.ok(performance.now()-started<1600,'host abort must fit within its <=1500ms budget plus scheduler delivery');assert.equal(active,0);assert.equal(aborts,1);
  mode='normal';assert.equal((await control.extension({action:'read',binding:identity.binding},profile)).ok,true);
  // Revoke while actual HTTP is blocked: cancel it rather than leave hidden work
  // behind a Promise.race or reuse a slot with a live prior request.
  mode='hold-read';enteredPromise=new Promise<void>(r=>{entered=r;});abortPromise=new Promise<void>(r=>{aborted=r;});
  const revoked=control.extension({action:'read',binding:identity.binding},profile);await enteredPromise;control.revokeProfile();assert.equal((await revoked).ok,false);await abortPromise;assert.equal(active,0);
  await control.route('access',{binding:identity.binding,enabled:true});
  mode='hold-committed-command';enteredPromise=new Promise<void>(r=>{entered=r;});abortPromise=new Promise<void>(r=>{aborted=r;});
  const command={id:'committed-response-lost',expectedRevision:0,action:'start'};
  const uncertain=control.extension({action:'command',binding:identity.binding,command},profile);await enteredPromise;assert.equal((await uncertain).ok,false);await abortPromise;
  mode='normal';const peer=new AccountClient(backend.origin);await peer.signin('invented-deadline','invented-only-password');assert.equal((await peer.request('/pomodoro') as Snapshot).timer.revision,1);
  const replay=await control.extension({action:'command',binding:identity.binding,command},profile);assert.equal(replay.ok,true);assert.equal((replay.value as Snapshot).timer.revision,1);await peer.signout();
 }finally{mode='normal';await control.close();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));await backend.close();await rm(directory,{recursive:true,force:true});}
});
