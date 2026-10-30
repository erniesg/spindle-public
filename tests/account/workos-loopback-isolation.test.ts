import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import type {WorkOSConfig} from '../../core/account/workos-provider.js';

async function ipv6Port(){
 const listener=createServer();await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'::1',resolve);});
 const port=(listener.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));return port;
}
function config(port:number):WorkOSConfig{return {
 clientId:'client_invented',issuer:'https://api.workos.com/user_management/client_invented',
 jwksUri:'https://api.workos.com/sso/jwks/client_invented',webRedirectUri:'http://[::1]:'+port+'/auth/workos/callback',
};}

// Real APIRequestContext cookie jar and real HTTP; invented password accounts only.
// No browser/native launch or provider exchange: this proves loopback cookie isolation.
test('loopback cookie fixture: IPv6 WorkOS test runtime and IPv4 legacy runtime retain separate cookie authority',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'workos-cookie-isolation-'));
 const legacy=await startTrackingServer(join(directory,'legacy'),randomBytes(32));
 let isolated:Awaited<ReturnType<typeof startTrackingServer>>|undefined;
 const jar=await request.newContext();
 try{
  const port=await ipv6Port();isolated=await startTrackingServer(join(directory,'isolated'),randomBytes(32),port,undefined,undefined,undefined,undefined,config(port));
  assert.equal(new URL(legacy.origin).hostname,'127.0.0.1');assert.equal(legacy.listenOrigin,legacy.origin);
  assert.equal(new URL(isolated.origin).hostname,'[::1]');assert.equal(isolated.origin,'http://[::1]:'+port);
  const post=async(origin:string,path:string,data:unknown)=>{
   const response=await jar.post(origin+path,{headers:{Origin:origin},data});assert.equal(response.status(),200);return await response.json() as {csrf?:string};
  };
  const read=async(origin:string)=>{
   const response=await jar.get(origin+'/session',{headers:{Origin:origin}});assert.equal(response.status(),200);
   return await response.json() as {account:{id:string;name:string};csrf:string};
  };
  const cookies=async()=> (await jar.storageState()).cookies.filter(cookie=>cookie.name==='spindle_session');
  await post(legacy.origin,'/register',{name:'invented-legacy',password:'invented-password-123'});
  const legacyFirst=await read(legacy.origin),legacyCookie=(await cookies())[0];assert.equal(legacyCookie.domain,'127.0.0.1');
  await post(isolated.origin,'/register',{name:'invented-isolated',password:'invented-password-123'});
  const isolatedFirst=await read(isolated.origin);assert.notEqual(isolatedFirst.account.id,legacyFirst.account.id);
  assert.equal((await read(legacy.origin)).account.id,legacyFirst.account.id);
  let current=await cookies();assert.equal(current.length,2);
  const v6Cookie=current.find(cookie=>cookie.domain==='[::1]');assert.ok(v6Cookie);
  assert.equal(current.find(cookie=>cookie.domain==='127.0.0.1')!.value,legacyCookie.value);
  await post(isolated.origin,'/signin',{name:'invented-isolated',password:'invented-password-123'});
  const isolatedAgain=await read(isolated.origin);assert.deepEqual(isolatedAgain.account,isolatedFirst.account);
  assert.equal((await read(legacy.origin)).account.id,legacyFirst.account.id);
  current=await cookies();assert.equal(current.find(cookie=>cookie.domain==='127.0.0.1')!.value,legacyCookie.value);
  const logout=await jar.post(isolated.origin+'/logout',{headers:{Origin:isolated.origin,'X-CSRF-Token':isolatedAgain.csrf},data:{}});
  assert.equal(logout.status(),200);assert.equal((await jar.get(isolated.origin+'/session',{headers:{Origin:isolated.origin}})).status(),401);
  assert.deepEqual((await read(legacy.origin)).account,legacyFirst.account);
  await post(isolated.origin,'/signin',{name:'invented-isolated',password:'invented-password-123'});
  const activeV6=(await cookies()).find(cookie=>cookie.domain==='[::1]')!;
  await post(legacy.origin,'/signin',{name:'invented-legacy',password:'invented-password-123'});
  const legacyAgain=await read(legacy.origin);assert.deepEqual(legacyAgain.account,legacyFirst.account);
  assert.deepEqual((await read(isolated.origin)).account,isolatedFirst.account);
  assert.equal((await cookies()).find(cookie=>cookie.domain==='[::1]')!.value,activeV6.value);
  // A deliberate cookie sent to the other host never grants account authority.
  for(const [origin,cookie]of [[legacy.origin,activeV6.value],[isolated.origin,legacyCookie.value]]){
   const response=await fetch(origin+'/session',{headers:{Origin:origin,Cookie:'spindle_session='+cookie}});assert.equal(response.status,401);
  }
  const legacyLogout=await jar.post(legacy.origin+'/logout',{headers:{Origin:legacy.origin,'X-CSRF-Token':legacyAgain.csrf},data:{}});
  assert.equal(legacyLogout.status(),200);assert.equal((await jar.get(legacy.origin+'/session',{headers:{Origin:legacy.origin}})).status(),401);
  assert.deepEqual((await read(isolated.origin)).account,isolatedFirst.account);
 }finally{await jar.dispose();await isolated?.close();await legacy.close();await rm(directory,{recursive:true,force:true});}
});

test('loopback callback configuration mismatch rejects before acquiring the server lock',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'workos-cookie-config-')),key=randomBytes(32),port=await ipv6Port();
 try{
  const invalid={...config(port),webRedirectUri:'http://[::1]:'+port+'/wrong-callback'};
  await assert.rejects(startTrackingServer(directory,key,port,undefined,undefined,undefined,undefined,invalid),/WORKOS_EXACT_CALLBACK_REQUIRED/);
  await assert.rejects(access(join(directory,'server.lock')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
  const valid=await startTrackingServer(directory,key,port,undefined,undefined,undefined,undefined,config(port));
  try{assert.equal(valid.origin,'http://[::1]:'+port);}finally{await valid.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
