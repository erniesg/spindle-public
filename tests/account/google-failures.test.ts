import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {SharedGoogle,type PrivateGoogleConnection} from '../../core/tracking/google.js';
import type {GoogleConnections} from '../../core/account/google-client.js';
import {scopes} from '../../core/connectors/google/oauth.js';

// Production encrypted persistence + actual HTTP; only Google responses are invented.
const parent=join(process.cwd(),'.local/actual-flow/fixtures');
async function fixture(){
 await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'failures-')),key=randomBytes(32);
 let mode='ok',calls=0,blocked:Promise<void>|undefined,arrived:(()=>void)|undefined,release:(()=>void)|undefined;const events:unknown[]=[];
 const http:typeof fetch=async input=>{
  calls++;const u=new URL(String(input));
  if(u.pathname==='/revoke')return new Response('',{status:200});
  if(mode==='network')throw Error('PRIVATE_PROVIDER_BODY_SENTINEL');
  if(u.pathname==='/token'){
   if(blocked){arrived?.();await blocked;}
   if(mode==='token400')return new Response('PRIVATE_PROVIDER_BODY_SENTINEL',{status:400});
   if(mode==='config')return new Response('PRIVATE_PROVIDER_BODY_SENTINEL',{status:401});
   if(mode==='config400')return Response.json({error:'invalid_client',error_description:'PRIVATE_PROVIDER_BODY_SENTINEL'},{status:400});
   return Response.json({access_token:'PRIVATE_ACCESS_SENTINEL',...(mode==='refreshMissing'?{}:{refresh_token:'PRIVATE_REFRESH_SENTINEL'}),scope:mode==='driveOnly'?scopes.drive:mode==='mailOnly'?scopes.mail:[scopes.mail,scopes.drive].join(' ')});
  }
  if(u.pathname.endsWith('/profile'))return mode==='profile403'?new Response('PRIVATE_PROVIDER_BODY_SENTINEL',{status:403}):Response.json({emailAddress:'invented@example.test'});
  throw Error('Unexpected fixture request');
 };
 const config={clientId:'invented-web',clientSecret:'PRIVATE_CLIENT_SENTINEL',http,telemetry:(event:unknown)=>events.push(event)};
 let server=await startTrackingServer(directory,key,0,undefined,config);const client=new AccountClient(server.origin);
 await client.signin('invented-owner','invented-password-123',true);
 const callback=(flow:{authorizationUrl:string},denied=false)=>{const u=new URL(flow.authorizationUrl),url=new URL(u.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:u.searchParams.get('state')!,...(denied?{error:'access_denied',error_description:'PRIVATE_PROVIDER_BODY_SENTINEL'}:{code:'PRIVATE_CODE_SENTINEL'})}).toString();return url;};
 return {directory,server,client,events,callback,hold:()=>{const started=new Promise<void>(r=>{arrived=r;});blocked=new Promise<void>(r=>{release=r;});return {started,release:()=>{release?.();blocked=undefined;}};},restart:async()=>{await server.close();server=await startTrackingServer(directory,key,0,undefined,config);const reopened=new AccountClient(server.origin);await reopened.signin('invented-owner','invented-password-123');return reopened;},setMode:(value:string)=>{mode=value;},calls:()=>calls,close:async()=>{release?.();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}
for(const [mode,code,status,stage] of [
 ['denied','GOOGLE_CONSENT_DENIED',400,'callback'],['driveOnly','GOOGLE_IDENTITY_GRANT_REQUIRED',403,'profile'],
 ['refreshMissing','GOOGLE_REFRESH_CREDENTIAL_REQUIRED',400,'token'],['profile403','GOOGLE_PROFILE_DENIED',403,'profile'],
 ['token400','GOOGLE_TOKEN_REJECTED',400,'token'],['config','GOOGLE_CLIENT_CONFIGURATION',502,'token'],['config400','GOOGLE_CLIENT_CONFIGURATION',502,'token'],['network','GOOGLE_NETWORK_UNAVAILABLE',502,'token']
] as const)test(`callback ${mode}: safe recoverable owner-row failure, not storage503; reload and reconnect`,async()=>{
 const f=await fixture();try{
  f.setMode(mode);const flows=await Promise.all([f.client.connectGoogle(),f.client.connectGoogle(),f.client.connectGoogle()]);
  assert.equal(new Set(flows.map(v=>v.connectionId)).size,1);assert.equal(new Set(flows.map(v=>v.authorizationUrl)).size,1);
  const flow=flows[0],url=f.callback(flow,mode==='denied'),result=await fetch(url);assert.equal(result.status,status);
  const body=await result.json() as any;assert.equal(body.code,code);assert.equal(body.stage,stage);assert.equal(body.action,'RETURN_TO_CONNECTIONS');
  let rows=(await f.client.googleConnections()).connections;assert.equal(rows.length,1);assert.equal(rows[0].status,'disconnected');assert.equal(rows[0].accountId,undefined);assert.equal((rows[0] as any).lastAttempt.code,code);
  assert.equal((await f.client.googleConnections()).connections[0].id,flow.connectionId);
  const replay=await fetch(url,{headers:{Accept:'text/html'},redirect:'manual'});assert.equal(replay.status,303,'a replayed browser callback is refused and sent back to the app');assert.equal(replay.headers.get('location'),'/portal#connections/failed');const html=await replay.text();assert.equal(html,'');assert.ok(!html.includes('PRIVATE_'));
  const replayJson=await fetch(url);assert.equal(replayJson.status,409);assert.equal((await replayJson.json() as any).code,'GOOGLE_FLOW_EXPIRED_OR_USED');assert.equal(replay.headers.get('referrer-policy'),'no-referrer');assert.equal(replay.headers.get('cache-control'),'no-store');
  if(mode==='denied')assert.equal(f.calls(),0);
  assert.ok(!JSON.stringify([body,rows,f.events]).includes('PRIVATE_'));assert.ok(!JSON.stringify(f.events).includes('invented@example.test'));
  f.setMode('mailOnly');const retry=await f.client.connectGoogle(flow.connectionId);assert.equal(retry.connectionId,flow.connectionId);assert.equal((await fetch(f.callback(retry))).status,200);
  rows=(await f.client.googleConnections()).connections;assert.equal(rows[0].status,'connected');assert.deepEqual(rows[0].missingGrants,[scopes.drive,'https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive'],'missing grants include compose and full Drive from the single consent');assert.equal((rows[0] as any).lastAttempt.status,'succeeded');
  assert.ok(f.events.length>0);
 }finally{await f.close();}
});
test('failed reconnect retains working credential/roots, explicit disconnect pending is durable and no false pending',async()=>{
 const f=await fixture();try{
  const first=await f.client.connectGoogle();assert.equal((await fetch(f.callback(first))).status,200);await f.client.selectGoogleRoots(first.connectionId,['invented-root']);
  f.setMode('profile403');const reconnect=await f.client.connectGoogle(first.connectionId);assert.equal((await fetch(f.callback(reconnect))).status,403);
  let row=(await f.client.googleConnections()).connections[0];assert.equal(row.status,'connected');assert.equal(row.accountId,'invented@example.test');assert.deepEqual(row.roots,['invented-root']);assert.equal((row as any).lastAttempt.code,'GOOGLE_PROFILE_DENIED');
  await f.client.disconnectGoogle(first.connectionId);row=(await f.client.googleConnections()).connections[0];assert.equal(row.status,'disconnected');
  const pending=await f.client.connectGoogle();assert.equal((await f.client.disconnectGoogle(pending.connectionId)).revocation,'uncertain');row=(await f.client.googleConnections()).connections.find(r=>r.id===pending.connectionId)!;assert.equal(row.status,'disconnected');assert.equal((await fetch(f.callback(pending))).status,409);
 }finally{await f.close();}
});
test('racing sessions cannot replace an active lease; repeated begin during callback cannot invalidate its CAS',async()=>{
 const f=await fixture();try{
  const flow=await f.client.connectGoogle(),other=new AccountClient(f.server.origin);await other.signin('invented-owner','invented-password-123');
  await assert.rejects(other.connectGoogle(),(error:any)=>error.status===409&&error.code==='GOOGLE_ATTEMPT_IN_PROGRESS');
  const held=f.hold(),callback=fetch(f.callback(flow));await held.started;
  for(const begin of [()=>f.client.connectGoogle(),()=>f.client.connectGoogle(flow.connectionId)])await assert.rejects(begin(),(error:any)=>error.status===409&&error.code==='GOOGLE_ATTEMPT_IN_PROGRESS');
  held.release();assert.equal((await callback).status,200);const rows=(await other.googleConnections()).connections;assert.equal(rows.length,1);assert.equal(rows[0].status,'connected');
 }finally{await f.close();}
});
test('saved failure survives encrypted service reopen; an orphaned pending attempt is recoverable without another row',async()=>{
 const f=await fixture();try{
  const flow=await f.client.connectGoogle();assert.equal((await fetch(f.callback(flow,true))).status,400);
  const reopened=await f.restart();const row=(await reopened.googleConnections()).connections[0];assert.equal((row as any).lastAttempt.code,'GOOGLE_CONSENT_DENIED');
  const retry=await reopened.connectGoogle(row.id);const again=await f.restart();const rows=(await again.googleConnections()).connections;assert.equal(rows.length,1);assert.equal((rows[0] as any).lastAttempt.code,'GOOGLE_FLOW_EXPIRED_OR_USED');assert.equal(rows[0].status,'disconnected');
  const resumed=await again.connectGoogle();assert.equal(resumed.connectionId,retry.connectionId);
 }finally{await f.close();}
});
test('expiry is projected honestly and does not call Google',async()=>{
 const f=await fixture();const now=Date.now;try{
  const flow=await f.client.connectGoogle();Date.now=()=>now()+300001;
  assert.equal((await fetch(f.callback(flow))).status,409);const row=(await f.client.googleConnections()).connections[0];assert.equal((row as any).lastAttempt.code,'GOOGLE_FLOW_EXPIRED_OR_USED');assert.equal(row.status,'disconnected');assert.equal(f.calls(),0);
 }finally{Date.now=now;await f.close();}
});
test('twelve legacy rows reopen as inactive without writes or invented causes; explicit reconnect reuses one row',async()=>{
 const parent=join(process.cwd(),'.local/legacy-recovery/fixtures');await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(join(parent,'legacy-')),key=randomBytes(32),owner=randomUUID();let calls=0;
 const legacy:PrivateGoogleConnection[]=Array.from({length:12},(_,i)=>({id:randomUUID(),incarnation:randomUUID(),roots:['invented-root-'+i],rootRevision:i+7}));
 const verified:PrivateGoogleConnection={id:randomUUID(),incarnation:randomUUID(),identity:'verified@example.test',credential:JSON.stringify({accountId:'verified@example.test',refreshToken:'INVENTED_REFRESH',grants:[scopes.mail,scopes.drive]}),roots:['invented-verified-root'],rootRevision:4};
 const initial={accounts:[{id:owner,google:[...legacy,verified]}],sessions:{session:{account:owner,expires:Date.now()+60000}}};
 const config={clientId:'invented',clientSecret:'invented',http:(async()=>{calls++;throw Error('No provider access permitted');}) as typeof fetch};
 let store=new EncryptedStore(directory,key,()=>structuredClone(initial)),google=new SharedGoogle(store,config,()=> 'http://127.0.0.1:12345');
 try{
  await store.transaction(()=>{});await google.close();await store.settle();
  const before=await readFile(join(directory,'tracking.enc'));
  store=new EncryptedStore(directory,key,()=>structuredClone(initial));google=new SharedGoogle(store,config,()=> 'http://127.0.0.1:12345');
  const list=()=>google.handle(owner,'session','/google/list',{}) as Promise<GoogleConnections>;
  for(let refresh=0;refresh<2;refresh++){
   const rows=(await list()).connections;assert.equal(rows.length,13);
   for(const [i,row] of rows.slice(0,12).entries()){
    assert.equal(row.status,'disconnected');assert.equal(row.recovery,'no_active_authorization');assert.equal(row.lastAttempt,undefined);assert.equal(row.accountId,undefined);assert.equal(row.revocation,undefined);
    assert.equal(row.id,legacy[i].id);assert.deepEqual(row.roots,legacy[i].roots);assert.equal(row.rootRevision,legacy[i].rootRevision);
   }
   assert.equal(rows[12].status,'connected');assert.equal(rows[12].recovery,undefined);assert.equal(rows[12].lastAttempt,undefined);
  }
  assert.deepEqual(await readFile(join(directory,'tracking.enc')),before,'list/refresh must not migrate encrypted bytes');
  assert.deepEqual(await store.transaction(s=>s,false),initial);assert.equal(calls,0);
  const flow=await google.handle(owner,'session','/google/begin',{connectionId:legacy[0].id}) as {connectionId:string};assert.equal(flow.connectionId,legacy[0].id);
  const rows=(await list()).connections;assert.equal(rows.length,13);assert.equal(rows[0].status,'pending');assert.equal(rows[0].recovery,undefined);assert.equal(rows[0].lastAttempt?.status,'pending');
  assert.equal(rows.slice(1,12).filter(r=>r.recovery==='no_active_authorization').length,11);
  const after=await store.transaction(s=>s,false);assert.deepEqual(after.sessions,initial.sessions);assert.deepEqual(after.accounts[0].google.slice(1),initial.accounts[0].google.slice(1));
  assert.deepEqual(after.accounts[0].google.map(r=>({id:r.id,roots:r.roots,rootRevision:r.rootRevision})),initial.accounts[0].google.map(r=>({id:r.id,roots:r.roots,rootRevision:r.rootRevision})));
  await google.handle(owner,'session','/google/disconnect',{connectionId:legacy[0].id});
  const stopped=(await list()).connections[0];assert.equal(stopped.status,'disconnected');assert.equal(stopped.lastAttempt?.status,'disconnected');assert.equal(stopped.recovery,undefined);assert.equal(stopped.revocation,'uncertain');assert.equal(calls,0);
 }finally{await google.close();await store.settle();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
test('real encrypted store failure stays503 and is not consent denied',async()=>{
 const f=await fixture();try{const flow=await f.client.connectGoogle();await writeFile(join(f.directory,'tracking.enc'),'invented corrupt encrypted fixture');const response=await fetch(f.callback(flow));assert.equal(response.status,503);assert.equal((await response.json() as any).code,'STORE_OR_REQUEST_UNAVAILABLE');}finally{await f.close();}
});
