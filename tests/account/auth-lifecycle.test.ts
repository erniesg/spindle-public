import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
const password='invented-password-123';
const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
for(const stage of ['/logout','/session'])test(`explicit logout during signin's ${stage} delivery revokes all issued sessions`,async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/auth-repair/auth-')),key=randomBytes(32),arrived=deferred(),release=deferred();
 const server=await startTrackingServer(dir,key,0,undefined,{clientId:'invented',clientSecret:'invented',http:async()=>{throw Error('No Google HTTP allowed');}});
 let hold=false;const issued:{cookie:string;csrf:string}[]=[];
 const transport:typeof fetch=async(input,init)=>{
  const response=await fetch(input,init),path=new URL(String(input)).pathname;
  if(['/register','/signin'].includes(path)&&response.ok)issued.push({cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.clone().json()).csrf});
  if(hold&&path===stage){hold=false;arrived.resolve();await release.promise;}
  return response;
 };
 try{
  const client=new AccountClient(server.origin,transport),peer=new AccountClient(server.origin);
  await client.signin('invented-a',password,true);await peer.signin('invented-a',password);
  hold=true;const signing=client.signin('invented-b',password,true).then(()=>false,()=>true);await arrived.promise;
  const logout=client.signout();assert.equal(client.account,undefined);
  release.resolve();await logout;assert.equal(await signing,true,'cancelled signin must not resume authentication');assert.equal(client.account,undefined);
  for(const session of issued){
   const response=await fetch(server.origin+'/google/list',{method:'POST',headers:{Origin:server.origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'});
   assert.equal(response.status,401,'completed logout must revoke server authority, not only local identity');await response.body?.cancel();
  }
  assert.deepEqual((await peer.googleConnections()).connections,[],'another device session remains usable');
  await client.signin('invented-a',password);await assert.rejects(client.signin('invented-a','invented-wrong-password'),/401/);assert.equal(client.account,undefined);
  await client.signout();await peer.signout();
 }finally{release.resolve();await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('failed server revocation is not successful logout; retained authority can be revoked on retry',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/auth-repair/auth-')),key=randomBytes(32);
 const server=await startTrackingServer(dir,key);let failLogout=true,cookie='',csrf='';
 const client=new AccountClient(server.origin,async(input,init)=>{
  const path=new URL(String(input)).pathname;if(path==='/logout'&&failLogout)return new Response('{}',{status:503});
  const response=await fetch(input,init);if(path==='/register'){cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=(await response.clone().json()).csrf;}return response;
 });
 const status=async()=>{const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie,'X-CSRF-Token':csrf}});await response.body?.cancel();return response.status;};
 try{
  await client.signin('invented-owner',password,true);await assert.rejects(client.signout());assert.equal(client.account,undefined);
  assert.equal(await status(),200);failLogout=false;await client.signout();assert.equal(await status(),401,'retry must actually revoke the retained server session');
  await client.signin('invented-owner',password);await client.signout();
 }finally{await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('cancelled issued-session cleanup failure rejects logout and remains retryable',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/auth-repair/auth-')),key=randomBytes(32),arrived=deferred(),release=deferred();
 const server=await startTrackingServer(dir,key);let cookie='',csrf='',failLogout=true;
 const client=new AccountClient(server.origin,async(input,init)=>{
  const path=new URL(String(input)).pathname;if(path==='/logout'&&failLogout)return new Response('{}',{status:503});
  const response=await fetch(input,init);
  if(path==='/register'){cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=(await response.clone().json()).csrf;}
  if(path==='/session'){arrived.resolve();await release.promise;}return response;
 });
 try{
  const signing=assert.rejects(client.signin('invented-owner',password,true));await arrived.promise;
  const logout=assert.rejects(client.signout(),/503/);release.resolve();await logout;await signing;assert.equal(client.account,undefined);
  failLogout=false;await client.signout();
  const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie,'X-CSRF-Token':csrf}});assert.equal(response.status,401);await response.body?.cancel();
 }finally{release.resolve();await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('identity-validation failure revokes the issued session before returning failure',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/auth-repair/auth-')),key=randomBytes(32);
 const server=await startTrackingServer(dir,key);let cookie='';
 const client=new AccountClient(server.origin,async(input,init)=>{
  const response=await fetch(input,init),path=new URL(String(input)).pathname;
  if(path==='/register')cookie=response.headers.get('set-cookie')!.split(';')[0];
  if(path==='/session'&&response.ok){const value=await response.json();value.account.name='invented-wrong';return Response.json(value);}return response;
 });
 try{
  await assert.rejects(client.signin('invented-owner',password,true),/ACCOUNT_IDENTITY_MISMATCH/);
  const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});assert.equal(response.status,401);await response.body?.cancel();await client.signout();
 }finally{await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('indeterminate auth HTTP failure after server issuance is not confirmed logout',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/auth-repair/auth-')),key=randomBytes(32);
 const server=await startTrackingServer(dir,key);let cookie='';
 const client=new AccountClient(server.origin,async(input,init)=>{
  const response=await fetch(input,init);if(new URL(String(input)).pathname==='/register'){
   cookie=response.headers.get('set-cookie')!.split(';')[0];await response.body?.cancel();
   // A gateway/transport failure is not evidence that authentication had no effect.
   return new Response('{}',{status:503});
  }return response;
 });
 try{
  await assert.rejects(client.signin('invented-owner',password,true));
  const response=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}});assert.equal(response.status,200);await response.body?.cancel();
  await assert.rejects(client.signout(),/ACCOUNT_LOGOUT_UNCONFIRMED/);
 }finally{await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('lost authentication response cannot be acknowledged as confirmed logout',async()=>{
 const client=new AccountClient('https://example.test',async()=>{throw Error('invented lost response');});
 await assert.rejects(client.signin('invented-owner',password));await assert.rejects(client.signout(),/ACCOUNT_LOGOUT_UNCONFIRMED/);
});
