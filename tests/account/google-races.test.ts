import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const password='invented-password-123';
const secret='INVENTED_SECRET_NEVER_PUBLIC',token='INVENTED_TOKEN_NEVER_PUBLIC',refresh='INVENTED_REFRESH_NEVER_PUBLIC';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(){
 const dir=await mkdtemp(join(process.cwd(),'.local/shared-google/races-')),key=randomBytes(32);
 let identity='first@example.test',grants=[scopes.mail,scopes.drive],holdPath='',gate=deferred(),arrived=deferred(),calls:string[]=[],revokeFails=false;
 const http:typeof fetch=async(input,init)=>{
  const u=new URL(String(input));calls.push(u.hostname+u.pathname);
  if(holdPath&&u.pathname===holdPath){holdPath='';arrived.resolve();await gate.promise;}
  if(u.pathname==='/token')return Response.json({access_token:token,refresh_token:refresh,scope:grants.join(' ')});
  if(u.pathname==='/revoke')return new Response('',{status:revokeFails?503:200});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:identity});
  if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',parents:[],version:'v1',trashed:false});
  if(u.pathname==='/drive/v3/files')return Response.json({files:[]});
  throw Error('Unexpected mocked path');
 };
 const server=await startTrackingServer(dir,key,0,undefined,{clientId:'invented-client',clientSecret:secret,http});
 const a=new AccountClient(server.origin),b=new AccountClient(server.origin);await a.signin('invented-owner',password,true);await b.signin('invented-owner',password);
 const begin=async(client=a,id?:string)=>{const f=await client.connectGoogle(id),auth=new URL(f.authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri')!);url.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();return {...f,url};};
 return {dir,key,server,a,b,begin,calls,setIdentity:(s:string)=>{identity=s;},setGrants:(s:string[])=>{grants=s;},revokeFails:()=>{revokeFails=true;},hold:(path:string)=>{holdPath=path;gate=deferred();arrived=deferred();return {arrived:arrived.promise,release:()=>gate.resolve()};},close:async()=>{gate.resolve();await server.close();await rm(dir,{recursive:true,force:true});key.fill(0);}};
}
for(const stage of ['/token','/gmail/v1/users/me/profile'])test(`logout and account switch during deferred ${stage} deny credential commit`,async()=>{
 const f=await fixture();try{
  for(const switchAccount of [false,true]){
   const flow=await f.begin();const held=f.hold(stage);const callback=fetch(flow.url);await held.arrived;
   if(switchAccount)await f.a.signin('invented-other',password,true);else await f.a.signout();
   const callsAtLogout=f.calls.length;held.release();
   const result=await callback;assert.notEqual(result.status,200);const text=await result.text();assert.ok(!text.includes(token));
   assert.deepEqual(f.calls.slice(callsAtLogout),[],'no new provider HTTP dispatch after durable logout/switch (already dispatched work cannot be undone)');
   assert.ok((await f.b.googleConnections()).connections.every(c=>c.status!=='connected'));
   await f.a.signin('invented-owner',password);
  }
 }finally{await f.close();}
});
test('callback denial, replay and strict host/path/method preserve authenticated same-origin history reads',async()=>{
 const f=await fixture();try{
  const before=f.calls.length;
  for(const change of [(u:URL)=>{u.searchParams.set('error','access_denied');},(u:URL)=>{u.searchParams.append('state',u.searchParams.get('state')!);},(u:URL)=>{u.searchParams.append('code','second');},(u:URL)=>{u.searchParams.set('unexpected','x');}]){
   const flow=await f.begin();change(flow.url);assert.notEqual((await fetch(flow.url)).status,200);assert.notEqual((await fetch(flow.url)).status,200);
  }
  const expired=await f.begin(),now=Date.now;try{Date.now=()=>now()+300001;assert.notEqual((await fetch(expired.url)).status,200);}finally{Date.now=now;}
  assert.equal(f.calls.length,before);
  const flow=await f.begin();const wrongHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(flow.url,{headers:{Host:'wrong.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(wrongHost,403);assert.equal((await fetch(flow.url,{method:'POST'})).status,403);assert.equal((await fetch(flow.url,{headers:{Origin:f.server.origin}})).status,403);
  const unsigned=await fetch(f.server.origin+'/history');assert.equal(unsigned.status,401);assert.deepEqual(await unsigned.json(),{code:'SIGNIN_REQUIRED'});
  assert.equal((await fetch(f.server.origin+'/history',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.deepEqual((await f.a.request('/history')as any).entries,[]);
  assert.equal((await fetch(f.server.origin+'/connections')).status,200);assert.equal((await fetch(flow.url)).status,200);assert.notEqual((await fetch(flow.url)).status,200);
 }finally{await f.close();}
});
test('partial grants remain visible; reconnect refuses identity replacement; revocation uncertainty stops local use',async()=>{
 const f=await fixture();try{
  f.setGrants([scopes.mail]);const flow=await f.begin();assert.equal((await fetch(flow.url)).status,200);
  let c=(await f.b.googleConnections()).connections[0];assert.deepEqual(c.missingGrants,[scopes.drive,'https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive']);await f.a.selectGoogleRoots(c.id,['root']);
  const before=f.calls.length;await assert.rejects(f.b.listGoogleDrive(c.id,'root','root'));assert.equal(f.calls.length,before);
  f.setIdentity('replacement@example.test');const reconnect=await f.begin(f.b,c.id);assert.notEqual((await fetch(reconnect.url)).status,200);c=(await f.a.googleConnections()).connections[0];assert.equal(c.accountId,'first@example.test');
  f.revokeFails();assert.equal((await f.b.disconnectGoogle(c.id)).revocation,'uncertain');await assert.rejects(f.a.listGoogleDrive(c.id,'root','root'));assert.equal((await f.a.googleConnections()).connections[0].status,'disconnected');
 }finally{await f.close();}
});
test('stale initial CAS(undefined) cannot resurrect after disconnect/reconnect; late revoke cannot delete a newer epoch',async()=>{
 const f=await fixture();try{
  const first=await f.begin(),held=f.hold('/token'),old=fetch(first.url);await held.arrived;await f.b.disconnectGoogle(first.connectionId);
  const next=await f.begin(f.b,first.connectionId);assert.equal((await fetch(next.url)).status,200);held.release();assert.notEqual((await old).status,200);
  const revoke=f.hold('/revoke'),disconnect=f.a.disconnectGoogle(first.connectionId);await revoke.arrived;
  const newer=await f.begin(f.b,first.connectionId);assert.equal((await fetch(newer.url)).status,200);revoke.release();await disconnect;
  assert.equal((await f.b.googleConnections()).connections[0].status,'connected');
  const raw=await readFile(join(f.dir,'tracking.enc'));for(const s of [secret,token,refresh,'first@example.test'])assert.ok(!raw.includes(Buffer.from(s)));
 }finally{await f.close();}
});
test('selected root changes while refresh is deferred stop Drive I/O, not only the final reply',async()=>{
 const f=await fixture();try{
  const flow=await f.begin();await fetch(flow.url);await f.a.selectGoogleRoots(flow.connectionId,['root']);
  const held=f.hold('/token'),read=f.b.listGoogleDrive(flow.connectionId,'root','root');const rejected=assert.rejects(read);await held.arrived;await f.a.selectGoogleRoots(flow.connectionId,[]);held.release();await rejected;
  assert.equal(f.calls.filter(c=>c.startsWith('www.googleapis.com')).length,0);
 }finally{await f.close();}
});
test('roots changed after Drive I/O and refresh/disconnect/reconnect late writes deny result without restoring credentials',async()=>{
 const f=await fixture();try{
  const flow=await f.begin();await fetch(flow.url);await f.a.selectGoogleRoots(flow.connectionId,['root']);
  const held=f.hold('/drive/v3/files'),read=f.b.listGoogleDrive(flow.connectionId,'root','root'),rejected=assert.rejects(read);await held.arrived;await f.a.selectGoogleRoots(flow.connectionId,[]);held.release();await rejected;
  await f.a.selectGoogleRoots(flow.connectionId,['root']);const refreshHold=f.hold('/token'),late=f.a.listGoogleDrive(flow.connectionId,'root','root'),lateDenied=assert.rejects(late);await refreshHold.arrived;
  await f.b.disconnectGoogle(flow.connectionId);const reconnect=await f.begin(f.b,flow.connectionId);await fetch(reconnect.url);refreshHold.release();await lateDenied;assert.equal((await f.a.googleConnections()).connections[0].status,'connected');
 }finally{await f.close();}
});
