import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient,AccountRequestFailure} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {SharedGoogleConfig} from '../../core/tracking/google.js';
import {EncryptedStore} from '../../core/tracking/store.js';

const outputGrant='https://www.googleapis.com/auth/drive.file';
const picker={appId:'123456789',developerKey:'INVENTED_BROWSER_KEY_123456789'};
async function fixture(configuration:SharedGoogleConfig['picker'],writeGrant=false){
 const directory=await mkdtemp(join(tmpdir(),'gout-')),key=randomBytes(32),calls:string[]=[];
 let grants=[scopes.mail,scopes.drive,...(writeGrant?[outputGrant]:[])],providerFailure=false;
 const http:typeof fetch=async input=>{const u=new URL(String(input));calls.push(u.pathname);if(providerFailure)throw Error('INVENTED_NETWORK_FAILURE');
  if(u.pathname==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:grants.join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',version:'7',mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:false,capabilities:{canAddChildren:true}});
  throw Error('Unexpected fake Google request');
 };
 const config:SharedGoogleConfig={clientId:'invented-client',clientSecret:'INVENTED_CLIENT_SECRET',http,picker:configuration};
 const server=await startTrackingServer(directory,key,0,undefined,config),client=new AccountClient(server.origin),readonlyClient=new AccountClient(server.origin),other=new AccountClient(server.origin);
 await client.signin('invented-owner','invented-password-123',true);await readonlyClient.signin('invented-owner','invented-password-123');await other.signin('invented-other','invented-password-123',true);
 const flow=await client.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);
 callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);
 await client.selectGoogleRoots(flow.connectionId,['root']);calls.length=0;
 return {directory,client,readonlyClient,other,flow,calls,config,dropWriteGrant:()=>{grants=[scopes.mail,scopes.drive];},setGrants:(value:string[])=>{grants=value;},failProvider:()=>{providerFailure=true;},snapshot:()=>readFile(join(directory,'tracking.enc')),close:async()=>{await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}
const failure=(status:number,code:string)=>(error:unknown)=>error instanceof AccountRequestFailure&&error.status===status&&error.code===code;

for(const [label,configuration,writeGrant,pickerConfigured,blocker] of [
 ['missing configuration and grant',undefined,false,false,'GOOGLE_PICKER_CONFIGURATION_REQUIRED'],
 ['invalid configuration',{...picker,appId:'not-a-project-number'},true,false,'GOOGLE_PICKER_CONFIGURATION_REQUIRED'],
 ['invalid developer key',{...picker,developerKey:'invalid'},false,false,'GOOGLE_PICKER_CONFIGURATION_REQUIRED'],
 ['missing grant',picker,false,true,'GOOGLE_OUTPUT_GRANT_REQUIRED'],
 ['available',picker,true,true,undefined]
] as const)test('safe authenticated output readiness: '+label,async()=>{
 const f=await fixture(configuration,writeGrant);try{
  const before=await f.snapshot(),first=await f.client.googleConnections(),row=first.connections[0]!;
  assert.deepEqual(row.outputReadiness,{pickerConfigured,grantPresent:writeGrant,...(blocker?{blocker}:{})});
  assert.deepEqual(await f.client.googleConnections(),first);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls.length,0,'status must not refresh tokens or poll Google');
  for(const secret of ['INVENTED_ACCESS','INVENTED_REFRESH','INVENTED_CLIENT_SECRET',picker.developerKey])assert.ok(!JSON.stringify(first).includes(secret));
  assert.deepEqual((await f.other.googleConnections()).connections,[]);
  await assert.rejects(f.other.googleOutputPicker(f.flow.connectionId,'root'));await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'unselected'));assert.equal(f.calls.length,0);
  if(blocker){await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'root'),failure(blocker==='GOOGLE_PICKER_CONFIGURATION_REQUIRED'?503:403,blocker));assert.equal(f.calls.length,0);assert.deepEqual(await f.snapshot(),before);}
  else {const capability=await f.client.googleOutputPicker(f.flow.connectionId,'root');assert.equal(capability.accessToken,'INVENTED_ACCESS');assert.equal(capability.appId,picker.appId);assert.equal(capability.rootId,'root');assert.deepEqual(f.calls,['/token']);await assert.rejects(f.client.checkGoogleOutputParent(f.flow.connectionId,'root'),failure(403,'GOOGLE_OUTPUT_PARENT_AUTHORIZATION_REQUIRED'));}
 }finally{await f.close();}
});

test('Picker configuration wins over missing grant before token access',async()=>{
 const f=await fixture(undefined);try{await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'root'),failure(503,'GOOGLE_PICKER_CONFIGURATION_REQUIRED'));assert.equal(f.calls.length,0);}finally{await f.close();}
});

test('parent check reports the genuine missing output grant without requiring Picker configuration',async()=>{
 const f=await fixture(undefined);try{await assert.rejects(f.client.checkGoogleOutputParent(f.flow.connectionId,'root'),failure(403,'GOOGLE_OUTPUT_GRANT_REQUIRED'));assert.equal(f.calls.length,0);}finally{await f.close();}
});

test('refresh reporting a reduced output grant returns typed recovery, never a browser token',async()=>{
 const f=await fixture(picker,true);try{f.dropWriteGrant();await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'root'),failure(403,'GOOGLE_OUTPUT_GRANT_REQUIRED'));assert.deepEqual(f.calls,['/token']);assert.equal((await f.client.googleConnections()).connections[0]!.outputReadiness.blocker,'GOOGLE_OUTPUT_GRANT_REQUIRED');}finally{await f.close();}
});

for(const endpoint of ['picker','parent'] as const)for(const [guard,change,status,code] of [
 [1,'grant',403,'GOOGLE_OUTPUT_GRANT_REQUIRED'],
 [2,'grant',403,'GOOGLE_OUTPUT_GRANT_REQUIRED'],
 [2,'root',409,'GOOGLE_ROOT_CHANGED'],
 [2,'session',401,'GOOGLE_AUTH_CONTEXT_CHANGED'],
 [2,'epoch',409,'GOOGLE_CONNECTION_CHANGED']
] as const)test(`concurrent readonly refresh CAS after grant guard ${guard}: ${endpoint}, ${change}`,async()=>{
 const f=await fixture(picker,true),original=EncryptedStore.prototype.transaction;
 let guards=0,armed=true,arrive!:()=>void,release!:()=>void;
 const arrived=new Promise<void>(r=>{arrive=r;}),held=new Promise<void>(r=>{release=r;});
 // Test-only scheduler holds a completed protected read, outside the real serialized transaction.
 // Reduced scopes are committed by the real readonly OAuth refresh/CAS, never direct state tampering.
 EncryptedStore.prototype.transaction=function(fn:any,write=true):any{
  const result=original.call(this,fn,write);
  if(armed&&this.directory===f.directory&&String(fn).includes('includes(outputGrant)')&&++guards===guard)return result.then(async value=>{armed=false;arrive();await held;return value;});
  return result;
 };
 const pending=(endpoint==='picker'?f.client.googleOutputPicker(f.flow.connectionId,'root'):f.client.checkGoogleOutputParent(f.flow.connectionId,'root')).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
 try{
  await Promise.race([arrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('Grant guard was not reached')),5000).unref())]);
  f.dropWriteGrant();await f.readonlyClient.checkGoogleDriveRoot(f.flow.connectionId,'root');
  assert.equal((await f.readonlyClient.googleConnections()).connections[0]!.outputReadiness.blocker,'GOOGLE_OUTPUT_GRANT_REQUIRED');
  if(change==='root')await f.readonlyClient.selectGoogleRoots(f.flow.connectionId,[]);
  if(change==='session')await f.client.signout();
  if(change==='epoch'){
   const flow=await f.readonlyClient.connectGoogle(f.flow.connectionId),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);
   callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);
  }
  const callsBeforeRelease=[...f.calls];release();const result=await pending;
  assert.equal(result.value,undefined,'no browser token or parent authority escapes');assert.ok(failure(status,code)(result.error),String(result.error));
  assert.deepEqual(f.calls,callsBeforeRelease,'failed output request must not dispatch after concurrent reduction');
  if(change!=='epoch')assert.deepEqual(f.calls,['/token','/drive/v3/files/root']);
 }finally{release();await pending;EncryptedStore.prototype.transaction=original;await f.close();}
});

test('output recovery preserves genuine provider and protected-store failures',async()=>{
 const f=await fixture(picker,true),original=EncryptedStore.prototype.transaction;try{
  f.failProvider();await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'root'),failure(502,'GOOGLE_NETWORK_UNAVAILABLE'));
  let armed=true;
  EncryptedStore.prototype.transaction=function(fn:any,write=true):any{
   if(armed&&this.directory===f.directory&&String(fn).includes('row(s).credential')){armed=false;return Promise.reject(Error('INVENTED_STORE_FAILURE'));}
   return original.call(this,fn,write);
  };
  await assert.rejects(f.client.checkGoogleOutputParent(f.flow.connectionId,'root'),failure(503,'STORE_OR_REQUEST_UNAVAILABLE'));assert.equal(armed,false);
  assert.equal((await f.client.googleConnections()).connections[0]!.outputReadiness.grantPresent,true);
 }finally{EncryptedStore.prototype.transaction=original;await f.close();}
});

test('incremental output recovery preserves the readonly connection and selected roots on denial',async()=>{
 const f=await fixture(picker);try{
  const flow=await f.client.authorizeGoogleOutputs(f.flow.connectionId),auth=new URL(flow.authorizationUrl);
  assert.equal(flow.connectionId,f.flow.connectionId);assert.equal(auth.searchParams.get('include_granted_scopes'),'true');assert.deepEqual(auth.searchParams.get('scope')!.split(' '),[scopes.mail,scopes.drive,'https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive'],'the output route requests the same single full consent');
  const callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,error:'access_denied'}).toString();assert.equal((await fetch(callback)).status,400);
  const row=(await f.client.googleConnections()).connections[0]!;assert.equal(row.status,'connected');assert.deepEqual(row.roots,['root']);assert.deepEqual(row.grants,[scopes.mail,scopes.drive]);assert.equal(row.outputReadiness.blocker,'GOOGLE_OUTPUT_GRANT_REQUIRED');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('full Drive grant makes output ready without Picker configuration; drive.file-only keeps the Picker requirement',async()=>{
 const f=await fixture(undefined);try{
  const flow=await f.client.authorizeGoogleOutputs(f.flow.connectionId),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);
  callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();
  const full='https://www.googleapis.com/auth/drive',compose='https://www.googleapis.com/auth/gmail.compose';
  f.setGrants([scopes.mail,compose,full]);assert.equal((await fetch(callback)).status,200);
  const row=(await f.client.googleConnections()).connections[0]!;
  assert.deepEqual(row.outputReadiness,{pickerConfigured:true,grantPresent:true});
  for(const implied of [scopes.drive,outputGrant,scopes.mail,compose,full])assert.ok(row.grants.includes(implied),implied);
  assert.deepEqual(row.missingGrants,[]);assert.equal(row.mailReadiness?.canDraft,true);assert.deepEqual(row.roots,['root']);
  assert.doesNotMatch(JSON.stringify(row),/INVENTED_(ACCESS|REFRESH|CLIENT_SECRET)/);
 }finally{await f.close();}
});
