import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {GoogleTelemetry} from '../../core/tracking/google.js';

test('real HTTP/encrypted callback: issuer/extensions compatibility, secret-free persisted reasons, verified roots and reload',async()=>{
 const parent=join(process.cwd(),'.local/callback-contract/fixtures');await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(join(parent,'http-')),key=randomBytes(32),events:GoogleTelemetry[]=[];let calls=0,malformed=false;
 const config={clientId:'invented',clientSecret:'PRIVATE_CLIENT',telemetry:(event:GoogleTelemetry)=>events.push(event),http:(async input=>{
  calls++;if(String(input).endsWith('/token'))return malformed?new Response('PRIVATE_PROVIDER_BODY',{status:401}):Response.json({access_token:'PRIVATE_ACCESS',refresh_token:'PRIVATE_REFRESH',scope:[scopes.mail,scopes.drive].join(' ')});
  return Response.json({emailAddress:'verified@example.test'});
 }) as typeof fetch};
 let app=await startTrackingServer(directory,key,0,undefined,config);let client=new AccountClient(app.origin);
 try{
  await client.signin('invented-owner','invented-password-123',true);
  let id:string|undefined;
  const callback=async()=>{const flow=await client.connectGoogle(id);id=flow.connectionId;const auth=new URL(flow.authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'PRIVATE_CODE',iss:'https://accounts.google.com',hd:'untrusted.example',scope:scopes.mail,authuser:'0',prompt:'consent'}).toString();return url;};
  for(const [reason,mutate] of [
   ['issuer_mismatch',(u:URL)=>u.searchParams.set('iss','https://wrong.invalid')],
   ['duplicate_parameter',(u:URL)=>u.searchParams.append('iss','https://accounts.google.com')],
   ['unsupported_parameter',(u:URL)=>u.searchParams.set('PRIVATE_NAME','PRIVATE_VALUE')],
   ['missing_code',(u:URL)=>u.searchParams.delete('code')]
  ] as const){
   const url=await callback();mutate(url);const before=calls,result=await fetch(url);assert.equal(result.status,400);const body=await result.json() as any;
   assert.equal(body.code,'GOOGLE_CALLBACK_INVALID');assert.equal(body.reason,reason);assert.equal(body.stage,'callback');assert.equal(body.action,'RETURN_TO_CONNECTIONS');assert.equal(calls,before);
   const row=(await client.googleConnections()).connections[0];assert.equal(row.lastAttempt?.reason,reason);assert.equal(row.status,'disconnected');assert.equal(row.id,id);assert.equal(events.at(-1)?.reason,reason);
   assert.ok(!JSON.stringify([body,row,events]).includes('PRIVATE_'));assert.ok(!JSON.stringify(events).includes('untrusted.example'));
  }
  const htmlUrl=await callback();htmlUrl.searchParams.set('iss','https://wrong.invalid');const htmlResponse=await fetch(htmlUrl,{headers:{Accept:'text/html'},redirect:'manual'});
  // Browser navigations go straight back into the app with only a fixed outcome category; the reason stays on the owner row.
  assert.equal(htmlResponse.status,303);assert.equal(htmlResponse.headers.get('location'),'/portal#connections/failed');const html=await htmlResponse.text();assert.ok(!html.includes('PRIVATE_'));assert.ok(!htmlResponse.headers.get('location')!.includes('PRIVATE_'));
  assert.equal(htmlResponse.headers.get('referrer-policy'),'no-referrer');assert.equal(htmlResponse.headers.get('cache-control'),'no-store');
  assert.equal((await client.googleConnections()).connections[0].lastAttempt?.reason,'issuer_mismatch');
  malformed=true;const rejected=await fetch(await callback());assert.equal(rejected.status,502);const rejectedBody=await rejected.json() as any;assert.equal(rejectedBody.code,'GOOGLE_CLIENT_CONFIGURATION');assert.equal(rejectedBody.reason,undefined);assert.ok(!JSON.stringify(rejectedBody).includes('PRIVATE_'));
  malformed=false;assert.equal((await fetch(await callback())).status,200);await client.selectGoogleRoots(id!,['invented-root']);let rows=(await client.googleConnections()).connections;
  assert.equal(rows.length,1);assert.equal(rows[0].accountId,'verified@example.test');assert.equal(rows[0].status,'connected');assert.deepEqual(rows[0].grants,[scopes.mail,scopes.drive]);assert.deepEqual(rows[0].roots,['invented-root']);assert.equal(rows[0].lastAttempt?.reason,undefined);
  // Real encrypted reopen, not a projection-only mock.
  await app.close();app=await startTrackingServer(directory,key,0,undefined,config);client=new AccountClient(app.origin);await client.signin('invented-owner','invented-password-123');rows=(await client.googleConnections()).connections;assert.equal(rows[0].id,id);assert.equal(rows[0].accountId,'verified@example.test');assert.deepEqual(rows[0].roots,['invented-root']);assert.ok(!JSON.stringify([rows,events]).includes('PRIVATE_'));assert.ok(!JSON.stringify(events).includes('verified@example.test'));
 }finally{await app.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
