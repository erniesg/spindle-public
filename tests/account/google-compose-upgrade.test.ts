import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import type {GoogleConnectionStart} from '../../core/account/google-client.js';
import {scopes} from '../../core/connectors/google/oauth.js';

const compose='https://www.googleapis.com/auth/gmail.compose',driveFile='https://www.googleapis.com/auth/drive.file';
const originalGrants=[scopes.mail,scopes.drive,driveFile];
// One consent: every connect/upgrade requests Gmail read+compose and full Drive (drive.file is implied, so not re-requested).
const fullDrive='https://www.googleapis.com/auth/drive',consent=[scopes.mail,scopes.drive,compose,fullDrive],upgraded=[...originalGrants,compose,fullDrive];
function callback(flow:GoogleConnectionStart,parameters:Record<string,string>={code:'invented-code'}){const auth=new URL(flow.authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:auth.searchParams.get('state')!,...parameters}).toString();return url;}
const authorize=(client:AccountClient,id:string)=>client.authorizeGoogleMail(id);
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'compose-upgrade-')),key=randomBytes(32),calls:string[]=[];
 let grants=[...originalGrants],identity='invented@example.test',holdPath='',arrive=()=>{},release=()=>{},held=Promise.resolve();
 const config={clientId:'invented-existing-client',clientSecret:'INVENTED_SECRET',http:async(input:Parameters<typeof fetch>[0])=>{
  const path=new URL(String(input)).pathname;calls.push(path);if(path===holdPath){arrive();await held;}
  if(path==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:grants.join(' ')});
  if(path.endsWith('/profile'))return Response.json({emailAddress:identity});
  throw Error('Unexpected provider request: '+path);
 }};
 let server=await startTrackingServer(directory,key,0,undefined,config);
 const client=new AccountClient(server.origin),peer=new AccountClient(server.origin),other=new AccountClient(server.origin);
 await client.signin('invented-owner','invented-password-123',true);await peer.signin('invented-owner','invented-password-123');await other.signin('invented-other','invented-password-123',true);
 const first=await client.connectGoogle();assert.equal((await fetch(callback(first))).status,200);await client.selectGoogleRoots(first.connectionId,['root']);calls.length=0;
 return {client,peer,other,first,calls,directory,key,setGrants:(value:string[])=>{grants=value;},setIdentity:(value:string)=>{identity=value;},snapshot:()=>readFile(join(directory,'tracking.enc')),
  hold:(path:string)=>{holdPath=path;held=new Promise<void>(r=>{release=r;});return new Promise<void>(r=>{arrive=r;});},release:()=>release(),
  restart:async()=>{const port=Number(new URL(server.origin).port);await server.close();server=await startTrackingServer(directory,key,port,undefined,config);},
  close:async()=>{release();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}

test('compose upgrade uses the existing identity/client, retains all grants/roots, and only records provider-verified grants',async()=>{
 const f=await fixture();try{
  const before=(await f.client.googleConnections()).connections[0]!,flow=await authorize(f.client,f.first.connectionId),auth=new URL(flow.authorizationUrl);
  assert.equal(auth.searchParams.get('client_id'),'invented-existing-client');assert.equal(flow.connectionId,before.id);assert.equal(auth.searchParams.get('include_granted_scopes'),'true');
  assert.deepEqual(auth.searchParams.get('scope')!.split(' '),consent);assert.deepEqual(f.calls,[]);
  assert.deepEqual(await authorize(f.client,before.id),flow,'repeated same-purpose request resumes the exact unused lease');
  await assert.rejects(f.client.authorizeGoogleOutputs(before.id),/GOOGLE_ATTEMPT_IN_PROGRESS/);
  await assert.rejects(f.client.connectGoogle(before.id),/GOOGLE_ATTEMPT_IN_PROGRESS/);
  await assert.rejects(authorize(f.peer,before.id),/GOOGLE_ATTEMPT_IN_PROGRESS/);
  f.setGrants(upgraded);assert.equal((await fetch(callback(flow))).status,200);
  const row=(await f.client.googleConnections()).connections[0]!;assert.deepEqual(row.grants,upgraded);assert.equal(row.accountId,before.accountId);assert.deepEqual(row.roots,before.roots);assert.equal(row.rootRevision,before.rootRevision);assert.equal(row.status,'connected');assert.equal(row.lastAttempt?.status,'succeeded');assert.equal((await f.client.googleConnections()).connections.length,1);
  assert.deepEqual(f.calls,['/token','/gmail/v1/users/me/profile']);
  const snapshot=await f.snapshot();assert.equal((await fetch(callback(flow))).status,409);assert.deepEqual(await f.snapshot(),snapshot);
  assert.doesNotMatch(JSON.stringify(row),/INVENTED_(SECRET|ACCESS|REFRESH)/);
  await f.restart();assert.deepEqual((await f.client.googleConnections()).connections[0]!.grants,upgraded,'actual encrypted reopen retains the verified compose grant');
  const output=await f.client.authorizeGoogleOutputs(row.id);assert.ok(new URL(output.authorizationUrl).searchParams.get('scope')!.split(' ').includes(compose),'a subsequent output upgrade retains compose');
  f.setGrants([...originalGrants]);const reduced=await fetch(callback(output));assert.equal(reduced.status,403);assert.equal((await reduced.json()).code,'GOOGLE_OUTPUT_GRANT_REQUIRED');assert.ok((await f.client.googleConnections()).connections[0]!.grants.includes(compose));
 }finally{await f.close();}
});

for(const [name,granted,parameters,status] of [
 ['denied',originalGrants,{error:'access_denied'},400],
 ['missing compose',originalGrants,{code:'invented-code',scope:compose},403],
 ['missing prior drive.file',[scopes.mail,scopes.drive,compose],{code:'invented-code'},403],
 ['missing full Drive',[...originalGrants,compose],{code:'invented-code'},403]
] as const)test('compose '+name+' preserves the previously verified credential and selected roots',async()=>{
 const f=await fixture();try{
  const before=(await f.client.googleConnections()).connections[0]!,flow=await authorize(f.client,before.id);f.setGrants([...granted]);
  const response=await fetch(callback(flow,parameters));assert.equal(response.status,status);
  if(status===403)assert.equal((await response.json()).code,'GOOGLE_MAIL_GRANT_REQUIRED');
  const row=(await f.client.googleConnections()).connections[0]!;assert.deepEqual(row.grants,before.grants);assert.deepEqual(row.roots,before.roots);assert.equal(row.rootRevision,before.rootRevision);assert.equal(row.accountId,before.accountId);assert.equal(row.status,'connected');assert.equal(row.lastAttempt?.status,'failed');
  assert.deepEqual(f.calls,status===400?[]:['/token']);
 }finally{await f.close();}
});

test('compose route is owner/session/CSRF and fixed-field bound, never creates a new account connection',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot();
  await assert.rejects(authorize(f.other,f.first.connectionId),/ACCOUNT_HTTP_404/);
  await assert.rejects(f.client.request('/google/mail/begin',{}),/ACCOUNT_HTTP_400/);
  await assert.rejects(f.client.request('/google/mail/begin',{connectionId:f.first.connectionId,scope:compose}),/ACCOUNT_HTTP_400/);
  const response=await fetch(f.client.origin+'/google/mail/begin',{method:'POST',headers:{Origin:f.client.origin,'Content-Type':'application/json'},body:JSON.stringify({connectionId:f.first.connectionId})});assert.notEqual(response.status,200);
  assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.calls,[]);assert.equal((await f.client.googleConnections()).connections.length,1);
 }finally{await f.close();}
});

test('compose callback verifies the same Google identity rather than browser labels',async()=>{
 const f=await fixture();try{
  const flow=await authorize(f.client,f.first.connectionId);f.setGrants(upgraded);f.setIdentity('different@example.test');
  const response=await fetch(callback(flow));assert.equal(response.status,409);assert.equal((await response.json()).code,'GOOGLE_IDENTITY_MISMATCH');
  const row=(await f.client.googleConnections()).connections[0]!;assert.equal(row.accountId,'invented@example.test');assert.deepEqual(row.grants,originalGrants);assert.deepEqual(row.roots,['root']);
 }finally{await f.close();}
});

for(const boundary of ['/token','/gmail/v1/users/me/profile'])for(const change of ['signout','roots','disconnect'] as const)test('compose callback fences '+change+' during '+boundary,async()=>{
 const f=await fixture();let pending:Promise<Response>|undefined;try{
  const flow=await authorize(f.client,f.first.connectionId);f.setGrants(upgraded);const arrived=f.hold(boundary);pending=fetch(callback(flow));
  await Promise.race([arrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('Provider gate not reached')),5000).unref())]);
  if(change==='signout')await f.client.signout();else if(change==='roots')await f.peer.selectGoogleRoots(flow.connectionId,['other-root']);else await f.peer.disconnectGoogle(flow.connectionId).catch(()=>{});
  f.release();assert.notEqual((await pending).status,200);
  const row=(await f.peer.googleConnections()).connections[0]!;assert.ok(!row.grants.includes(compose));
  if(change!=='disconnect'){assert.equal(row.status,'connected');assert.deepEqual(row.grants,originalGrants);}else assert.equal(row.status,'disconnected');
  if(boundary==='/token')assert.ok(!f.calls.some(p=>p.endsWith('/profile')),'no profile I/O after stale token boundary');
 }finally{f.release();await pending;await f.close();}
});

test('expired compose lease performs no provider I/O and preserves the connection',async()=>{
 const f=await fixture(),now=Date.now;try{
  const flow=await authorize(f.client,f.first.connectionId);const expired=now()+300001;Date.now=()=>expired;
  assert.equal((await fetch(callback(flow))).status,409);assert.deepEqual(f.calls,[]);
  const row=(await f.client.googleConnections()).connections[0]!;assert.deepEqual(row.grants,originalGrants);assert.deepEqual(row.roots,['root']);assert.equal(row.status,'connected');
 }finally{Date.now=now;await f.close();}
});

test('interrupted compose flow survives restart as retained connection, never a restored lease or fabricated grant',async()=>{
 const f=await fixture();try{
  const first=await authorize(f.client,f.first.connectionId);await f.restart();
  assert.equal((await fetch(callback(first))).status,409);const row=(await f.client.googleConnections()).connections[0]!;
  assert.equal(row.status,'connected');assert.deepEqual(row.grants,originalGrants);assert.deepEqual(row.roots,['root']);assert.equal(row.lastAttempt?.status,'failed');assert.deepEqual(f.calls,[]);
  const next=await authorize(f.client,f.first.connectionId);assert.equal(next.connectionId,first.connectionId);assert.notEqual(next.authorizationUrl,first.authorizationUrl);assert.equal((await f.client.googleConnections()).connections.length,1);
 }finally{await f.close();}
});
