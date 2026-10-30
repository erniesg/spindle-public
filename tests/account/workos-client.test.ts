import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountClient} from '../../core/account/client.js';
const account={id:'12345678-1234-4123-8123-123456789abc',name:'invented'};
const csrf='a'.repeat(64),cookie='spindle_session='+'b'.repeat(64);
const envelope=()=>({account:{...account},csrf,cookie});
const live=(identity=account)=>new Response(JSON.stringify({account:identity,csrf}));
test('WorkOS adoption verifies live identity and revokes mismatches',async()=>{
 const calls:string[]=[];
 const client=new AccountClient('https://example.test',async(url,init)=>{calls.push(String(url));assert.equal(new Headers(init?.headers).get('Cookie'),cookie);assert.equal(init?.redirect,'error');return live();});
 assert.deepEqual(await client.signinWorkOSSession(envelope()),account);assert.deepEqual(client.account,account);assert.equal(calls.length,1);
 for(const identity of [{...account,id:'aaaaaaaa-1234-4123-8123-123456789abc'},{...account,name:'other'}]){
  const paths:string[]=[];const rejected=new AccountClient('https://example.test',async url=>{paths.push(new URL(String(url)).pathname);return paths.length===1?live(identity):new Response('{}');});
  await assert.rejects(rejected.signinWorkOSSession(envelope()),/ACCOUNT_IDENTITY_MISMATCH/);
  assert.equal(rejected.account,undefined);assert.deepEqual(paths,['/session','/logout']);
 }
});
test('WorkOS adoption rejects browser and malformed envelope without transport',async()=>{
 let calls=0;const transport:typeof fetch=async()=>{calls++;return live();};
 await assert.rejects(new AccountClient('https://example.test',transport,true).signinWorkOSSession(envelope()),/BROWSER_SESSION_REQUIRED/);
 for(const bad of [null,{...envelope(),extra:true},{...envelope(),cookie:cookie+'; Path=/'},{...envelope(),csrf:'x'},{...envelope(),account:{...account,extra:true}},{...envelope(),account:{...account,id:'bad'}}])
  await assert.rejects(new AccountClient('https://example.test',transport).signinWorkOSSession(bad as ReturnType<typeof envelope>),/INVALID_ACCOUNT_SESSION/);
 assert.equal(calls,0);
});
test('adoption retires previous authority and blocks concurrent authentication',async()=>{
 const paths:string[]=[];let release:((response:Response)=>void)|undefined;
 const client=new AccountClient('https://example.test',async url=>{paths.push(new URL(String(url)).pathname);if(paths.length===1)return live();if(paths.length===2)return new Promise<Response>(resolve=>{release=resolve;});return live();});
 await client.signinWorkOSSession(envelope());const replacing=client.signinWorkOSSession(envelope());
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.account,undefined);await assert.rejects(client.signinWorkOSSession(envelope()),/ACCOUNT_BUSY/);
 release(new Response('{}'));await replacing;assert.deepEqual(paths,['/session','/logout','/session']);
});
test('cancellation revokes incoming session and failed cleanup retains authority',async()=>{
 let release:((response:Response)=>void)|undefined;const paths:string[]=[];
 const client=new AccountClient('https://example.test',async(url,init)=>{paths.push(new URL(String(url)).pathname);if(paths.length===1)return new Promise<Response>(resolve=>{release=resolve;});assert.equal(new Headers(init?.headers).get('Cookie'),cookie);return new Response('{}');});
 const pending=client.signinWorkOSSession(envelope());while(!release)await new Promise(resolve=>setImmediate(resolve));
 const rejected=assert.rejects(pending,/ACCOUNT_IDENTITY_MISMATCH/),logout=client.signout();release(live());await rejected;await logout;
 assert.equal(client.account,undefined);assert.deepEqual(paths,['/session','/logout']);
 let calls=0;const retained=new AccountClient('https://example.test',async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('Cookie'),cookie);return calls===1?live({...account,name:'wrong'}):calls===2?new Response('{}',{status:503}):new Response('{}');});
 await assert.rejects(retained.signinWorkOSSession(envelope()),/ACCOUNT_HTTP_503/);assert.equal(retained.account,undefined);await retained.signout();assert.equal(calls,3);
});
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {PreviewSession} from '../../core/preview/session.js';
import {PomodoroControl} from '../../core/preview/pomodoro-control.js';
import type {DesktopIdentity} from '../../core/pomodoro/desktop.js';
test('native session adoption preserves encrypted queue and device across restart, isolates direct account, and retires timer grants',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-workos-clients-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),key=randomBytes(32);
 const issue=async(name:string,register=false)=>{
  const response=await fetch(server.origin+(register?'/register':'/signin'),{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name,password:'invented-only-password'})});
  assert.equal(response.status,200);const {csrf}=await response.json() as {csrf:string},cookie=response.headers.get('set-cookie')!.split(';')[0];
  const current=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});
  const {account}=await current.json() as {account:{id:string;name:string}};return {account,cookie,csrf};
 };
 const timer=new PomodoroControl(()=>'paired-profile');let sink:CollectorHistory|undefined;
 try{
  const first=await issue('workos.invented',true);let client=new TrackingClient(server.origin,join(dir,'client'),key);
  await client.signinWorkOSSession(first,'Computer');const deviceId=(await client.inspect()).deviceId;
  const session=new PreviewSession();sink=new CollectorHistory(session,client,deviceId,86400000);
  session.start({pixels:false,rich:false,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'invented-window',app:'invented-editor',title:'Invented',clock:'invented-clock',browser:false});session.sample({epoch:session.epoch,revision:1,at:1,text:'Invented text',status:'native-text'});session.pause(10);await sink.dispose();sink=undefined;
  const pending=(await client.inspect()).pending;assert.ok(pending>0);await client.settle();
  client=new TrackingClient(server.origin,join(dir,'client'),key);
  const renewedTracking=await issue('workos.invented');await client.signinWorkOSSession(renewedTracking,'Renamed');
  const oldSession=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:first.cookie}});assert.equal(oldSession.status,401);await oldSession.body?.cancel();
  const newSession=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:renewedTracking.cookie}});assert.equal(newSession.status,200);await newSession.body?.cancel();
  assert.equal((await client.inspect()).deviceId,deviceId);assert.equal((await client.inspect()).pending,pending);
  const other=new TrackingClient(server.origin,join(dir,'other'),randomBytes(32));await other.signinWorkOSSession(await issue('workos.invented'),'Other');assert.notEqual((await other.inspect()).deviceId,deviceId);
  const direct=new TrackingClient(server.origin,join(dir,'direct'),randomBytes(32));await direct.signin('direct-invented','invented-only-password','Direct',true);
  await assert.rejects(direct.signinWorkOSSession(await issue('direct-invented'),'Direct'),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);
  assert.equal((await direct.inspect()).account,'direct-invented');
  const identity=await timer.signinWorkOSSession(server.origin,await issue('workos.invented'));assert.equal(timer.accessEnabled,false);
  await timer.route('access',{binding:identity.binding,enabled:true});assert.equal(timer.accessEnabled,true);
  const renewed=await timer.signinWorkOSSession(server.origin,await issue('workos.invented'));assert.notEqual(renewed.binding,identity.binding);assert.equal(timer.accessEnabled,false);
  await assert.rejects(timer.route('read',{binding:identity.binding}),/ACCOUNT_CHANGED/);
  assert.equal((await timer.route('session',{}) as DesktopIdentity).id,first.account.id);
  await client.sync();assert.equal((await client.inspect()).pending,0);
 }finally{await sink?.dispose();await timer.close();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('encrypted revocation leases survive failed logout and restart, including rejected incoming account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-revocations-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),key=randomBytes(32),path=join(dir,'client'),real=globalThis.fetch;
 const issue=async(name:string,register=false)=>{
  const response=await real(server.origin+(register?'/register':'/signin'),{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name,password:'invented-only-password'})});
  const {csrf}=await response.json() as {csrf:string},cookie=response.headers.get('set-cookie')!.split(';')[0];
  const current=await real(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}}),{account}=await current.json() as {account:{id:string;name:string}};return {account,cookie,csrf};
 };
 const status=async(cookie:string)=>{const response=await real(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});await response.body?.cancel();return response.status;};
 try{
  let client=new TrackingClient(server.origin,path,key);const first=await issue('workos.lease',true);await client.signinWorkOSSession(first,'Lease');
  const deviceId=(await client.inspect()).deviceId,second=await issue('workos.lease'),foreign=await issue('workos.foreign',true);
  globalThis.fetch=async(input,init)=>String(input).endsWith('/logout')?new Response('{}',{status:503}):real(input,init);
  await client.signinWorkOSSession(second,'Lease');assert.equal(await status(first.cookie),200);assert.equal(await status(second.cookie),200);
  assert.equal((await client.inspect()).pendingRevocations,1);assert.equal((await client.inspect()).error,'SESSION_REVOCATION_PENDING');
  await assert.rejects(client.signinWorkOSSession(foreign,'Foreign'),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);
  assert.equal((await client.inspect()).pendingRevocations,2);assert.equal((await client.inspect()).deviceId,deviceId);
  const cancelled=await issue('workos.lease');
  globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/logout'))return new Response('{}',{status:503});if(String(input).endsWith('/devices'))throw new DOMException('Cancelled','AbortError');return real(input,init);};
  await assert.rejects(client.signinWorkOSSession(cancelled,'Cancelled'),/Cancelled/);assert.equal((await client.inspect()).pendingRevocations,3);
  await client.settle();client=new TrackingClient(server.origin,path,key);assert.equal((await client.inspect()).pendingRevocations,3);
  globalThis.fetch=real;await client.sync();assert.equal((await client.inspect()).pendingRevocations,0);assert.equal((await client.inspect()).error,'');
  assert.equal(await status(first.cookie),401);assert.equal(await status(foreign.cookie),401);assert.equal(await status(cancelled.cookie),401);assert.equal(await status(second.cookie),200);assert.equal((await client.inspect()).deviceId,deviceId);
 }finally{globalThis.fetch=real;await server.close();await rm(dir,{recursive:true,force:true});}
});

import {DesktopPomodoro} from '../../core/pomodoro/desktop.js';
test('desktop timer retains prior logout authority across failed replacement and close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-timer-retirement-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),desktop=new DesktopPomodoro(),real=globalThis.fetch;
 let oldCookie='',failLogout=false;
 try{
  globalThis.fetch=async(input,init)=>{if(failLogout&&String(input).endsWith('/logout'))return new Response('{}',{status:503});const response=await real(input,init);if(String(input).endsWith('/register'))oldCookie=response.headers.get('set-cookie')!.split(';')[0];return response;};
  await desktop.signin({origin:server.origin,name:'retirement-timer',password:'invented-only-password',register:true});
  failLogout=true;
  await assert.rejects(desktop.signin({origin:server.origin,name:'retirement-timer',password:'invented-only-password'}),/ACCOUNT_HTTP_503/);
  await assert.rejects(desktop.close(),/ACCOUNT_HTTP_503/);
  failLogout=false;globalThis.fetch=real;await desktop.close();
  const response=await real(server.origin+'/session',{headers:{Origin:server.origin,Cookie:oldCookie}});assert.equal(response.status,401);await response.body?.cancel();
 }finally{failLogout=false;globalThis.fetch=real;await desktop.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
