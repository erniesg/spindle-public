import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';

test('viewer cookie session needs no collector; Origin-free reads retain foreign-origin, fetch-site and CSRF denial',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracker-viewer-')),server=await startTrackingServer(dir,randomBytes(32));
 try{
  const signed=await fetch(server.origin+'/register',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-viewer',password:'invented-password-123'})});
  assert.equal(signed.status,200);const cookie=signed.headers.get('set-cookie')!.split(';')[0]!,csrf=(await signed.json() as {csrf:string}).csrf;
  const read=(path:string,headers:Record<string,string>={})=>fetch(server.origin+path,{headers:{Cookie:'invented_ui=sample; '+cookie,...headers}});
  const session=await read('/session');assert.equal(session.status,200);const restored=await session.json() as {account:{id:string}};assert.match(restored.account.id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);assert.deepEqual(restored,{account:{id:restored.account.id,name:'invented-viewer'},csrf,deviceId:null});
  assert.deepEqual(await(await read('/devices')).json(),{devices:[]});
  assert.deepEqual(await(await read('/history')).json(),{entries:[],cursor:0,hasMore:false});
  assert.equal((await read('/history',{Origin:'http://foreign.example'})).status,403);
  for(const site of ['cross-site','same-site'])assert.equal((await read('/history',{'Sec-Fetch-Site':site})).status,403);
  assert.equal((await read('/history',{'Sec-Fetch-Site':'same-origin'})).status,200);
  assert.equal((await read('/session',{Cookie:cookie+'; '+cookie})).status,401,'ambiguous duplicate session cookie rejected');
  const mutate=(path:string,body:unknown,token?:string)=>fetch(server.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:server.origin,'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},body:JSON.stringify(body)});
  assert.equal((await mutate('/processing',{local:true})).status,403);
  assert.equal((await mutate('/processing',{local:true},csrf)).status,200);
  assert.equal((await mutate('/sync',{operations:[{id:'invented-delete',deviceId:'foreign',recordingId:'recording',visitId:'visit',delete:true}]},csrf)).status,403);
  assert.equal((await mutate('/logout',{},csrf)).status,200);assert.equal((await read('/history')).status,401);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
