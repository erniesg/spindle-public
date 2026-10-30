import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {EncryptedStore} from '../../core/tracking/store.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const password='invented-password-123';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {resolve,promise};};
test('logout before queued credential CAS, failed durable write and discarded reply reconcile using the real encrypted service',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/shared-google/commit-')),key=randomBytes(32);
 const original=EncryptedStore.prototype.transaction;
 let next:undefined|(()=>Promise<void>),onProfile=()=>{},failNextWrite=false;
 // Test-only boundary instrumentation. The original encrypted transaction/load/save still runs.
 EncryptedStore.prototype.transaction=function(fn:any,write=true):any{const hook=write?next:undefined;if(write)next=undefined;const fail=write&&failNextWrite;if(write)failNextWrite=false;const wrapped=fail?async(s:any)=>{const result=await fn(s);Object.defineProperty(s,'toJSON',{value:()=>{throw Error('INVENTED_WRITE_FAILURE_SECRET');}});return result;}:fn;return hook?hook().then(()=>original.call(this,wrapped,write)):original.call(this,wrapped,write);};
 const http:typeof fetch=async input=>String(input).includes('/token')?Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:[scopes.mail,scopes.drive].join(' ')}):(onProfile(),Response.json({emailAddress:'invented@example.test'}));
 const server=await startTrackingServer(dir,key,0,undefined,{clientId:'invented',clientSecret:'INVENTED_SECRET',http});
 try{
  const a=new AccountClient(server.origin),b=new AccountClient(server.origin);await a.signin('invented-owner',password,true);await b.signin('invented-owner',password);
  const begin=async()=>{const f=await a.connectGoogle(),u=new URL(f.authorizationUrl),callback=new URL(u.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:u.searchParams.get('state')!,code:'invented-code'}).toString();return {id:f.connectionId,callback};};
  const f=await begin(),arrived=gate(),release=gate();onProfile=()=>{onProfile=()=>{};next=async()=>{arrived.resolve();await release.promise;};};
  const callback=fetch(f.callback);await arrived.promise;await a.signout();release.resolve();assert.notEqual((await callback).status,200);assert.ok((await b.googleConnections()).connections.every(c=>c.status!=='connected'));
  await a.signin('invented-owner',password);const failed=await begin();onProfile=()=>{onProfile=()=>{};failNextWrite=true;};const reply=await fetch(failed.callback);assert.notEqual(reply.status,200);assert.ok(!(await reply.text()).includes('INVENTED_WRITE_FAILURE_SECRET'));assert.ok((await b.googleConnections()).connections.every(c=>c.status!=='connected'));
  // Commit a real transaction, discard the response: only reconciliation establishes the outcome.
  const unknown=await begin();const response=await fetch(unknown.callback);await response.body?.cancel();assert.equal((await b.googleConnections()).connections.find(c=>c.id===unknown.id)?.status,'connected');
  const publicValues=[await a.request('/session'),await a.request('/history'),await a.request('/user-memory/activity'),await a.request('/user-memory/changes?workspaceId=invented&cursor=0'),await b.googleConnections()];
  for(const value of publicValues)for(const sentinel of ['INVENTED_ACCESS','INVENTED_REFRESH','INVENTED_SECRET','INVENTED_WRITE_FAILURE_SECRET',new URL(unknown.callback).searchParams.get('code')!])assert.ok(!JSON.stringify(value).includes(sentinel));
 }finally{next=undefined;EncryptedStore.prototype.transaction=original;await server.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
