import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {connect} from 'node:net';
import {join} from 'node:path';
import {startTrackingServer} from '../../core/tracking/server.js';
import {runTimerOnly} from '../../core/preview/timer-only.js';
import type {DesktopIdentity} from '../../core/pomodoro/desktop.js';
import type {AuthenticatedSnapshot} from '../../core/pomodoro/client.js';

test('real timer-only desktop HTTP/IPC has no capture prerequisite and requires separate account/profile/binding/grant authority',{skip:process.platform!=='linux'},async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/pm-'));
 const backend=await startTrackingServer(join(directory,'server'),randomBytes(32));
 let host=await runTimerOnly(join(directory,'control'),true);
 const api=async(path:string,value:unknown={},origin=host.origin)=>{const response=await fetch(host.origin+path,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+new URL(host.url).hash.slice(1),'Content-Type':'application/json'},body:JSON.stringify(value)});return {status:response.status,value:await response.json() as Record<string,unknown>};};
 const ipc=async(message:Record<string,unknown>)=>{
  const config=JSON.parse(await readFile(join(directory,'control/connection.json'),'utf8')) as {secret:string;ipcPath:string};
  return await new Promise<Record<string,unknown>>((resolve,reject)=>{const socket=connect(config.ipcPath);let text='';socket.on('error',reject);socket.on('close',()=>reject(Error('IPC_CLOSED')));socket.on('connect',()=>socket.write(JSON.stringify({schema:'spindle-browser-preview/v1',secret:config.secret,...message})+'\n'));socket.on('data',chunk=>{text+=chunk;const i=text.indexOf('\n');if(i>=0){resolve(JSON.parse(text.slice(0,i)));socket.destroy();}});socket.setTimeout(3000,()=>socket.destroy(Error('IPC_TIMEOUT')));});
 };
 try{
  const unauth=await fetch(host.origin+'/state');assert.equal(unauth.status,401);await unauth.body?.cancel();
  assert.equal((await api('/pomodoro/session',{},'https://untrusted.example')).status,403);
  assert.equal((await api('/start',{apps:['anything']})).status,404);
  await assert.rejects(runTimerOnly(join(directory,'control'),true),/CONTROL_DIRECTORY_IN_USE/);
  assert.equal((await api('/pomodoro/signin',{origin:backend.origin,name:'invented-host-alice',password:'invented-only-password',register:true})).status,200);
  const alice=(await api('/pomodoro/session')).value as unknown as DesktopIdentity;
  assert.equal((await api('/pomodoro/read',{})).status,409);
  assert.equal((await ipc({kind:'pomodoro',data:{action:'session'}})).ok,false);
  const stateResponse=await fetch(host.origin+'/state',{headers:{Authorization:'Bearer '+new URL(host.url).hash.slice(1)}});const state=await stateResponse.json() as {pair:string;capture:string};assert.equal(state.capture,'unavailable-timer-only');
  const pair=await ipc({kind:'pair',code:state.pair});assert.equal(pair.ok,true);const profile=pair.profileToken;
  assert.equal((await ipc({kind:'pomodoro',profileToken:profile,data:{action:'session'}})).ok,false); // Pairing alone is never account access.
  assert.equal((await api('/pomodoro/access',{binding:alice.binding,enabled:true})).status,200);
  const extension=await ipc({kind:'pomodoro',profileToken:profile,data:{action:'session'}});assert.equal(extension.ok,true);assert.equal((extension.value as DesktopIdentity).id,alice.id);
  const start=await ipc({kind:'pomodoro',profileToken:profile,data:{action:'command',binding:alice.binding,command:{id:'host-start',expectedRevision:0,action:'start'}}});assert.equal(start.ok,true);
  assert.equal(((start.value as AuthenticatedSnapshot).timer.status),'running');
  await api('/pomodoro/signin',{origin:backend.origin,name:'invented-host-bob',password:'invented-only-password',register:true});const bob=(await api('/pomodoro/session')).value as unknown as DesktopIdentity;
  await api('/pomodoro/command',{binding:bob.binding,command:{id:'bob-start',expectedRevision:0,action:'start'}});
  assert.equal((await api('/pomodoro/access',{binding:alice.binding,enabled:true})).status,409);
  assert.equal((await ipc({kind:'pomodoro',profileToken:profile,data:{action:'read',binding:alice.binding}})).ok,false);
  await api('/pomodoro/access',{binding:bob.binding,enabled:true});
  assert.equal((await ipc({kind:'pomodoro',profileToken:profile,data:{action:'command',binding:alice.binding,command:{id:'old-alice-pause',expectedRevision:1,action:'pause'}}})).code,'ACCOUNT_CHANGED');
  assert.equal(((await api('/pomodoro/read',{binding:bob.binding})).value as unknown as AuthenticatedSnapshot).timer.status,'running');
  assert.equal((await api('/pomodoro/signout',{binding:alice.binding})).status,409);
  await api('/pomodoro/access',{binding:bob.binding,enabled:false});assert.equal((await ipc({kind:'pomodoro',profileToken:profile,data:{action:'read',binding:bob.binding}})).ok,false);
  await api('/pomodoro/access',{binding:bob.binding,enabled:true});assert.equal((await ipc({kind:'revoke',profileToken:profile})).ok,true);assert.equal((await ipc({kind:'pomodoro',profileToken:profile,data:{action:'session'}})).ok,false);
  assert.deepEqual((await readdir(join(directory,'control'))).sort(),['connection.json','ipc.sock','timer-only.lock']);
  await host.close();assert.deepEqual(await readdir(join(directory,'control')),[]);
  host=await runTimerOnly(join(directory,'control'),true);await api('/pomodoro/signin',{origin:backend.origin,name:'invented-host-alice',password:'invented-only-password'});const again=(await api('/pomodoro/session')).value as unknown as DesktopIdentity;
  assert.notEqual(again.binding,alice.binding);assert.equal(((await api('/pomodoro/read',{binding:again.binding})).value as unknown as AuthenticatedSnapshot).timer.revision,1);
  // If another host replaces the connection record, teardown must preserve it.
  const replacement='{"runOwnedReplacement":true}';await writeFile(join(directory,'control/connection.json'),replacement);await host.close();assert.equal(await readFile(join(directory,'control/connection.json'),'utf8'),replacement);
 }finally{await host.close();await backend.close();await rm(directory,{recursive:true,force:true});}
});
