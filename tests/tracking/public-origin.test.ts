import {request} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
// Node fetch rewrites Host; use the actual HTTP transport a trusted proxy uses.
const raw=(url:string,options:{method?:string;headers:Record<string,string>;body?:string})=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;data:Record<string,unknown>}>((resolve,reject)=>{
 const r=request(url,options,response=>{const chunks:Buffer[]=[];response.on('data',c=>chunks.push(c));response.on('end',()=>{try{resolve({status:response.statusCode!,headers:response.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});response.on('error',reject);});r.on('error',reject);r.end(options.body);
});
test('explicit HTTPS public origin keeps listener private and requires exact Host/Origin without forwarded-header trust',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/public-origin-')),publicOrigin='https://tracker.invented.example',server=await startTrackingServer(dir,randomBytes(32),0,publicOrigin);
 try{
  assert.equal(server.origin,publicOrigin);assert.match(server.listenOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
  const signed=await raw(server.listenOrigin+'/register',{method:'POST',headers:{Host:new URL(publicOrigin).host,Origin:publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-https',password:'invented-password-123'})});assert.equal(signed.status,200);
  const set=signed.headers['set-cookie']![0]!;assert.match(set,/(?:; )Secure(?:;|$)/);assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);const cookie=set.split(';')[0]!,csrf=signed.data.csrf as string;
  const read=(headers:Record<string,string>)=>raw(server.listenOrigin+'/session',{headers:{Cookie:cookie,...headers}});
  assert.equal((await read({Host:new URL(publicOrigin).host})).status,200);
  assert.equal((await read({'X-Forwarded-Host':new URL(publicOrigin).host,'X-Forwarded-Proto':'https'})).status,403);
  assert.equal((await read({Host:new URL(publicOrigin).host,Origin:'https://foreign.invented.example','Forwarded':'host=tracker.invented.example;proto=https'})).status,403);
  const mutate=(origin?:string,token?:string)=>raw(server.listenOrigin+'/processing',{method:'POST',headers:{Host:new URL(publicOrigin).host,Cookie:cookie,'Content-Type':'application/json','X-Forwarded-Proto':'https',...(origin?{Origin:origin}:{}),...(token?{'X-CSRF-Token':token}:{})},body:'{"local":true}'});
  assert.equal((await mutate(undefined,csrf)).status,403);assert.equal((await mutate(publicOrigin)).status,403);assert.equal((await mutate(publicOrigin,csrf)).status,200);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('public-origin misconfiguration fails before creating store/lock or accepting requests',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/public-origin-invalid-'));
 try{for(const [i,origin] of ['http://tracker.invented.example','https://user:invented@tracker.invented.example','https://tracker.invented.example/path','https://tracker.invented.example/','https://*.invented.example','https://tracker.invented.example?x=1','null'].entries()){
  const path=join(dir,String(i));let unexpectedlyStarted:Awaited<ReturnType<typeof startTrackingServer>>|undefined;
  try{await assert.rejects(async()=>{unexpectedlyStarted=await startTrackingServer(path,randomBytes(32),0,origin);},/PUBLIC_HTTPS_ORIGIN_REQUIRED/);}finally{await unexpectedlyStarted?.close();}
  await assert.rejects(access(path),{code:'ENOENT'});
 }}finally{await rm(dir,{recursive:true,force:true});}
});
