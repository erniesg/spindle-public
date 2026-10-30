import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request,createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {startDesktopWorkOSLogin} from '../../core/account/workos-desktop.js';

const clientId='client_invented123';
function get(uri:string,path?:string,headers:Record<string,string>={},method='GET'):Promise<{status:number;body:string}>{
 const url=new URL(uri);
 return new Promise((resolve,reject)=>{
  const req=request({hostname:url.hostname,port:url.port,path:path??url.pathname+url.search,method,headers:{Connection:'close',...headers}},res=>{
   let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode!,body}));
  });req.on('error',reject);req.end();
 });
}
test('desktop authorization binds ephemeral IPv4 loopback and returns matching PKCE verifier exactly once',async()=>{
 const attempt=await startDesktopWorkOSLogin(clientId),url=new URL(attempt.authorizationUrl),redirect=url.searchParams.get('redirect_uri')!;
 try{
  assert.equal(url.origin+url.pathname,'https://api.workos.com/user_management/authorize');
  assert.equal(url.searchParams.get('provider'),'authkit');assert.equal(url.searchParams.get('response_type'),'code');assert.equal(url.searchParams.get('client_id'),clientId);
  assert.equal(new URL(redirect).hostname,'127.0.0.1');assert.notEqual(new URL(redirect).port,'0');assert.equal(new URL(redirect).pathname,'/auth/callback');
  assert.match(url.searchParams.get('state')!,/^[A-Za-z0-9_-]{43}$/);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const response=await get(redirect,`/auth/callback?state=${url.searchParams.get('state')}&code=invented-code`);
  assert.equal(response.status,200);assert.ok(!response.body.includes('invented-code'));
  const result=await attempt.callback;assert.equal(result.code,'invented-code');assert.equal(result.redirectUri,redirect);assert.match(result.codeVerifier,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(result.codeVerifier).digest('base64url'),url.searchParams.get('code_challenge'));
  await assert.rejects(get(redirect));
 }finally{await attempt.cancel();}
});
test('invalid callbacks never consume the valid attempt and never reflect their inputs',async()=>{
 const attempt=await startDesktopWorkOSLogin(clientId),url=new URL(attempt.authorizationUrl),redirect=url.searchParams.get('redirect_uri')!,state=url.searchParams.get('state')!;
 try{
  for(const [path,headers,method] of [
   [`/auth/callback?state=wrong&code=secret`,{},'GET'],
   [`/auth/callback?state=${state}&code=secret#fragment`,{},'GET'],
   [`/auth/callback?state=${state}&code=${"s".repeat(8200)}`,{},'GET'],
   [`/auth/callback?state=${encodeURIComponent("é".repeat(43))}&code=secret`,{},'GET'],
   [`/auth/callback?state=${state}&state=${state}&code=secret`,{},'GET'],
   [`/auth/callback?state=${state}&code=secret&code=other`,{},'GET'],
   [`/auth/callback?state=${state}&code=secret&error=denied`,{},'GET'],
   [`/auth/callback?state=${state}&code=secret&unknown=x`,{},'GET'],
   [`/auth/callback?state=${state}&code=secret`,{Host:'evil.example'},'GET'],
   [`/auth/callback?state=${state}&code=secret`,{Origin:'https://evil.example'},'GET'],
   [`/auth/callback?state=${state}&code=secret`,{},'POST'],
   [`/auth/%63allback?state=${state}&code=secret`,{},'GET'],
   [`/x/../auth/callback?state=${state}&code=secret`,{},'GET'],
   [`http://evil.example/auth/callback?state=${state}&code=secret`,{},'GET'],
   [`/auth/callback?state=${state}&code=${'s'.repeat(4097)}`,{},'GET'],
  ] as [string,Record<string,string>,string][]){
   const response=await get(redirect,path,headers,method);assert.equal(response.status,400,path.slice(0,100));assert.ok(!response.body.includes('secret'));
  }
  assert.equal((await get(redirect,`/auth/callback?state=${state}&code=valid`)).status,200);assert.equal((await attempt.callback).code,'valid');
 }finally{await attempt.cancel();}
});
test('provider failure is bounded, consumed and reported without reflected error details',async()=>{
 const attempt=await startDesktopWorkOSLogin(clientId),url=new URL(attempt.authorizationUrl),redirect=url.searchParams.get('redirect_uri')!,state=url.searchParams.get('state')!;
 const rejected=assert.rejects(attempt.callback,/WORKOS_DESKTOP_AUTH_FAILED/);
 try{
  assert.equal((await get(redirect,`/auth/callback?state=${state}&error=${'x'.repeat(129)}`)).status,400);
  const response=await get(redirect,`/auth/callback?state=${state}&error=access_denied&error_description=secret`);
  assert.equal(response.status,200);assert.ok(!response.body.includes('secret'));await rejected;await assert.rejects(get(redirect));
 }finally{await attempt.cancel();}
});
test('cancellation is idempotent and closes the callback listener',async()=>{
 const attempt=await startDesktopWorkOSLogin(clientId),redirect=new URL(attempt.authorizationUrl).searchParams.get('redirect_uri')!;
 const rejected=assert.rejects(attempt.callback,/WORKOS_DESKTOP_CANCELLED/);await attempt.cancel();await attempt.cancel();await rejected;await assert.rejects(get(redirect));
});
test('expiry rejects and closes the callback listener',async()=>{
 const attempt=await startDesktopWorkOSLogin(clientId,{attemptDurationMs:30}),redirect=new URL(attempt.authorizationUrl).searchParams.get('redirect_uri')!;
 await assert.rejects(attempt.callback,/WORKOS_DESKTOP_EXPIRED/);await assert.rejects(get(redirect));await attempt.cancel();
});
test('invalid public client configuration fails before opening a listener',async()=>{
 for(const invalid of ['', 'wrong', 'client_', 'client_a\n','client_a?x','client_a'.repeat(100)])await assert.rejects(startDesktopWorkOSLogin(invalid),/WORKOS_DESKTOP_CONFIG_INVALID/);
});

test('an explicitly registered callback port never falls back when occupied',async()=>{
 const occupied=createServer();await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));const address=occupied.address();assert.ok(address&&typeof address!=='string');
 try{await assert.rejects(startDesktopWorkOSLogin(clientId,{callbackPort:address.port}),/WORKOS_DESKTOP_LISTENER_FAILED/);}finally{await new Promise<void>(r=>occupied.close(()=>r()));}
});
test('accepted callback whose response closes before finish still rejects and closes its listener',async()=>{
 const {ServerResponse}=await import('node:http'),original=ServerResponse.prototype.end;
 const attempt=await startDesktopWorkOSLogin(clientId),url=new URL(attempt.authorizationUrl),redirect=url.searchParams.get('redirect_uri')!,state=url.searchParams.get('state')!;
 ServerResponse.prototype.end=function(this:import('node:http').ServerResponse,...args:Parameters<typeof original>){if(this.req.url?.includes('code=accepted-close')){this.destroy();return this;}return Reflect.apply(original,this,args);} as typeof original;
 try{
  await assert.rejects(get(redirect,`/auth/callback?state=${state}&code=accepted-close`));
  const outcome=await Promise.race([attempt.callback.then(()=> 'resolved',error=>String(error.message)),new Promise<string>(r=>setTimeout(()=>r('pending'),100))]);
  assert.equal(outcome,'WORKOS_DESKTOP_CALLBACK_FAILED');await assert.rejects(get(redirect));
 }finally{ServerResponse.prototype.end=original;await attempt.cancel();}
});
