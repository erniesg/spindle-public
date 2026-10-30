import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {startTrackingServer} from '../../core/tracking/server.js';

test('timer browser bootstrap is read-only and cannot bypass Host/Origin/CSRF or select another account',async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/pomodoro-auth-'));
 const server=await startTrackingServer(directory,randomBytes(32));
 try{
  const auth=await fetch(server.origin+'/register',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-auth','password':'invented-only-password'})});
  assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie')!.split(';')[0]!;await auth.body?.cancel();
  async function request(path:string,headers:Record<string,string>={},data:unknown={}){
   const r=await fetch(server.origin+path,{method:'POST',headers:{Origin:server.origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
   const value=await r.json() as {csrf?:string;account?:{id:string};code?:string};return {status:r.status,value};
  }
  const session=await request('/pomodoro/session');assert.equal(session.status,200);assert.ok(session.value.account?.id);assert.match(session.value.csrf!,/^[a-f0-9]{64}$/);
  assert.equal((await request('/pomodoro/session',{Origin:'https://other.example'})).status,403);
  assert.equal((await request('/pomodoro/session',{Origin:''})).status,403);
  // Node fetch may replace forbidden Host; use raw HTTP to prove the actual wire header.
  const wrongHost=await new Promise<number>((resolve,reject)=>{const req=httpRequest(server.origin+'/pomodoro/session',{method:'POST',headers:{Host:'other.example',Origin:server.origin,Cookie:cookie,'Content-Type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end('{}');});
  assert.equal(wrongHost,403);
  assert.equal((await request('/pomodoro/session',{Cookie:''})).status,401);
  assert.equal((await request('/pomodoro/session?accountId=other')).status,400);
  assert.equal((await request('/pomodoro/session',{}, {action:'reset'})).status,400);
  assert.equal((await request('/pomodoro/read')).status,403);
  assert.equal((await request('/pomodoro/command',{}, {id:'no-csrf',expectedRevision:0,action:'start'})).status,403);
  const csrf={'X-CSRF-Token':session.value.csrf!};
  assert.equal((await request('/pomodoro/read',csrf)).status,200);
  assert.equal((await request('/pomodoro/read',csrf,{accountId:'other'})).status,400);
  assert.equal((await request('/pomodoro/command',csrf,{id:'spoof',expectedRevision:0,action:'start',accountId:'other'})).status,400);
  assert.equal((await request('/pomodoro/command?accountId=other',csrf,{id:'spoof',expectedRevision:0,action:'start'})).status,400);
  // The new CSRF exemption cannot be reused on any existing mutating route.
  for(const path of ['/logout','/devices','/user-memory/sync','/sync'])assert.equal((await request(path)).status,403);
  const asset=await fetch(server.origin+'/pomodoro/app/');assert.equal(asset.status,200);assert.match(asset.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(await asset.text(),/<main id="pomodoro">/);
  // The composed74 account viewer allows same-origin Origin-free GETs, not
  // unauthenticated reads or foreign fetch sites. POST/CSRF guards above stay.
  const privateRead=await fetch(server.origin+'/pomodoro',{headers:{Cookie:cookie}});assert.equal(privateRead.status,200);assert.equal((await privateRead.json() as {accountId:string}).accountId,session.value.account!.id);
  const foreignRead=await fetch(server.origin+'/pomodoro',{headers:{Cookie:cookie,'Sec-Fetch-Site':'same-site'}});assert.equal(foreignRead.status,403);await foreignRead.body?.cancel();
  const anonymousRead=await fetch(server.origin+'/pomodoro');assert.equal(anonymousRead.status,401);await anonymousRead.body?.cancel();
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
