import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const password='invented-password-123';
test('trusted public callback pinning, browser account-switch revocation, CSRF, owner isolation and protected-store/config failure',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.local/shared-google/boundary-')),key=randomBytes(32);let calls=0;const verifiers:string[]=[];
 const origin='https://spindle.berlayar.ai';
 const http:typeof fetch=async(input,init)=>{calls++;if(String(input).includes('/token')){const fields=new URLSearchParams(init?.body as URLSearchParams);assert.equal(fields.get('redirect_uri'),origin+'/oauth/callback');verifiers.push(fields.get('code_verifier')!);return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:[scopes.mail,scopes.drive].join(' ')});}return Response.json({emailAddress:'invented@example.test'});};
 const server=await startTrackingServer(dir,key,0,origin,{clientId:'invented',clientSecret:'INVENTED_SECRET',http});
 try{
  // Real loopback backend, pinned public Host/Origin; no DNS or public network used.
  const transport:typeof fetch=async(input,init)=>{const headers=new Headers(init?.headers);headers.set('Host',new URL(origin).host);return new Promise<Response>((resolve,reject)=>{
   import('node:http').then(({request})=>{const req=request(server.listenOrigin+new URL(String(input)).pathname+new URL(String(input)).search,{method:init?.method,headers:Object.fromEntries(headers)},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers as Record<string,string>})));});req.on('error',reject);req.end(init?.body as string|undefined);}).catch(reject);
  });};
  const a=new AccountClient(origin,transport),other=new AccountClient(origin,transport);await a.signin('invented-owner',password,true);await other.signin('invented-other',password,true);
  const flow=await a.connectGoogle(),u=new URL(flow.authorizationUrl);assert.equal(u.searchParams.get('redirect_uri'),origin+'/oauth/callback');
  const callback=origin+'/oauth/callback?'+new URLSearchParams({state:u.searchParams.get('state')!,code:'invented-code'});const response=await transport(callback,{headers:{'X-Forwarded-Host':'evil.test','X-Forwarded-Proto':'http'}});assert.equal(response.status,200);assert.equal(calls,2);
  assert.equal((await other.googleConnections()).connections.length,0);
  for(const op of [()=>other.connectGoogle(flow.connectionId),()=>other.selectGoogleRoots(flow.connectionId,['root']),()=>other.disconnectGoogle(flow.connectionId),()=>other.listGoogleDrive(flow.connectionId,'root','root')])await assert.rejects(op,/404/);
  const auth=await transport(origin+'/signin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-owner',password})});const cookie=auth.headers.get('set-cookie')!.split(';')[0],csrf=(await auth.json()).csrf;
  const denied=await transport(origin+'/google/begin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(denied.status,403);
  const begun=await transport(origin+'/google/begin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:'{}'});const pending=await begun.json(),pendingUrl=new URL(pending.authorizationUrl);
  // Actual browser-style signin replaces the cookie, even without AccountClient's explicit signout.
  await transport(origin+'/signin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({name:'invented-other',password})});
  const oldCallback=await transport(origin+'/oauth/callback?'+new URLSearchParams({state:pendingUrl.searchParams.get('state')!,code:'invented-code'}));assert.notEqual(oldCallback.status,200);assert.equal(calls,2);
  const publicText=JSON.stringify(await a.googleConnections());for(const v of [...verifiers,'INVENTED_SECRET','INVENTED_ACCESS','INVENTED_REFRESH'])assert.ok(!publicText.includes(v));
 }finally{await server.close();}
 await assert.rejects(startTrackingServer(dir,randomBytes(32),0),/./);
 await assert.rejects(startTrackingServer(dir,Buffer.alloc(0),0),/KEY_UNAVAILABLE/);
 await assert.rejects(startTrackingServer(dir,key,0,undefined,{clientId:'invented',clientSecret:''}),/GOOGLE_WEB_CONFIG_REQUIRED/);
 assert.deepEqual(await readdir(dir),['tracking.enc']);
 const noGoogle=await startTrackingServer(dir,key);try{const a=new AccountClient(noGoogle.origin);await a.signin('invented-owner',password);await assert.rejects(a.googleConnections(),/503/);}finally{await noGoogle.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
