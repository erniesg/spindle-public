import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {exportJWK,generateKeyPair,SignJWT,type JWTPayload} from 'jose';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient,type WorkOSSessionCredentials} from '../../core/account/client.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {PreviewSession} from '../../core/preview/session.js';
import type {WorkOSConfig} from '../../core/account/workos-provider.js';
import type {AuthenticatedSnapshot} from '../../core/pomodoro/client.js';

type Native={account:{id:string;name:string};tracking:WorkOSSessionCredentials;timer:WorkOSSessionCredentials};
async function freePort(){
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
 const port=(listener.address() as {port:number}).port;await new Promise<void>((r,j)=>listener.close(e=>e?j(e):r()));return port;
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'workos-signed-boundary-')),key=randomBytes(32),port=await freePort();
 const origin='http://127.0.0.1:'+port;
 const config:WorkOSConfig={clientId:'client_spindle',issuer:'https://api.workos.com/user_management/client_shared',jwksUri:'https://api.workos.com/sso/jwks/client_shared',webRedirectUri:origin+'/auth/workos/callback'};
 const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey),original=globalThis.fetch;
 const codes=new Map<string,string>();let next=0;
 const code=async(subject='user_owner',claims:JWTPayload={})=>{
  const value='invented-code-'+(++next),now=Math.floor(Date.now()/1000);
  const jwt=await new SignJWT({iss:config.issuer,sub:subject,sid:'session_fixture'+next,client_id:config.clientId,iat:now,exp:now+300,...claims})
   .setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(keys.privateKey);
  codes.set(value,jwt);return value;
 };
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url===config.jwksUri)return Response.json({keys:[{...jwk,kid:'fixture',alg:'RS256',use:'sig'}]});
  if(url==='https://api.workos.com/user_management/authenticate'){
   const request=JSON.parse(String(init?.body)) as {code:string;code_verifier:string;client_id:string};
   assert.equal(request.client_id,config.clientId);assert.equal(request.code_verifier,'v'.repeat(43));
   const jwt=codes.get(request.code);codes.delete(request.code);
   return jwt?Response.json({access_token:jwt,user:{id:'user_untrusted',email:'invented@example.test'}}):Response.json({error:'invalid_grant'},{status:400});
  }
  if(url.startsWith('https://api.workos.com'))throw Error('Unexpected provider endpoint');
  return original(input,init);
 };
 // Cast lets the test run RED before the optional eighth server argument exists.
 const start=startTrackingServer as unknown as (...args:[string,Buffer,number,undefined,undefined,undefined,undefined,WorkOSConfig])=>ReturnType<typeof startTrackingServer>;
 let server:Awaited<ReturnType<typeof startTrackingServer>>|undefined;
 const launch=async()=>{server=await start(join(directory,'server'),key,port,undefined,undefined,undefined,undefined,config);};
 try{await launch();}catch(error){globalThis.fetch=original;await rm(directory,{recursive:true,force:true});throw error;}
 const native=(value:string,requestOrigin=origin)=>original(origin+'/auth/workos/native',{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify({code:value,codeVerifier:'v'.repeat(43)})});
 return {directory,origin,config,code,native,request:original,
  issue:async(subject='user_owner')=>{const response=await native(await code(subject));assert.equal(response.status,200);return await response.json() as Native;},
  restart:async()=>{await server!.close();server=undefined;await launch();},
  close:async()=>{await server?.close();globalThis.fetch=original;await rm(directory,{recursive:true,force:true});},
 };
}

// Signed JWT fixtures exercise the actual provider/backend/client boundary.
// This is invented-data integration evidence, not a real-provider login proof.
test('signed-token fixture: native clients share durable history and timer with independent sessions',async()=>{
 const f=await fixture();let sink:CollectorHistory|undefined;
 try{
  const config=await f.request(f.origin+'/auth/workos/config');assert.equal(config.status,200);
  assert.deepEqual(await config.json(),{configured:true,clientId:f.config.clientId,backendOrigin:f.origin});
  const first=await f.issue();assert.deepEqual(first.account,first.tracking.account);assert.deepEqual(first.account,first.timer.account);
  assert.notEqual(first.tracking.cookie,first.timer.cookie);assert.notEqual(first.tracking.csrf,first.timer.csrf);
  const tracker=new TrackingClient(f.origin,join(f.directory,'client-one'),randomBytes(32));
  await tracker.signinWorkOSSession(first.tracking,'Invented Mac');const device=(await tracker.inspect()).deviceId;
  const capture=new PreviewSession();sink=new CollectorHistory(capture,tracker,device,3600000);
  assert.equal(capture.recording,false);assert.equal((await tracker.inspect()).pending,0);
  capture.start({pixels:false,rich:false,retain:true});await sink.settle();
  capture.focus({epoch:capture.epoch,revision:1,at:100,key:'invented/editor',app:'Editor',title:'Invented history',clock:'invented-boot'});await sink.settle();
  capture.sample({epoch:capture.epoch,revision:1,at:101,text:'Invented cross-device history',textSource:'native',status:'native-text'});await sink.settle();
  capture.pause(1000);await sink.settle();await sink.dispose();sink=undefined;
  await tracker.sync();
  const timer=new AccountClient(f.origin);assert.deepEqual(await timer.signinWorkOSSession(first.timer),first.account);
  const started=await timer.request('/pomodoro/command',{id:'invented-start',expectedRevision:0,action:'start'}) as AuthenticatedSnapshot;
  assert.equal(started.timer.status,'running');assert.equal(started.accountId,first.account.id);
  const second=await f.issue();assert.deepEqual(second.account,first.account);
  const otherTracker=new TrackingClient(f.origin,join(f.directory,'client-two'),randomBytes(32));
  await otherTracker.signinWorkOSSession(second.tracking,'Invented second Mac');
  assert.notEqual((await otherTracker.inspect()).deviceId,device);
  let history=await otherTracker.sessions(Date.now()-60000,Date.now()+60000);assert.equal(history.visits.length,1);
  assert.equal(history.visits[0].context.text,'Invented cross-device history');
  const otherTimer=new AccountClient(f.origin);await otherTimer.signinWorkOSSession(second.timer);
  assert.equal((await otherTimer.request('/pomodoro/read',{}) as AuthenticatedSnapshot).timer.revision,1);
  await timer.signout();assert.equal((await tracker.sessions(Date.now()-60000,Date.now()+60000)).visits.length,1);
  await f.restart();
  const third=await f.issue();assert.deepEqual(third.account,first.account);
  const afterRestart=new AccountClient(f.origin);await afterRestart.signinWorkOSSession(third.timer);
  const persisted=await afterRestart.request('/pomodoro/read',{}) as AuthenticatedSnapshot;
  assert.equal(persisted.timer.status,'running');assert.equal(persisted.timer.revision,1);
  history=await otherTracker.sessions(Date.now()-60000,Date.now()+60000);assert.equal(history.visits.length,1);
  const isolated=await f.issue('user_other');assert.notEqual(isolated.account.id,first.account.id);
  const isolatedTracker=new TrackingClient(f.origin,join(f.directory,'isolated'),randomBytes(32));
  await isolatedTracker.signinWorkOSSession(isolated.tracking,'Invented other user');
  assert.equal((await isolatedTracker.sessions(Date.now()-60000,Date.now()+60000)).visits.length,0);
  const isolatedTimer=new AccountClient(f.origin);await isolatedTimer.signinWorkOSSession(isolated.timer);
  assert.equal((await isolatedTimer.request('/pomodoro/read',{}) as AuthenticatedSnapshot).timer.status,'idle');
 }finally{await sink?.dispose();await f.close();}
});

test('signed-token fixture: wrong issuer/client, code replay and cross-site calls fail; direct password login remains',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.request(f.origin+'/auth/workos/config')).status,200);
  for(const claims of [{client_id:'client_sibling'},{iss:'https://api.workos.com/user_management/client_other'}]){
   const response=await f.native(await f.code('user_owner',claims));assert.equal(response.status,400);assert.equal(response.headers.get('set-cookie'),null);
  }
  const valid=await f.code();assert.equal((await f.native(valid,'https://cross-site.example')).status,403);
  assert.equal((await f.native(valid)).status,200);assert.equal((await f.native(valid)).status,400);
  const direct=new AccountClient(f.origin);const account=await direct.signin('invented-direct','invented-password-123',true);
  await direct.signout();assert.deepEqual(await direct.signin('invented-direct','invented-password-123'),account);
  const workos=await f.issue();assert.notEqual(workos.account.id,account.id);
 }finally{await f.close();}
});
